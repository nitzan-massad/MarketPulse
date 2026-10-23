// worker/index.js /bars — the stock modal's chart endpoint, through the real `worker.fetch`:
// origin/CORS, validation (the client never chooses the window), per-range TTLs, the byte-bounded
// cache, coalescing, the 404 negative cache, the failure memory and the timeout.
// Run: node ci/test-worker-bars.mjs
//
// `fetch` (CNBC) is stubbed and `Date.now` driven by hand. Cases needing an empty cache import
// their own module instance (`?case=` = a distinct ESM instance).
import assert from "node:assert/strict";
import { BROWSER_UA } from "../worker/cnbc.js";
import { barsUrl, CNBC_BARS, RANGES } from "../worker/bars.js";

const ORIGIN = "https://nitzan-massad.github.io";
const env = { ORIGIN };
let clock = Date.parse("2026-10-22T16:59:00Z"); // Thu 12:59 ET
Date.now = () => clock;

// A CNBC-shaped body: one regular-hours bar per stamp. `n` bars on consecutive days.
const body = (n = 3, extra = "") => ({
  barData: {
    priceBars: Array.from({ length: n }, (_, i) => ({
      close: `${100 + i}${extra}`,
      volume: 1000 + i,
      tradeTime: `202610${String(10 + i).padStart(2, "0")}1000${"00"}`,
    })),
  },
});
const ok = (b = body()) => new Response(JSON.stringify(b), { status: 200 });
let calls = [];
let upstream = () => ok();
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return upstream(String(url), init);
};

let worker = (await import("../worker/index.js?case=main")).default;
const call = (q, { method = "GET", origin = ORIGIN } = {}) =>
  worker.fetch(new Request(`https://w.example/bars${q}`, { method, headers: origin ? { origin } : {} }), env);

let failed = 0;
let passed = 0;
async function t(label, fn, { fresh = false } = {}) {
  clock += 24 * 3600_000; // a new day per case: no TTL, negative cache or failure memory leaks across
  calls = [];
  upstream = () => ok();
  if (fresh) worker = (await import(`../worker/index.js?case=${encodeURIComponent(label)}`)).default;
  try {
    await fn();
    passed++;
    console.log(`ok   ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}: ${e?.message ?? e}`);
  }
}
const json = async (r) => JSON.parse(await r.text());

// ---- origin / method / validation -------------------------------------------------------------
await t("site and localhost origins are echoed with vary: origin", async () => {
  for (const o of [ORIGIN, "http://localhost:5173", "http://127.0.0.1:5188"]) {
    const r = await call("?symbol=AAPL&range=1M", { origin: o });
    assert.equal(r.status, 200, o);
    assert.equal(r.headers.get("access-control-allow-origin"), o);
    assert.equal(r.headers.get("vary"), "origin");
  }
});
await t("foreign / missing / look-alike origins -> 403, no CNBC call", async () => {
  for (const o of ["https://evil.example", "http://localhost:5173.evil.example", "https://localhost:5173", ""]) {
    const r = await call("?symbol=AAPL&range=1M", { origin: o });
    assert.equal(r.status, 403, JSON.stringify(o));
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(calls.length, 0);
});
await t("OPTIONS preflight 2xx (GET), other methods 405 with CORS, no CNBC call", async () => {
  const r = await call("?symbol=AAPL&range=1M", { method: "OPTIONS" });
  assert.ok(r.ok);
  assert.equal(r.headers.get("access-control-allow-methods"), "GET");
  for (const m of ["POST", "PUT", "DELETE"]) {
    const x = await call("?symbol=AAPL&range=1M", { method: m });
    assert.equal(x.status, 405, m);
    assert.equal(x.headers.get("access-control-allow-origin"), ORIGIN);
  }
  assert.equal(calls.length, 0);
});
await t("validation -> 400 with an exact body, no CNBC call", async () => {
  const cases = [
    ["?range=1M", "bad symbol"],
    ["?symbol=^GSPC&range=1M", "bad symbol"],
    ["?symbol=TOOLONGX&range=1M", "bad symbol"],
    ["?symbol=AAPL,MSFT&range=1M", "bad symbol"],
    ["?symbol=AAPL", "bad range"],
    ["?symbol=AAPL&range=1d", "bad range"],
    ["?symbol=AAPL&range=10Y", "bad range"],
    ["?symbol=AAPL&range=", "bad range"],
    ["?symbol=AAPL&range=toString", "bad range"],
    ["?symbol=AAPL&range=__proto__", "bad range"],
  ];
  for (const [q, err] of cases) {
    const r = await call(q);
    assert.equal(r.status, 400, q);
    assert.deepEqual(await json(r), { error: err }, q);
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN, q);
  }
  assert.equal(calls.length, 0);
});
await t("client start/end/interval params are ignored: the upstream URL is the server's", async () => {
  await call("?symbol=AAPL&range=1D&start=19700101000000&end=20991231000000&interval=1M");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, barsUrl("AAPL", "1D", clock));
});

