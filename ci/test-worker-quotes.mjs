// worker/index.js default export — /quotes (CNBC proxy + 20s shared cache), /live routing,
// and the track-dispatch POST. Run: node ci/test-worker-quotes.mjs
//
// The Worker is plain ESM with no Workers-only globals at import time, so it loads straight
// into Node: `fetch` (CNBC / GitHub) is stubbed per test and `Date.now` is driven by hand so
// the TTL can be walked to the millisecond. The module-level quote cache persists across
// cases in this process — every case uses its own symbols, or moves the clock past the TTL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { BROWSER_UA, CNBC_QUOTE } from "../worker/cnbc.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, "fixtures", "cnbc-quotes.json"), "utf8"));
const FIX_ROWS = Object.fromEntries(FIXTURE.FormattedQuoteResult.FormattedQuote.map((r) => [r.symbol, r]));

const ORIGIN = "https://nitzan-massad.github.io";
const liveCalls = [];
const env = {
  ORIGIN,
  GH_TOKEN: "gh-test-token",
  LIVE: {
    idFromName: (n) => `id:${n}`,
    get: (id) => ({
      fetch: async (req) => {
        liveCalls.push({ id, url: req.url });
        return new Response("relayed", { status: 200 });
      },
    }),
  },
};

// ---- harness ------------------------------------------------------------------------
let clock = Date.UTC(2026, 9, 22, 14, 0, 0);
Date.now = () => clock;

/** Every outbound fetch, and the handler that answers it. */
let calls = [];
let upstream = () => cnbcOk;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return upstream(String(url), init);
};
const symbolsOf = (url) => decodeURIComponent(url.slice(CNBC_QUOTE.length)).split("|");
const synthRow = (s) => ({
  symbol: s, code: 0, realTime: "true", currencyCode: "USD", last: "10.00", change: "+1.00",
  change_pct: "+11.11%", last_time: "2026-10-21", open: "0.00", high: "0.00", low: "0.00",
});
// Default CNBC: fixture rows where we have them, a synthetic row otherwise; a symbol listed in
// `missing` is left out of the answer altogether, as CNBC does for some unknowns.
let missing = new Set();
function cnbcOk(url) {
  const rows = symbolsOf(url).filter((s) => !missing.has(s)).map((s) => FIX_ROWS[s] ?? synthRow(s));
  return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: rows } }), { status: 200 });
}

const call = (pathq, { method = "GET", origin = ORIGIN, headers = {} } = {}) =>
  worker.fetch(new Request(`https://w.example${pathq}`, { method, headers: { ...(origin ? { origin } : {}), ...headers } }), env);

let failed = 0;
let passed = 0;
async function t(label, fn) {
  clock += 60_000; // past the 20s TTL: no cached quote or remembered CNBC failure leaks between cases
  calls = [];
  upstream = cnbcOk;
  missing = new Set();
  try {
    await fn();
    passed++;
    console.log(`ok   ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}: ${e?.message ?? e}`);
  }
}
let n = 0;
/** n fresh, valid, never-before-used symbols (Q + base36 counter). */
const fresh = (k) => Array.from({ length: k }, () => `Q${(n++).toString(36).toUpperCase()}`);

