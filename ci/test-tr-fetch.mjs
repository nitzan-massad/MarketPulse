// Self-check for ci/tr-fetch.mjs. Run: node ci/test-tr-fetch.mjs  (no network: fetch is stubbed)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockedError, FLARE_TIMEOUT_MS, getText, health, isBlocked, makeBreaker, stepDeadline } from "./tr-fetch.mjs";

const BLOCK_MSG = "Error solving the challenge. Cloudflare has blocked this request. Probably your IP is banned for this site";
assert.equal(isBlocked(BLOCK_MSG), true);
assert.equal(isBlocked("<title>Just a moment...</title>"), false, "a challenge is not a block");
assert.equal(isBlocked("error code: 1020"), true);
assert.equal(isBlocked("<h1>Sorry, you have been blocked</h1>"), true);

const b = makeBreaker(3);
b.record(true); b.record(true);
assert.equal(b.open(), false, "2 blocks: closed");
b.record(true);
assert.equal(b.open(), true, "3 blocks: open");
const b2 = makeBreaker(3);
b2.record(true); b2.record(true); b2.record(false); b2.record(true); b2.record(true);
assert.equal(b2.open(), false, "success resets the count");

const realFetch = globalThis.fetch;
const flareReply = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
try {
  // blocked -> BlockedError after exactly 1 call, recorded on the breaker
  let calls = 0;
  globalThis.fetch = async () => { calls++; return flareReply({ status: "error", message: BLOCK_MSG }); };
  const br = makeBreaker(3);
  await assert.rejects(getText("https://x/y", { plain: false, breaker: br, sleepMs: 0 }), BlockedError);
  assert.equal(calls, 1, "a block is never retried");
  await assert.rejects(getText("https://x/y", { plain: false, breaker: br, sleepMs: 0 }), BlockedError);
  await assert.rejects(getText("https://x/y", { plain: false, breaker: br, sleepMs: 0 }), BlockedError);
  assert.equal(br.open(), true);
  calls = 0;
  await assert.rejects(getText("https://x/y", { plain: false, breaker: br }), BlockedError);
  assert.equal(calls, 0, "an open breaker makes no request");

  // ok() retries once on "y", resolves on "x"
  const bodies = ["y", "x"];
  calls = 0;
  globalThis.fetch = async () => { calls++; return flareReply({ status: "ok", solution: { response: bodies.shift() } }); };
  const out = await getText("https://x/y", { plain: false, ok: (s) => s.includes("x"), sleepMs: 0 });
  assert.equal(out, "x");
  assert.equal(calls, 2);

  // timeoutMs sets the plain-fetch AbortSignal timeout (default 30s)
  const realTimeout = AbortSignal.timeout, timeouts = [];
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout.call(AbortSignal, ms); };
  try {
    globalThis.fetch = async () => ({ status: 200, text: async () => "ok" });
    await getText("https://x/t");
    await getText("https://x/t", { timeoutMs: 120_000 });
  } finally { AbortSignal.timeout = realTimeout; }
  assert.deepEqual(timeouts, [30_000, 120_000], "default 30s, custom value honoured");

  // plain 200 wins without touching FlareSolverr; plain 403 falls through to it
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return { status: 200, text: async () => "plain" }; };
  assert.equal(await getText("https://x/p", { flareUrl: "http://fs/v1" }), "plain");
  assert.deepEqual(urls, ["https://x/p"]);
  urls.length = 0;
  globalThis.fetch = async (u, o) => {
    urls.push(u);
    return u === "https://x/p" ? { status: 403, text: async () => "forbidden" } : flareReply({ status: "ok", solution: { response: "via flare" } });
  };
  assert.equal(await getText("https://x/p", { flareUrl: "http://fs/v1" }), "via flare");
  assert.deepEqual(urls, ["https://x/p", "http://fs/v1"]);

  // plain fetch blocked -> FlareSolverr is still tried; success there leaves the breaker closed
  {
    const seen = [];
    const br3 = makeBreaker(1);
    globalThis.fetch = async (u) => {
      seen.push(u);
      return u === "https://x/b" ? { status: 403, text: async () => "Sorry, you have been blocked" } : flareReply({ status: "ok", solution: { response: "ok body" } });
    };
    assert.equal(await getText("https://x/b", { flareUrl: "http://fs/v1", breaker: br3 }), "ok body");
    assert.deepEqual(seen, ["https://x/b", "http://fs/v1"], "plain block falls through to FlareSolverr");
    assert.equal(br3.open(), false, "a plain block is not recorded on the breaker");
  }
  // a block inside FlareSolverr's solution.response body is fatal
  {
    let n = 0;
    globalThis.fetch = async () => { n++; return flareReply({ status: "ok", solution: { response: "<h1>Sorry, you have been blocked</h1>" } }); };
    await assert.rejects(getText("https://x/y", { plain: false, sleepMs: 0 }), BlockedError);
    assert.equal(n, 1, "no retry");
  }
  // deadline: a FlareSolverr retry never starts past it; a deadline already passed makes no FlareSolverr call
  {
    let n = 0;
    globalThis.fetch = async () => { n++; return flareReply({ status: "error", message: "timeout" }); };
    await assert.rejects(getText("https://x/d", { plain: false, tries: 5, sleepMs: 0, deadline: Date.now() - 1 }), /deadline/);
    assert.equal(n, 0, "past the deadline: no FlareSolverr call");
    globalThis.fetch = async () => { n++; await new Promise((r) => setTimeout(r, 30)); return flareReply({ status: "error", message: "slow" }); };
    await assert.rejects(getText("https://x/d", { plain: false, tries: 8, sleepMs: 0, deadline: Date.now() + 10 }), /slow/);
    assert.equal(n, 1, "the in-flight try finishes, no retry starts after the deadline");
  }
  // the FlareSolverr POST carries an AbortSignal timeout longer than its 60s maxTimeout
  {
    let sig;
    globalThis.fetch = async (u, o) => { sig = o?.signal; return flareReply({ status: "ok", solution: { response: "b" } }); };
    const realTimeout = AbortSignal.timeout, asked = [];
    AbortSignal.timeout = (ms) => { asked.push(ms); return realTimeout.call(AbortSignal, ms); };
    try { assert.equal(await getText("https://x/f", { plain: false }), "b"); } finally { AbortSignal.timeout = realTimeout; }
    assert.ok(sig instanceof AbortSignal, "FlareSolverr POST has a signal");
    assert.deepEqual(asked, [FLARE_TIMEOUT_MS]);
    assert.ok(FLARE_TIMEOUT_MS > 60_000);
  }
} finally { globalThis.fetch = realFetch; }