// ---- upstream request + success shape --------------------------------------------------------
await t("upstream: exact URL, browser UA, a timeout signal", async () => {
  await call("?symbol=AAPL&range=1Y");
  assert.equal(calls[0].url, barsUrl("AAPL", "1Y", clock));
  assert.ok(calls[0].url.startsWith(CNBC_BARS));
  assert.equal(calls[0].init.headers["user-agent"], BROWSER_UA);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});
await t("BRK-B and brk_b -> BRK.B upstream; both share one cache entry", async () => {
  const a = await json(await call("?symbol=BRK-B&range=1M"));
  const b = await json(await call("?symbol=brk_b&range=1M"));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/BRK.B/"));
  assert.equal(a.s, "BRK.B");
  assert.deepEqual(a, b);
});
await t("success shape: s, r, i, asOf, parallel t/c; cache-control = the range TTL", async () => {
  const want = { "1D": 60, "1W": 300, "1M": 3600, "5Y": 3600, ALL: 21600, PE: 21600 };
  for (const [range, maxAge] of Object.entries(want)) {
    upstream = () => ok(body(3));
    const r = await call(`?symbol=AAPL&range=${range}`);
    assert.equal(r.status, 200, range);
    assert.equal(r.headers.get("cache-control"), `max-age=${maxAge}`, range);
    assert.equal(r.headers.get("content-type"), "application/json");
    const j = await json(r);
    assert.deepEqual(Object.keys(j).sort(), ["asOf", "c", "i", "r", "s", "t"], range);
    assert.equal(j.i, RANGES[range].int, range);
    assert.equal(j.t.length, j.c.length, range);
  }
});
await t("PE: adjusted + unadjusted fetched, closes split-only (a spin undone)", async () => {
  // weeks w1..w3 (Sundays), a 6.665x spin before the last week
  const wk = (closes) => ({
    barData: { priceBars: closes.map((c, i) => ({ close: String(c), volume: 1, tradeTime: `202609${String(13 + i * 7).padStart(2, "0")}000000` })) },
  });
  upstream = (url) => ok(url.includes("/unadjusted/") ? wk([80, 80, 12]) : wk([12, 12, 12]));
  const j = await json(await call("?symbol=CTVA&range=PE"));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.url.split("/").at(-2)).sort(), ["adjusted", "unadjusted"]);
  assert.deepEqual(j.t, ["2026-09-14", "2026-09-21", "2026-09-28"]);
  assert.deepEqual(j.c, [80, 80, 12]);
});

// ---- OHLC (a closed session's open/high/low) ---------------------------------------------------
const dayBars = { barData: { priceBars: [{ tradeTime: "20261021000000", open: "339.36", high: "345.25", low: "338.83", close: "343.99" }] } };
await t("OHLC: a closed session's O/H/L/C, cached 12 h per day", async () => {
  upstream = () => ok(dayBars);
  const r = await call("?symbol=AAPL&range=OHLC&day=2026-10-21");
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { s: "AAPL", r: "OHLC", day: "2026-10-21", o: 339.36, h: 345.25, l: 338.83, c: 343.99 });
  assert.equal(r.headers.get("cache-control"), "max-age=43200");
  await call("?symbol=AAPL&range=OHLC&day=2026-10-21");
  assert.equal(calls.length, 1, "cached");
  assert.equal((await call("?symbol=AAPL&range=OHLC&day=2026-10-20")).status, 404, "another day is its own key (no bar -> 404)");
  assert.equal(calls.length, 2);
});
await t("OHLC: a miss (bar not published yet) is re-asked after 5 min, not an hour", async () => {
  upstream = () => ok({ barData: { priceBars: [] } });
  assert.equal((await call("?symbol=MSFT&range=OHLC&day=2026-10-22")).status, 404);
  clock += 4 * 60_000;
  await call("?symbol=MSFT&range=OHLC&day=2026-10-22");
  assert.equal(calls.length, 1, "cached inside 5 min");
  clock += 61_000;
  upstream = () => ok(dayBars);
  await call("?symbol=MSFT&range=OHLC&day=2026-10-22");
  assert.equal(calls.length, 2, "asked again after 5 min");
});
await t("OHLC: day missing or malformed -> 400, no CNBC call", async () => {
  for (const q of ["?symbol=AAPL&range=OHLC", "?symbol=AAPL&range=OHLC&day=2026-10-2", "?symbol=AAPL&range=OHLC&day=20261021", "?symbol=AAPL&range=OHLC&day=../x"]) {
    const r = await call(q);
    assert.equal(r.status, 400, q);
    assert.deepEqual(await json(r), { error: "bad day" }, q);
  }
  assert.equal(calls.length, 0);
});