// ---- CORS / method / validation ---------------------------------------------------------
await t("CORS: the site origin is echoed, with vary: origin", async () => {
  const r = await call("/quotes?symbols=AAPL");
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(r.headers.get("vary"), "origin");
  assert.equal(r.headers.get("content-type"), "application/json");
});
await t("CORS: any http://localhost:<port> is echoed (vite dev)", async () => {
  const r = await call("/quotes?symbols=AAPL", { origin: "http://localhost:5173" });
  assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const r2 = await call(`/quotes?symbols=${fresh(1)[0]}`, { origin: "http://127.0.0.1:5188" });
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get("access-control-allow-origin"), "http://127.0.0.1:5188");
});
await t("/quotes from a foreign or missing origin -> 403, no CNBC call (not a free proxy)", async () => {
  for (const o of ["https://evil.example", "http://localhost:5173.evil.example", "https://localhost:5173", "http://127.0.0.1.evil.example:80", ""]) {
    const r = await call("/quotes?symbols=AAPL", { origin: o });
    assert.equal(r.status, 403, JSON.stringify(o));
    assert.equal(r.headers.get("access-control-allow-origin"), null, JSON.stringify(o));
  }
  assert.equal(calls.length, 0);
});
await t("concurrent misses for the same symbols share ONE CNBC call", async () => {
  const s = fresh(3);
  const [a, b] = await Promise.all([call(`/quotes?symbols=${s.join(",")}`), call(`/quotes?symbols=${s.join(",")}`)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys((await b.json()).quotes), s);
});
await t("OPTIONS preflight: 2xx, allow GET, no upstream call", async () => {
  const r = await call("/quotes?symbols=AAPL", { method: "OPTIONS" });
  assert.ok(r.ok);
  assert.equal(r.headers.get("access-control-allow-methods"), "GET");
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(calls.length, 0);
});
await t("non-GET -> 405 with CORS headers", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const r = await call("/quotes?symbols=AAPL", { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  }
  assert.equal(calls.length, 0);
});
await t("bad symbols -> 400, CNBC never called", async () => {
  for (const q of ["", "?symbols=", "?symbols=AAPL,,MSFT", "?symbols=%5EGSPC", "?symbols=TOOLONGX", "?foo=AAPL"]) {
    const r = await call(`/quotes${q}`);
    assert.equal(r.status, 400, q);
    assert.deepEqual(await r.json(), { error: "bad symbols" });
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  }
  assert.equal(calls.length, 0);
});
await t(">300 unique symbols -> 400; exactly 300 -> 200", async () => {
  const r1 = await call(`/quotes?symbols=${fresh(301).join(",")}`);
  assert.equal(r1.status, 400);
  assert.equal(calls.length, 0);
  const r2 = await call(`/quotes?symbols=${fresh(300).join(",")}`);
  assert.equal(r2.status, 200);
});

// ---- happy path on the real fixture ----------------------------------------------------------
clock += 3_600_000;
await t("200: parsed quotes keyed by normalized symbol; unknowns null", async () => {
  missing = new Set(["BRK.B"]);
  const r = await call("/quotes?symbols=aapl,LLY,GETY,LMFA,brk-b,SQNS");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.asOf, clock);
  assert.deepEqual(Object.keys(j.quotes), ["AAPL", "LLY", "GETY", "LMFA", "BRK.B", "SQNS"]);
  assert.equal(j.quotes.AAPL.px, 343.99);
  assert.equal(j.quotes.AAPL.pc, 339.5);
  assert.equal(j.quotes.LLY.px, 1270.75); // commas: never 1
  assert.equal(j.quotes.GETY, null); // realTime false
  assert.equal(j.quotes.LMFA, null); // code 1
  assert.equal(j.quotes["BRK.B"], null); // absent from CNBC's answer
  assert.equal(j.quotes.SQNS.pc, 2.42);
});
await t("upstream request: one CNBC call, '|'-joined, browser UA + json accept", async () => {
  missing = new Set();
  const s = fresh(2);
  await call("/quotes?symbols=BRK-B");
  calls = [];
  await call(`/quotes?symbols=${s.join(",")},BRK-B`);
  // BRK.B is cached by the call above; only the two new ones go out
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, CNBC_QUOTE + s.join("|"));
  assert.equal(calls[0].init.headers["user-agent"], BROWSER_UA);
  assert.equal(calls[0].init.headers.accept, "application/json");
});
await t("upstream request carries a timeout signal (a stalled CNBC fails, never hangs)", async () => {
  await call(`/quotes?symbols=${fresh(1)[0]}`);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].init.signal instanceof AbortSignal, "fetch must get an AbortSignal");
  assert.equal(calls[0].init.signal.aborted, false);
});
await t("a CNBC call that times out -> 502 and remembered (not a hung request)", async () => {
  upstream = () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const s = fresh(2);
  const r = await call(`/quotes?symbols=${s[0]}`);
  assert.equal(r.status, 502);
  upstream = cnbcOk;
  assert.equal((await call(`/quotes?symbols=${s[1]}`)).status, 502); // remembered for the TTL
  assert.equal(calls.length, 1);
});
await t("upstream URL: a dotted symbol is sent as BRK.B (CNBC's form)", async () => {
  clock += 60_000;
  await call("/quotes?symbols=BRK_B");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("symbols=BRK.B"), calls[0].url);
});