// Wall-clock bounds against a real local server (node:http, real fetch, no external network).
// /stall and /v1 send headers plus part of a body, then never finish it; /v1-err answers at once.
{
  const http = await import("node:http");
  const srv = http.createServer((req, res) => {
    if (req.url === "/v1-err") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"error","message":"fs down"}'); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.write(req.url === "/v1" ? '{"status":"ok","solution":{"response":"' : "x".repeat(1000)); // then stall
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  // settle within `ms` or report how long it was still running (a regression must not hang the suite)
  const timed = async (p, ms) => {
    const t0 = Date.now();
    let t;
    const guard = new Promise((r) => { t = setTimeout(() => r({ hung: true }), ms); });
    const out = await Promise.race([p.then((v) => ({ v }), (e) => ({ e })), guard]);
    clearTimeout(t);
    return { ...out, ms: Date.now() - t0 };
  };
  try {
    // plain body stalls mid-read: timeoutMs covers the body, then FlareSolverr gets its turn
    let r = await timed(getText(`${base}/stall`, { flareUrl: `${base}/v1-err`, tries: 1, timeoutMs: 300 }), 3000);
    assert.ok(!r.hung, `stalled plain body must give up near timeoutMs, still running after ${r.ms}ms`);
    assert.match(String(r.e?.message), /fs down/);
    assert.ok(r.ms < 1500, `plain stall bounded by timeoutMs (took ${r.ms}ms)`);

    // deadline bounds the whole call: an in-flight plain read (timeoutMs 30s) and an in-flight
    // FlareSolverr read (90s) are both cut at the deadline, body included
    r = await timed(getText(`${base}/stall`, { flareUrl: `${base}/v1`, tries: 3, sleepMs: 0, deadline: Date.now() + 400 }), 5000);
    assert.ok(!r.hung, `deadline must cut in-flight reads, still running after ${r.ms}ms`);
    assert.ok(r.e, "a stalled call past the deadline throws");
    assert.ok(r.ms < 1500, `whole call bounded by deadline (took ${r.ms}ms)`);

    // plain answers fine, FlareSolverr is never needed — FlareSolverr body stall alone, cut at the deadline
    r = await timed(getText("https://unused.invalid/", { plain: false, flareUrl: `${base}/v1`, tries: 2, sleepMs: 0, deadline: Date.now() + 300 }), 5000);
    assert.ok(!r.hung && r.ms < 1500, `FlareSolverr body stall bounded by deadline (took ${r.ms}ms, hung=${!!r.hung})`);

    // a retry sleep does not run past the deadline either
    r = await timed(getText("https://unused.invalid/", { plain: false, flareUrl: `${base}/v1-err`, tries: 3, sleepMs: 5000, deadline: Date.now() + 300 }), 8000);
    assert.ok(r.ms < 1500, `retry sleep capped at the deadline (took ${r.ms}ms)`);
    assert.match(String(r.e?.message), /fs down/);

    // past the deadline: no request at all, not even the plain one
    let hits = 0;
    srv.on("request", () => { hits++; });
    r = await timed(getText(`${base}/stall`, { flareUrl: `${base}/v1`, deadline: Date.now() - 1 }), 3000);
    assert.match(String(r.e?.message), /deadline/);
    assert.equal(hits, 0, "past the deadline: no plain fetch either");
  } finally { srv.closeAllConnections(); srv.close(); }
}

// stepDeadline: pure clock arithmetic
{
  const d = stepDeadline(1000, 5000);
  assert.equal(d.at, 6000);
  assert.equal(d.passed(5999), false);
  assert.equal(d.passed(6000), true);
}

const dir = mkdtempSync(join(tmpdir(), "health-"));
const prev = process.env.RUNNER_TEMP;
process.env.RUNNER_TEMP = dir;
health("a");
assert.equal(readFileSync(join(dir, "health"), "utf8"), "a\n");
delete process.env.RUNNER_TEMP;
health("ignored"); // no-op without RUNNER_TEMP
if (prev) process.env.RUNNER_TEMP = prev;
console.log("tr-fetch: all checks passed");