// ---- cache / TTL / coalescing -------------------------------------------------------------------
await t("a cache hit's max-age is what is LEFT of its TTL (browser + Worker caches don't stack)", async () => {
  await call("?symbol=CSCO&range=1D");
  clock += 45_000;
  const r = await call("?symbol=CSCO&range=1D");
  assert.equal(calls.length, 1);
  assert.equal(r.headers.get("cache-control"), "max-age=15");
});
await t("TTL per range: a hit at TTL-1 ms, one refetch after; ranges are separate keys", async () => {
  for (const [range, ttl] of [["1D", 60_000], ["1Y", 3_600_000]]) {
    calls = [];
    await call(`?symbol=MSFT&range=${range}`);
    clock += ttl - 1;
    await call(`?symbol=MSFT&range=${range}`);
    assert.equal(calls.length, 1, `${range} hit within TTL`);
    clock += 2;
    await call(`?symbol=MSFT&range=${range}`);
    assert.equal(calls.length, 2, `${range} refetched after TTL`);
  }
  calls = [];
  await call("?symbol=ORCL&range=1M");
  await call("?symbol=ORCL&range=3M");
  assert.equal(calls.length, 2);
});
await t("concurrent identical requests share ONE CNBC call and identical bodies", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  upstream = async () => {
    await gate;
    return ok();
  };
  const ps = [call("?symbol=NVDA&range=1M"), call("?symbol=NVDA&range=1M"), call("?symbol=NVDA&range=3M")];
  release();
  const [a, b, c] = await Promise.all(ps);
  assert.equal(calls.length, 2, "1M once + 3M once");
  assert.equal(await a.text(), await b.text());
  assert.equal(c.status, 200);
});
await t("unknown symbol: CNBC ERROR body -> 404, cached an hour, never trips the failure memory", async () => {
  upstream = () => ok({ status: "ERROR", statusMessage: "Security Master not found" });
  const r = await call("?symbol=ZZZZQ&range=1M");
  assert.equal(r.status, 404);
  assert.deepEqual(await json(r), { error: "no data" });
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN);
  clock += 59 * 60_000;
  assert.equal((await call("?symbol=ZZZZQ&range=1M")).status, 404);
  assert.equal(calls.length, 1, "no re-ask within the hour");
  upstream = () => ok();
  assert.equal((await call("?symbol=AAPL&range=1M")).status, 200, "another symbol fetches at once");
  clock += 2 * 60_000;
  await call("?symbol=ZZZZQ&range=1M");
  assert.equal(calls.length, 3, "asked again after the hour");
});
await t("1D on a weekday holiday: today-only window empty -> one retry over 5 days -> 200", async () => {
  clock = Date.parse("2026-11-26T17:00:00Z") + Math.floor(Math.random() * 1000); // Thanksgiving, 12:00 ET
  const day = (d) => ({ barData: { priceBars: [{ close: "50", volume: 1, tradeTime: `${d}100000` }] } });
  upstream = (url) => ok(url.includes("/20261126000000/") ? { barData: { priceBars: [] } } : day("20261125"));
  const r = await call("?symbol=HOLI&range=1D");
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("/20261121000000/"), calls[1].url);
  assert.deepEqual((await json(r)).t, ["2026-11-25 10:00"]);
});
await t("no regular-hours bar in the window -> 404 too", async () => {
  upstream = () => ok({ barData: { priceBars: [{ close: "1", tradeTime: "20261022080000" }] } });
  assert.equal((await call("?symbol=AAPL&range=1D")).status, 404);
});