// ---- per-symbol 20s cache ---------------------------------------------------------------------
await t("cache: same symbols within 20s -> no CNBC call, same quotes", async () => {
  const s = fresh(3);
  const a = await (await call(`/quotes?symbols=${s.join(",")}`)).json();
  assert.equal(calls.length, 1);
  clock += 19_999;
  const b = await (await call(`/quotes?symbols=${s.join(",")}`)).json();
  assert.equal(calls.length, 1, "served from cache at +14.999s");
  assert.deepEqual(b.quotes, a.quotes);
  clock += 1; // exactly 20s after the fetch
  await call(`/quotes?symbols=${s.join(",")}`);
  assert.equal(calls.length, 2, "re-fetched at +20s");
});
await t("cache: a null (CNBC-unknown) answer is cached too — no re-ask for 20s", async () => {
  await call("/quotes?symbols=LMFA");
  const before = calls.length;
  await call("/quotes?symbols=LMFA");
  assert.equal(calls.length, before);
});
await t("cache: mixed request fetches only the stale symbols", async () => {
  const cached = fresh(2);
  await call(`/quotes?symbols=${cached.join(",")}`);
  calls = [];
  const neu = fresh(1);
  const j = await (await call(`/quotes?symbols=${[...cached, ...neu].join(",")}`)).json();
  assert.equal(calls.length, 1);
  assert.deepEqual(symbolsOf(calls[0].url), neu);
  assert.deepEqual(Object.keys(j.quotes), [...cached, ...neu]);
  for (const s of [...cached, ...neu]) assert.equal(j.quotes[s].px, 10);
});
await t("cache: shared across callers (a different origin hits the same cache)", async () => {
  const s = fresh(1);
  await call(`/quotes?symbols=${s[0]}`);
  await call(`/quotes?symbols=${s[0]}`, { origin: "http://localhost:5173" });
  assert.equal(calls.length, 1);
});

// ---- chunking -----------------------------------------------------------------------------------
await t("chunking: 250 stale symbols -> 3 CNBC calls of 100/100/50, in order", async () => {
  const s = fresh(250);
  const r = await call(`/quotes?symbols=${s.join(",")}`);
  assert.equal(r.status, 200);
  assert.deepEqual(calls.map((c) => symbolsOf(c.url).length), [100, 100, 50]);
  assert.deepEqual(calls.flatMap((c) => symbolsOf(c.url)), s);
  assert.equal(Object.keys((await r.json()).quotes).length, 250);
});
await t("chunking: exactly 100 -> one call", async () => {
  await call(`/quotes?symbols=${fresh(100).join(",")}`);
  assert.equal(calls.length, 1);
});

