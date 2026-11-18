// Self-check for ci/tr-fetch.mjs. Run: node ci/test-tr-fetch.mjs  (no network: fetch is stubbed)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockedError, getText, health, isBlocked, makeBreaker } from "./tr-fetch.mjs";

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
} finally { globalThis.fetch = realFetch; }

const dir = mkdtempSync(join(tmpdir(), "health-"));
const prev = process.env.RUNNER_TEMP;
process.env.RUNNER_TEMP = dir;
health("a");
assert.equal(readFileSync(join(dir, "health"), "utf8"), "a\n");
delete process.env.RUNNER_TEMP;
health("ignored"); // no-op without RUNNER_TEMP
if (prev) process.env.RUNNER_TEMP = prev;
console.log("tr-fetch: all checks passed");