// ---- failure memory / timeout ------------------------------------------------------------------
await t("CNBC failing (403, 500, non-JSON, reshaped) -> 502 with CORS", async () => {
  for (const [label, up] of [
    ["403", () => new Response("blocked", { status: 403 })],
    ["500", () => new Response("", { status: 500 })],
    ["html", () => new Response("<html>captcha</html>", { status: 200 })],
    ["reshaped", () => ok({ data: [] })],
  ]) {
    clock += 60_000; // past the 30 s memory
    upstream = up;
    const r = await call(`?symbol=AAPL&range=1M&k=${label}`);
    assert.equal(r.status, 502, label);
    assert.deepEqual(await json(r), { error: "upstream" }, label);
    assert.equal(r.headers.get("access-control-allow-origin"), ORIGIN, label);
  }
});
await t("failure memory: 30 s of 502 for misses (no CNBC call), hits still served, then retry", async () => {
  await call("?symbol=KO&range=1Y"); // cached
  upstream = () => new Response("", { status: 503 });
  assert.equal((await call("?symbol=PEP&range=1M")).status, 502);
  upstream = () => ok();
  const n = calls.length;
  clock += 29_999;
  assert.equal((await call("?symbol=XOM&range=1M")).status, 502, "a different symbol inside the window");
  assert.equal(calls.length, n, "no CNBC call inside the window");
  assert.equal((await call("?symbol=KO&range=1Y")).status, 200, "a cached hit is still served");
  clock += 2;
  assert.equal((await call("?symbol=XOM&range=1M")).status, 200);
  assert.equal(calls.length, n + 1);
});
await t("/bars and /quotes failure memories are independent", async () => {
  upstream = (url) => (url.startsWith(CNBC_BARS) ? new Response("", { status: 500 }) : new Response("", { status: 500 }));
  assert.equal((await call("?symbol=AAPL&range=1M")).status, 502);
  upstream = (url) =>
    url.startsWith(CNBC_BARS)
      ? ok()
      : new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: [{ symbol: "AAPL", code: 0, realTime: "true", last: "10", change: "1" }] } }), { status: 200 });
  const q = await worker.fetch(new Request("https://w.example/quotes?symbols=AAPL", { headers: { origin: ORIGIN } }), env);
  assert.equal(q.status, 200, "a /bars outage doesn't block /quotes");
});
await t("a hung CNBC call (timeout) -> 502 and the in-flight entry is cleared", async () => {
  // never answers on its own: only the timeout signal ends it
  upstream = (_url, init) =>
    new Promise((_, reject) => {
      const fail = () => reject(init.signal.reason ?? new Error("aborted"));
      if (init.signal.aborted) fail();
      else init.signal.addEventListener("abort", fail);
    });
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
  try {
    assert.equal((await call("?symbol=AMD&range=1M")).status, 502);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  clock += 31_000;
  upstream = () => ok();
  assert.equal((await call("?symbol=AMD&range=1M")).status, 200, "next request after the window fetches again");
});

// ---- byte-bounded cache --------------------------------------------------------------------------
// n daily bars with valid stamps (consecutive days back from 2026-10-21): ~20 bytes each in the answer
const big = (n) => ({
  barData: {
    priceBars: Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(2026, 9, 21) - (n - i) * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
      return { close: `${100 + (i % 50)}.1234`, volume: 1_000_000 + i, tradeTime: `${d}000000` };
    }),
  },
});
await t("cache bound: oldest entries evicted first, total stays under 8 MB", async () => {
  upstream = () => ok(big(5000)); // ~100 KB per answer
  const syms = Array.from({ length: 120 }, (_, i) => `B${i}`); // ~12 MB worth
  for (const s of syms) assert.equal((await call(`?symbol=${s}&range=ALL`)).status, 200);
  const n = calls.length;
  await call("?symbol=B119&range=ALL"); // the newest: still a hit
  assert.equal(calls.length, n, "recent entry kept");
  await call("?symbol=B0&range=ALL"); // the oldest: evicted
  assert.equal(calls.length, n + 1, "oldest entry evicted");
}, { fresh: true });
await t("cache bound: refreshing one key doesn't double-count its bytes", async () => {
  upstream = () => ok(big(5000)); // 100 refreshes x ~150 KB would blow the 8 MB bound if double-counted
  for (let i = 0; i < 100; i++) {
    clock += 6 * 3600_000 + 1; // ALL TTL passed: refetch the same key
    await call("?symbol=SAME&range=ALL");
  }
  await call("?symbol=OTHER&range=ALL");
  const n = calls.length;
  await call("?symbol=OTHER&range=ALL");
  assert.equal(calls.length, n, "the cache still has room: OTHER was kept");
}, { fresh: true });
await t("cache bound: a concurrent eviction can't blank an in-flight answer", async () => {
  upstream = () => ok(big(2000));
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = async () => {
    await gate;
    return ok(big(5));
  };
  upstream = (url) => (url.includes("/SLOW/") ? slow() : ok(big(2000)));
  const p = call("?symbol=SLOW&range=ALL");
  for (let i = 0; i < 120; i++) await call(`?symbol=E${i}&range=ALL`); // churn the cache meanwhile
  release();
  const r = await p;
  assert.equal(r.status, 200);
  assert.equal((await json(r)).c.length, 5);
}, { fresh: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} worker /bars check(s) failed`);
console.log("worker /bars OK");