// ---- 502 ----------------------------------------------------------------------------------------
const assert502 = async (r) => {
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "upstream" });
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
};
await t("502: CNBC non-2xx (403 to a non-browser UA)", async () => {
  upstream = () => new Response("nope", { status: 403 });
  await assert502(await call(`/quotes?symbols=${fresh(1)[0]}`));
});
await t("502: CNBC non-2xx even with a valid quote body (429 + envelope)", async () => {
  upstream = () =>
    new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: [] } }), { status: 429 });
  await assert502(await call(`/quotes?symbols=${fresh(1)[0]}`));
});
await t("502: network error", async () => {
  upstream = () => {
    throw new TypeError("fetch failed");
  };
  await assert502(await call(`/quotes?symbols=${fresh(1)[0]}`));
});
await t("502: reshaped envelope (not 200 with every symbol null)", async () => {
  upstream = () => new Response(JSON.stringify({ QuoteResult: [] }), { status: 200 });
  await assert502(await call(`/quotes?symbols=${fresh(1)[0]}`));
});
await t("502: non-JSON body", async () => {
  upstream = () => new Response("<html>captcha</html>", { status: 200 });
  await assert502(await call(`/quotes?symbols=${fresh(1)[0]}`));
});
await t("a CNBC failure is remembered for the TTL (no retry storm), then CNBC is retried", async () => {
  const s = fresh(2);
  upstream = () => new Response("", { status: 500 });
  await assert502(await call(`/quotes?symbols=${s[0]}`));
  upstream = cnbcOk;
  clock += 19_999;
  await assert502(await call(`/quotes?symbols=${s[1]}`)); // inside the TTL: answered from memory
  assert.equal(calls.length, 1, "no second CNBC call inside the TTL");
  clock += 1;
  const r = await call(`/quotes?symbols=${s[0]}`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).quotes[s[0]].px, 10);
  assert.equal(calls.length, 2);
});
await t("502 on chunk 2: the whole answer is 502, and a retry inside the TTL makes no CNBC call", async () => {
  const s = fresh(150);
  let k = 0;
  upstream = (url) => (k++ === 0 ? cnbcOk(url) : new Response("", { status: 503 }));
  await assert502(await call(`/quotes?symbols=${s.join(",")}`));
  calls = [];
  upstream = cnbcOk;
  await assert502(await call(`/quotes?symbols=${s.join(",")}`));
  assert.equal(calls.length, 0);
});
await t("after a chunk failure, the next poll past the TTL fetches everything fresh", async () => {
  const s = fresh(150);
  let k = 0;
  upstream = (url) => (k++ === 0 ? cnbcOk(url) : new Response("", { status: 503 }));
  await assert502(await call(`/quotes?symbols=${s.join(",")}`));
  clock += 20_000;
  calls = [];
  upstream = cnbcOk;
  const r = await call(`/quotes?symbols=${s.join(",")}`);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(Object.keys((await r.json()).quotes).length, 150);
});

// The cache bound (QUOTE_CACHE_MAX) needs a cache of known size: ci/test-worker-cache-bound.mjs.

// ---- /live routing ------------------------------------------------------------------------------
await t("/live without Upgrade: websocket -> 426", async () => {
  const r = await call("/live");
  assert.equal(r.status, 426);
  assert.equal(liveCalls.length, 0);
});
await t("/live from a foreign origin -> 403 (the one Finnhub socket is ours)", async () => {
  const r = await call("/live", { origin: "https://evil.example", headers: { upgrade: "websocket" } });
  assert.equal(r.status, 403);
  const r2 = await call("/live", { origin: "", headers: { upgrade: "websocket" } });
  assert.equal(r2.status, 403);
  assert.equal(liveCalls.length, 0);
});
await t("/live from the site / localhost -> the single 'main' LiveRelay", async () => {
  for (const origin of [ORIGIN, "http://localhost:5173"]) {
    const r = await call("/live", { origin, headers: { upgrade: "websocket" } });
    assert.equal(await r.text(), "relayed");
  }
  assert.deepEqual(liveCalls.map((c) => c.id), ["id:main", "id:main"]);
  assert.equal(calls.length, 0);
});

// ---- track dispatch (unchanged path, guarded so the new routes didn't swallow it) -----------------
await t("dispatch: POST / -> GitHub workflow_dispatch, 204", async () => {
  upstream = () => new Response(null, { status: 204 });
  const r = await call("/", { method: "POST" });
  assert.equal(r.status, 204);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/actions\/workflows\/track-requests\.yml\/dispatches$/);
  assert.equal(calls[0].init.headers.authorization, "Bearer gh-test-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "main" });
});
await t("dispatch: GitHub failure -> 502; GET -> 405", async () => {
  upstream = () => new Response("", { status: 401 });
  assert.equal((await call("/", { method: "POST" })).status, 502);
  assert.equal((await call("/")).status, 405);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} worker /quotes check(s) failed`);
console.log("worker /quotes OK");
