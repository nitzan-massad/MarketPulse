// worker/index.js /quotes — the quote cache's memory bound. Run: node ci/test-worker-cache-bound.mjs
//
// QUOTE_CACHE_MAX (5000) bounds the module-level cache against junk symbol lists by clearing
// it. The clear runs at the START of a request (once the cache is past the bound), and a
// request's answer is built from its own hits + fetch results, so a clear (its own or a
// concurrent request's) can't blank it.
// These cases pin both halves: the bound really evicts, and no answer is ever lost to it. Each case imports its own copy of the module (a distinct `?case=` URL is a distinct
// ESM module instance), so every case starts from an empty cache and every size below is exact.
import assert from "node:assert/strict";
import { CNBC_QUOTE } from "../worker/cnbc.js";

const ORIGIN = "https://nitzan-massad.github.io";
const env = { ORIGIN };
const clock = Date.UTC(2026, 9, 22, 14, 0, 0);
Date.now = () => clock; // frozen: nothing ages out of the 20s TTL during this file

let cnbcCalls = 0;
let gate = null; // { sym, release } — a CNBC call for `sym` waits until release() is called
globalThis.fetch = async (url) => {
  cnbcCalls++;
  if (gate && String(url).includes(gate.sym)) await gate.wait;
  const syms = decodeURIComponent(String(url).slice(CNBC_QUOTE.length)).split("|");
  const rows = syms.map((symbol) => ({
    symbol, code: 0, realTime: "true", currencyCode: "USD", last: "10.00", change: "+1.00",
    change_pct: "+11.11%", last_time: "2026-10-21",
  }));
  return new Response(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: rows } }), { status: 200 });
};

let n = 0;
const fresh = (k) => Array.from({ length: k }, () => `Q${(n++).toString(36).toUpperCase()}`);
let worker = null;
const freshWorker = async (tag) => {
  worker = (await import(`../worker/index.js?case=${tag}`)).default;
};
const call = (syms) =>
  worker.fetch(new Request(`https://w.example/quotes?symbols=${syms.join(",")}`, { headers: { origin: ORIGIN } }), env);
/** Grow the cache by exactly `k` fresh symbols (requests of <= 300). */
async function grow(k) {
  while (k > 0) {
    const m = Math.min(300, k);
    const r = await call(fresh(m));
    assert.equal(r.status, 200, "while growing the cache");
    k -= m;
  }
}

let failed = 0;
let passed = 0;
async function t(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}: ${e?.message ?? e}`);
  }
}
async function answer(syms) {
  try {
    return await call(syms);
  } catch (e) {
    throw new Error(`worker threw instead of answering (${e?.constructor?.name}: ${e?.message}) — on Cloudflare that is a 500 with no CORS header, which the client counts as a failed CNBC poll`);
  }
}

// cache: {}  ->  2 keepers + 4999 others = 5001 entries (> QUOTE_CACHE_MAX)
await t("bound: cached symbols in a request that triggers the clear still get their quote", async () => {
  await freshWorker("mixed");
  const keepers = fresh(2);
  assert.equal((await call(keepers)).status, 200);
  await grow(4999);
  const neu = fresh(1);
  const before = cnbcCalls;
  const r = await answer([...keepers, ...neu]);
  assert.equal(r.status, 200);
  assert.equal(cnbcCalls - before, 1);
  const j = await r.json();
  for (const s of [...keepers, ...neu]) assert.equal(j.quotes[s]?.px, 10, s);
});

// cache: {}  ->  4951; then one 300-symbol request: chunk 1 lifts it to 5051, chunk 2 clears
// it — chunk 1's 100 quotes are gone before the response is built.
await t("bound: a 300-symbol request that crosses 5000 between its chunks answers all 300", async () => {
  await freshWorker("straddle");
  await grow(4951);
  const s = fresh(300);
  const r = await answer(s);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(Object.keys(j.quotes).length, 300);
  for (const x of s) assert.equal(j.quotes[x]?.px, 10, x);
});

// cache: {}  ->  5001 (on a 100-chunk boundary: 16 x 300 + 201, never straddling), then a
// request of only NEW symbols: the clear runs before anything of this request is in hand.
await t("bound: an all-new request after the bound is fine (clear before any of its symbols)", async () => {
  await freshWorker("allnew");
  await grow(4800);
  await grow(201);
  const s = fresh(5);
  const r = await answer(s);
  assert.equal(r.status, 200);
  const j = await r.json();
  for (const x of s) assert.equal(j.quotes[x]?.px, 10, x);
});

await t("bound: past 5000 entries the cache really clears (an old symbol is re-fetched)", async () => {
  await freshWorker("evicts");
  const old = fresh(1);
  assert.equal((await call(old)).status, 200);
  await grow(5000); // 5001 entries: over the bound
  const before = cnbcCalls;
  assert.equal((await call(old)).status, 200);
  assert.equal(cnbcCalls - before, 1, "an evicted symbol must go back to CNBC");
});

await t("bound: at exactly 5000 entries nothing is cleared (cached hit)", async () => {
  await freshWorker("atbound");
  const old = fresh(1);
  assert.equal((await call(old)).status, 200);
  await grow(4999); // 5000 entries: at the bound, not over
  const before = cnbcCalls;
  assert.equal((await call(old)).status, 200);
  assert.equal(cnbcCalls - before, 0, "nothing should be evicted at the bound");
});

await t("bound: a concurrent request's clear can't blank an in-flight request's cached hits", async () => {
  await freshWorker("concurrent");
  const keepers = fresh(2);
  assert.equal((await call(keepers)).status, 200);
  await grow(4998); // 5000 entries: at the bound, so A's start does NOT clear
  const [aNew] = fresh(1);
  let release;
  gate = { sym: aNew, wait: new Promise((r) => (release = r)) };
  const pA = answer([...keepers, aNew]); // reads its 2 hits, then waits on CNBC for aNew
  assert.equal((await answer(fresh(1))).status, 200); // B: 5001 entries
  assert.equal((await answer(fresh(1))).status, 200); // C: starts over the bound -> clears
  release();
  gate = null;
  const rA = await pA;
  assert.equal(rA.status, 200);
  const j = await rA.json();
  for (const s of [...keepers, aNew]) assert.equal(j.quotes[s]?.px, 10, s);
});

await t("bound: the cache keeps working after a clear (cached hit, no CNBC call)", async () => {
  await freshWorker("after");
  await grow(4800);
  await grow(201);
  await answer(fresh(1)); // clears
  const s = fresh(3);
  await answer(s);
  const before = cnbcCalls;
  const r = await answer(s);
  assert.equal(r.status, 200);
  assert.equal(cnbcCalls, before);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} cache-bound check(s) failed`);
console.log("worker cache bound OK");
