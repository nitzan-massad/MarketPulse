// Full-coverage tests for the getData keep/mapping layer in ci/keep.mjs.
// Run: node ci/test-keep.mjs      (no network, no file reads — payloads are built here)
//
// SCOPE. ci/keep.mjs already carries an inline self-check (`node ci/keep.mjs`) that covers
// the happy paths and the `ss` doctrine. This file is the coverage that one does NOT have:
//   * every field of `rowFromGetData` across present / absent / explicitly-null / wrong-type,
//     and the load-bearing partition of which fields are read live vs carried from `prev`;
//   * the exact consensus vocabulary (the app substring-matches "strongbuy" — see src/lib.ts),
//     for all five enum values plus unknown / missing / prev-fallback;
//   * `forecastFields` degradation: missing `report`, `report: null`, `report: {}`,
//     non-numeric `score` (rnd yields NaN, not null), `score: 0`, bundle mismatch;
//   * `airName` / `sectorName` slug vocabularies including malformed input;
//   * `fillNulls` treating 0 / "" / false as real values, and refusing to overwrite;
//   * `aiScaleError` boundaries (exactly AI_SCALE_FLOOR, the sample-size cliff, an emptied
//     column at exactly half) and the `floor` parameter's direction;
//   * keep/expiry: the off-pull `ls` freeze, the KEEP_MAX_AGE_DAYS boundary, pins.
//
// THREE SHIPPED BUGS have named regression tests below; grep "REGRESSION #".
//
// KEEP_MODULE exists so the three regressions can be proven non-vacuous: point it at a
// scratchpad copy of keep.mjs with one line reverted and the matching assertion must fail.
import assert from "node:assert/strict";

const MODULE = process.env.KEEP_MODULE || new URL("./keep.mjs", import.meta.url).href;
const K = await import(MODULE);
const {
  KEEP_MAX_AGE_DAYS, AI_SCALE_FLOOR, lastSeenMs, computeKeep, nextLastSeen,
  sectorName, airName, rowFromGetData, forecastFields, fillNulls, aiScaleError, rndPx,
} = K;

// --- harness -------------------------------------------------------------------
// Every assertion is named and lazily evaluated: several inputs under test used to THROW
// (the `"score" in s` regression), and a throw must be reported as THAT assertion failing
// rather than aborting the file and hiding the remaining coverage.
let checks = 0;
const fails = [];
const check = (msg, fn) => {
  checks++;
  try { fn(); } catch (e) { fails.push(`${msg}\n      ${String(e && e.message).split("\n").slice(0, 3).join(" ⏎ ")}`); }
};
const eq = (msg, fn, expected) => check(msg, () => assert.deepStrictEqual(fn(), expected));
const truthy = (msg, fn) => check(msg, () => assert.ok(fn()));

// =====================================================================================
// A. module surface — the export list this file is written against
// =====================================================================================
const EXPECTED_EXPORTS = {
  KEEP_MAX_AGE_DAYS: "number", AI_SCALE_FLOOR: "number", lastSeenMs: "function",
  computeKeep: "function", nextLastSeen: "function", sectorName: "function",
  airName: "function", rowFromGetData: "function", forecastFields: "function",
  fillNulls: "function", aiScaleError: "function", rndPx: "function",
};
for (const [name, type] of Object.entries(EXPECTED_EXPORTS)) {
  eq(`export ${name} is a ${type}`, () => typeof K[name], type);
}
// A tripwire, not decoration: new public surface must arrive with coverage in this file.
// NOTE `CON_NAME`, `ssFromGetData` and `AI_SCALE_MIN_SAMPLE` are deliberately module-private
// — they are exercised through rowFromGetData / forecastFields / aiScaleError below.
eq("keep.mjs exports exactly the 12 covered names", () => Object.keys(K).sort(), Object.keys(EXPECTED_EXPORTS).sort());
eq("CON_NAME is private — the vocabulary is asserted through the two mappers", () => K.CON_NAME, undefined);
eq("KEEP_MAX_AGE_DAYS is 365 (the expiry contract seen.json is written against)", () => KEEP_MAX_AGE_DAYS, 365);
eq("AI_SCALE_FLOOR is 10 (top of the bogus 0–10 scale)", () => AI_SCALE_FLOOR, 10);

// =====================================================================================
// B. lastSeenMs — the age source for expiry and for the most-stale-first backfill order
// =====================================================================================
const ISO = (s) => Date.parse(s);
eq("lastSeenMs prefers ls over d", () => lastSeenMs({ ls: "2026-06-01T00:00:00Z", d: "2020-01-01T00:00:00Z" }), ISO("2026-06-01T00:00:00Z"));
eq("lastSeenMs falls back to d when ls is absent", () => lastSeenMs({ d: "2026-06-01T00:00:00Z" }), ISO("2026-06-01T00:00:00Z"));
eq("lastSeenMs falls back to d when ls is empty string", () => lastSeenMs({ ls: "", d: "2026-06-01T00:00:00Z" }), ISO("2026-06-01T00:00:00Z"));
eq('lastSeenMs on the legacy "baseline" seed → null (never expires)', () => lastSeenMs({ d: "baseline" }), null);
eq("lastSeenMs on an unparseable ls → null, NOT NaN (callers compare with != null)", () => lastSeenMs({ ls: "not-a-date" }), null);
eq("lastSeenMs on {} → null", () => lastSeenMs({}), null);
eq("lastSeenMs on null → null", () => lastSeenMs(null), null);
eq("lastSeenMs on undefined → null", () => lastSeenMs(undefined), null);
eq("lastSeenMs accepts a date-only string", () => lastSeenMs({ ls: "2026-06-01" }), ISO("2026-06-01"));

// =====================================================================================
// C. computeKeep — pins never expire; the KEEP_MAX_AGE_DAYS boundary is exclusive
// =====================================================================================
const NOW = Date.parse("2026-08-03T00:00:00Z");
const DAY = 86_400_000;
const ago = (ms) => new Date(NOW - ms).toISOString();

eq(`a ticker last seen exactly ${KEEP_MAX_AGE_DAYS}d ago is KEPT (boundary is > , not >=)`,
  () => [...computeKeep([], { A: { ls: ago(KEEP_MAX_AGE_DAYS * DAY) } }, NOW).keep], ["A"]);
eq(`${KEEP_MAX_AGE_DAYS}d + 1ms is DROPPED`,
  () => computeKeep([], { A: { ls: ago(KEEP_MAX_AGE_DAYS * DAY + 1) } }, NOW).dropped, ["A"]);
eq(`${KEEP_MAX_AGE_DAYS}d + 1ms leaves the keep set empty`,
  () => [...computeKeep([], { A: { ls: ago(KEEP_MAX_AGE_DAYS * DAY + 1) } }, NOW).keep], []);
eq("computeKeep uses KEEP_MAX_AGE_DAYS by default when maxAgeDays is omitted",
  () => computeKeep([], { A: { ls: ago((KEEP_MAX_AGE_DAYS + 1) * DAY) } }, NOW).dropped, ["A"]);
eq("an explicit smaller maxAgeDays tightens expiry",
  () => computeKeep([], { A: { ls: ago(31 * DAY) } }, NOW, 30).dropped, ["A"]);
truthy("a PINNED ticker 10 years stale is still kept",
  () => { const { keep, dropped } = computeKeep(["PIN"], { PIN: { ls: ago(3650 * DAY) } }, NOW); return keep.has("PIN") && dropped.length === 0; });
truthy("a pin never even reaches the expiry branch (never appears in `dropped`)",
  () => computeKeep(["PIN"], { PIN: { d: "baseline", ls: ago(99_999 * DAY) } }, NOW).dropped.length === 0);
truthy("a pin that has never been seen is still in the keep set",
  () => computeKeep(["BRANDNEW"], {}, NOW).keep.has("BRANDNEW"));
truthy('a "baseline" entry has no parseable age, so it can never expire',
  () => { const { keep, dropped } = computeKeep([], { A: { d: "baseline" } }, NOW); return keep.has("A") && !dropped.includes("A"); });
eq("computeKeep tolerates a null pinned list", () => [...computeKeep(null, { A: { ls: ago(DAY) } }, NOW).keep], ["A"]);
eq("computeKeep tolerates a null prevSeen", () => [...computeKeep(["P"], null, NOW).keep], ["P"]);
eq("computeKeep on empty input yields an empty keep set", () => [...computeKeep([], {}, NOW).keep], []);
truthy("computeKeep does not mutate the pinned array it was given",
  () => { const pins = ["P"]; computeKeep(pins, { A: { ls: ago(DAY) } }, NOW); return pins.length === 1; });

// =====================================================================================
// D. nextLastSeen — the OFF-PULL FREEZE. Two separate rotation schemes broke on this:
//    `ls` deliberately does NOT move while a ticker is off the screener list, which is
//    why refresh-data-ci.mjs had to add a second stamp (`ea`) to rotate the enrich queue.
//    If this freeze ever silently becomes "touch it every run", expiry stops working and
//    the most-stale-first backfill order collapses. Assert the freeze is real.
// =====================================================================================
const TODAY = "2026-08-03T12:34:56.000Z";
const OLD = "2026-01-01T00:00:00Z";
eq("in the pull → ls advances to today", () => nextLastSeen({ ls: OLD }, true, TODAY), TODAY);
eq("in the pull → today wins even over a newer stored ls", () => nextLastSeen({ ls: "2030-01-01T00:00:00Z" }, true, TODAY), TODAY);
eq("in the pull with no prior entry → today", () => nextLastSeen(undefined, true, TODAY), TODAY);
eq("OFF-PULL FREEZE: ls is carried unchanged, NOT refreshed to today", () => nextLastSeen({ ls: OLD }, false, TODAY), OLD);
truthy("OFF-PULL FREEZE is idempotent — 100 off-pull runs never advance the clock",
  () => { let e = { ls: OLD }; for (let i = 0; i < 100; i++) e = { ls: nextLastSeen(e, false, TODAY) }; return e.ls === OLD; });
eq("off-pull with only `d` → carries d (first-seen doubles as last-seen)", () => nextLastSeen({ d: OLD }, false, TODAY), OLD);
eq('off-pull legacy "baseline" → clock starts now, so expiry applies uniformly', () => nextLastSeen({ d: "baseline" }, false, TODAY), TODAY);
eq("off-pull with an unparseable ls → clock starts now", () => nextLastSeen({ ls: "garbage" }, false, TODAY), TODAY);
// FIXED: `prev.ls || prev.d` took ls unconditionally, so ONE corrupt write restarted the
// 365-day expiry clock even though a valid first-seen date sat right beside it — silently
// extending a dead ticker's life by a year. Each candidate is now validated in turn.
eq("off-pull: a garbage `ls` falls back to a good `d` instead of restarting the clock",
  () => nextLastSeen({ ls: "garbage", d: OLD }, false, TODAY), OLD);
eq("off-pull: a numeric-epoch `ls` also falls back to `d`",
  () => nextLastSeen({ ls: 1750000000000, d: OLD }, false, TODAY), OLD);
eq("off-pull: garbage in BOTH → clock starts now",
  () => nextLastSeen({ ls: "garbage", d: "nonsense" }, false, TODAY), TODAY);
eq("off-pull: an EMPTY ls falls through to d (empty is falsy, garbage is not)",
  () => nextLastSeen({ ls: "", d: OLD }, false, TODAY), OLD);
eq("off-pull with no prior entry at all → today", () => nextLastSeen(undefined, false, TODAY), TODAY);
eq("off-pull with a null prior entry → today", () => nextLastSeen(null, false, TODAY), TODAY);
eq("off-pull with an empty prior entry → today", () => nextLastSeen({}, false, TODAY), TODAY);
eq("off-pull: a numeric epoch ls is NOT parseable → clock restarts", () => nextLastSeen({ ls: 1_700_000_000_000 }, false, TODAY), TODAY);
eq("nextLastSeen returns the carried string verbatim (no re-formatting)", () => nextLastSeen({ ls: "2026-01-01" }, false, TODAY), "2026-01-01");
truthy("the freeze composes with computeKeep: a frozen ls eventually expires",
  () => { const frozen = nextLastSeen({ ls: ago((KEEP_MAX_AGE_DAYS + 1) * DAY) }, false, new Date(NOW).toISOString());
          return computeKeep([], { A: { ls: frozen } }, NOW).dropped.includes("A"); });

// =====================================================================================
// E. rowFromGetData — the field-by-field mapping
// =====================================================================================
// A complete getData payload. Values are chosen so nothing can collide with the `prev`
// sentinels below — any leak in either direction is visible.
const payload = (over = {}) => ({
  ticker: "GOOGL",
  companyName: "Alphabet Inc",
  prices: [{ p: 100 }, { p: 200.456 }],                                     // LAST price wins
  ptConsensus: [{ period: 0, priceTarget: 111 }, { bench: 1, priceTarget: 250 }],
  consensuses: [
    { isLatest: 1, rating: 2, nB: 90, nH: 91, nS: 92 },                     // latest but not mStars 1
    { isLatest: 1, mStars: 1, rating: 5, nB: 30, nH: 4, nS: 1 },            // must win
  ],
  tipranksStockScore: { score: 9 },
  marketCapUSD: 2_400_000_000,
  marketCap: 999_000_000_000,                                               // must lose to marketCapUSD
  description: "search and ads",
  // DECOYS. Every plausible name a future edit might reach for to source a CARRIED field
  // from the payload instead of from `prev`. They are all mapped to values that could not
  // come from PREV_FULL, so the CARRIED assertions below fail the moment one is read.
  // (getData really does ship only a numeric sectorID and no change/AI fields at all.)
  sectorID: 3,
  sector: "technology", sectorName: "Technology",
  changePercent: 1.5, priceChangePct: 0.015, dailyChange: 1.5, gain: 0.015,
  aiScore: 88, aiRating: "outperform", aiPriceTarget: 300,
  aiAnalystData: { overallScore: 88, overallRating: "Outperform", priceTarget: 300 },
  ...over,
});
// `prev` with a DISTINCT sentinel in every field.
const PREV_FULL = Object.freeze({
  t: "OLD", n: "Old Name", sec: "Energy", px: 1.11, chg: -9.9, pt: 2.22, up: 3.33,
  con: "Sell", b: 7, h: 8, s: 9, ss: 2, ai: 44, air: "Underperform", aipt: 5.55,
  mc: 123, desc: "old desc",
});
const PREV_ALL_NULL = Object.freeze(Object.fromEntries(Object.keys(PREV_FULL).map((k) => [k, null])));

// --- E1. the row shape and the provenance partition ---------------------------------
// THIS PARTITION IS LOAD-BEARING. Moving a field between these groups changes what the
// app shows on a keep-path row, so each group is asserted separately and by name.
//   PAYLOAD_ONLY  — read live, NO prev fallback: a payload without them BLANKS the row.
//                   px/pt/up are recomputed every run by design (a stale target is worse
//                   than a blank one), and `t` gates the whole row at the call site.
//   PAYLOAD_FIRST — payload wins, prev is the fallback when the payload lacks the field.
//   CARRIED       — getData genuinely has none of these, so they ALWAYS come from prev.
//                   refresh-data-ci.mjs then overwrites ai/air/aipt/chg from the forecast
//                   payload (CARRIED_FIELDS there); `sec` is filled, not overwritten.
const PAYLOAD_ONLY = ["t", "px", "pt", "up"];
const PAYLOAD_FIRST = ["n", "con", "b", "h", "s", "ss", "mc", "desc"];
const CARRIED = ["ai", "air", "aipt", "chg", "sec"];

const full = rowFromGetData(payload(), PREV_FULL);
eq("the mapped row has exactly the 17 stocks.json keys",
  () => Object.keys(full).sort(), [...PAYLOAD_ONLY, ...PAYLOAD_FIRST, ...CARRIED].sort());
for (const f of CARRIED) {
  eq(`CARRIED: \`${f}\` comes from prev even when the payload is complete`, () => full[f], PREV_FULL[f]);
}
for (const f of [...PAYLOAD_ONLY, ...PAYLOAD_FIRST]) {
  truthy(`LIVE: \`${f}\` is read from the payload, not carried from prev`, () => full[f] !== PREV_FULL[f]);
}
eq("`sec` is carried even though the payload ships a numeric sectorID", () => full.sec, "Energy");

// prev-fallback behaviour on a payload that maps nothing but the ticker
const bare = rowFromGetData({ ticker: "GOOGL" }, PREV_FULL);
for (const f of PAYLOAD_FIRST) {
  eq(`PAYLOAD_FIRST: \`${f}\` falls back to prev when the payload lacks it`, () => bare[f], PREV_FULL[f]);
}
for (const f of PAYLOAD_ONLY.filter((x) => x !== "t")) {
  eq(`PAYLOAD_ONLY: \`${f}\` BLANKS to null when the payload lacks it (no prev fallback)`, () => bare[f], null);
}
eq("`t` always comes from the payload, never from prev", () => rowFromGetData({}, PREV_FULL).t, undefined);
truthy("rowFromGetData does not mutate `prev`",
  () => { const p = { ...PREV_FULL }; rowFromGetData(payload(), p); return JSON.stringify(p) === JSON.stringify(PREV_FULL); });

// --- E2. an empty prev, and a prev whose every field is null ------------------------
eq("prev {} → every carried/fallback field is null except b/h/s, which are 0",
  () => rowFromGetData({ ticker: "X" }, {}),
  { t: "X", n: null, sec: null, px: null, chg: null, pt: null, up: null, con: null,
    b: 0, h: 0, s: 0, ss: null, ai: null, air: null, aipt: null, mc: null, desc: null });
eq("prev omitted entirely (default arg) behaves like prev {}",
  () => rowFromGetData({ ticker: "X" }), rowFromGetData({ ticker: "X" }, {}));
eq("prev with every field null → the same all-null row (nulls do not leak as strings)",
  () => rowFromGetData({ ticker: "X" }, PREV_ALL_NULL), rowFromGetData({ ticker: "X" }, {}));
eq("prev.b === null becomes 0, not null (b/h/s use `|| 0`, so the app never sees a null count)",
  () => [bareNulls().b, bareNulls().h, bareNulls().s], [0, 0, 0]);
function bareNulls() { return rowFromGetData({ ticker: "X" }, PREV_ALL_NULL); }
eq("prev.b === 0 survives as 0", () => rowFromGetData({ ticker: "X" }, { b: 0, h: 0, s: 0 }).b, 0);

// --- E3. a payload that maps to a FALSY `t` — the caller's `if (row.t)` gate ---------
// refresh-data-ci.mjs:110 and scripts/refresh-data.mjs accept the row only `if (row.t)`,
// otherwise the whole previous row is carried. A garbage response must reach that gate
// as a falsy `t` WITHOUT throwing on the way.
for (const [label, j] of [["missing ticker", {}], ["ticker ''", { ticker: "" }], ["ticker 0", { ticker: 0 }],
  ["ticker null", { ticker: null }], ["empty object payload", {}]]) {
  truthy(`falsy-t gate: ${label} maps to a falsy \`t\` so the caller rejects the row`,
    () => !rowFromGetData(j, PREV_FULL).t);
}
truthy("a falsy-t row is still fully built (the gate, not an exception, is what rejects it)",
  () => Object.keys(rowFromGetData({}, PREV_FULL)).length === 17);
eq("a non-string ticker is NOT laundered — it passes through as-is", () => rowFromGetData({ ticker: 123 }).t, 123);

// --- E4. px: last price in the array ------------------------------------------------
eq("px is the LAST entry of prices, rounded to 2dp", () => rowFromGetData({ ticker: "X", prices: [{ p: 100 }, { p: 200.456 }] }).px, 200.46);
eq("px with a single price", () => rowFromGetData({ ticker: "X", prices: [{ p: 12.5 }] }).px, 12.5);
eq("px on an EMPTY prices array → null (no prev fallback)", () => rowFromGetData({ ticker: "X", prices: [] }, { px: 99 }).px, null);
eq("px when prices is absent → null", () => rowFromGetData({ ticker: "X" }, { px: 99 }).px, null);
eq("px when prices is explicitly null → null (|| [] guard)", () => rowFromGetData({ ticker: "X", prices: null }, { px: 99 }).px, null);
eq("px when the last entry has no `p` → null", () => rowFromGetData({ ticker: "X", prices: [{ p: 1 }, {}] }).px, null);
eq("px when p is explicitly null → null", () => rowFromGetData({ ticker: "X", prices: [{ p: null }] }).px, null);
eq("px 0 is preserved as 0, not blanked", () => rowFromGetData({ ticker: "X", prices: [{ p: 0 }] }).px, 0);
eq('px LAUNDERS a numeric string: "10.126" → 10.13', () => rowFromGetData({ ticker: "X", prices: [{ p: "10.126" }] }).px, 10.13);
truthy("px on a non-numeric p → NaN (rnd does not validate; JSON.stringify writes it as null)",
  () => Number.isNaN(rowFromGetData({ ticker: "X", prices: [{ p: "abc" }] }).px));
eq("px when prices is a non-array object → null, no throw", () => rowFromGetData({ ticker: "X", prices: {} }).px, null);
// FIXED: a null element in the price series used to be an unguarded read that THREW.
// scripts/refresh-data.mjs calls rowFromGetData outside any try/catch, so one malformed
// price row aborted the whole local refresh instead of degrading to null.
eq("px when the last prices element is null → null, no throw",
  () => rowFromGetData({ ticker: "X", prices: [{ p: 1 }, null] }).px, null);
eq("px when the last prices element is a primitive → null, no throw",
  () => rowFromGetData({ ticker: "X", prices: [{ p: 1 }, 7] }).px, null);

// --- E5. pt: the "best analysts" target, and its selection precedence ---------------
eq("pt prefers bench === 1 over period === 0 and over index 0",
  () => rowFromGetData({ ticker: "X", ptConsensus: [{ period: 0, priceTarget: 111 }, { bench: 1, priceTarget: 250 }] }).pt, 250);
eq("pt falls back to period === 0 when no bench 1 exists",
  () => rowFromGetData({ ticker: "X", ptConsensus: [{ priceTarget: 111 }, { period: 0, priceTarget: 222 }] }).pt, 222);
eq("pt falls back to the first entry when neither marker exists",
  () => rowFromGetData({ ticker: "X", ptConsensus: [{ priceTarget: 333 }, { priceTarget: 444 }] }).pt, 333);
eq("pt on an empty ptConsensus → null", () => rowFromGetData({ ticker: "X", ptConsensus: [] }, { pt: 9 }).pt, null);
eq("pt when ptConsensus is explicitly null → null", () => rowFromGetData({ ticker: "X", ptConsensus: null }, { pt: 9 }).pt, null);
eq("pt when the selected entry's priceTarget is null → null", () => rowFromGetData({ ticker: "X", ptConsensus: [{ bench: 1, priceTarget: null }] }, { pt: 9 }).pt, null);
eq("pt is rounded to 2dp", () => rowFromGetData({ ticker: "X", ptConsensus: [{ bench: 1, priceTarget: 448.8199 }] }).pt, 448.82);
eq("pt 0 is preserved", () => rowFromGetData({ ticker: "X", ptConsensus: [{ bench: 1, priceTarget: 0 }] }).pt, 0);

// --- E6. up: upside %, 1dp -----------------------------------------------------------
const upOf = (p, target) => rowFromGetData({ ticker: "X", prices: [{ p }], ptConsensus: [{ bench: 1, priceTarget: target }] }).up;
eq("up = (pt - px) / px * 100, 1dp", () => upOf(10, 15), 50);
eq("up is negative when the target is below the price", () => upOf(200, 150), -25);
eq("up rounds to 1dp", () => upOf(333.76, 448.82), 34.5);
eq("up on a pt of 0 → -100 (0 is a target, not a blank)", () => upOf(10, 0), -100);
eq("up when px is 0 → null (guards the division, does not emit Infinity)", () => upOf(0, 5), null);
eq("up when px is missing → null", () => rowFromGetData({ ticker: "X", ptConsensus: [{ bench: 1, priceTarget: 5 }] }, { up: 9 }).up, null);
eq("up when pt is missing → null", () => rowFromGetData({ ticker: "X", prices: [{ p: 5 }] }, { up: 9 }).up, null);
eq("up when both are missing → null, never carried from prev", () => rowFromGetData({ ticker: "X" }, { up: 9 }).up, null);

// --- E7. mc: market cap in millions --------------------------------------------------
eq("mc prefers marketCapUSD over marketCap", () => rowFromGetData({ ticker: "X", marketCapUSD: 2e9, marketCap: 9e12 }).mc, 2000);
eq("mc falls back to marketCap when marketCapUSD is null", () => rowFromGetData({ ticker: "X", marketCapUSD: null, marketCap: 2e9 }).mc, 2000);
eq("mc falls back to marketCap when marketCapUSD is absent", () => rowFromGetData({ ticker: "X", marketCap: 2e9 }).mc, 2000);
eq("mc rounds to the nearest million", () => rowFromGetData({ ticker: "X", marketCapUSD: 2_499_999 }).mc, 2);
eq("mc 0 is a value, not a blank — it does NOT fall back to prev", () => rowFromGetData({ ticker: "X", marketCapUSD: 0 }, { mc: 5 }).mc, 0);
eq("mc absent from both fields → carried from prev", () => rowFromGetData({ ticker: "X" }, { mc: 5 }).mc, 5);
eq("mc absent with no prev → null", () => rowFromGetData({ ticker: "X" }).mc, null);
eq("mc both fields null → carried from prev", () => rowFromGetData({ ticker: "X", marketCapUSD: null, marketCap: null }, { mc: 5 }).mc, 5);
eq('mc LAUNDERS a numeric string: "2000000000" → 2000', () => rowFromGetData({ ticker: "X", marketCapUSD: "2000000000" }).mc, 2000);

// --- E8. n / desc: plain payload-first strings ---------------------------------------
eq("n comes from companyName", () => rowFromGetData({ ticker: "X", companyName: "XCo" }, { n: "Prev" }).n, "XCo");
eq("n null → prev.n", () => rowFromGetData({ ticker: "X", companyName: null }, { n: "Prev" }).n, "Prev");
eq("n absent → prev.n", () => rowFromGetData({ ticker: "X" }, { n: "Prev" }).n, "Prev");
eq("n absent with no prev → null", () => rowFromGetData({ ticker: "X" }).n, null);
eq('n "" is a value, not a blank — `??` does not fall back on empty string', () => rowFromGetData({ ticker: "X", companyName: "" }, { n: "Prev" }).n, "");
eq("n of the wrong type passes through unvalidated", () => rowFromGetData({ ticker: "X", companyName: { a: 1 } }).n, { a: 1 });
eq("desc comes from description", () => rowFromGetData({ ticker: "X", description: "d" }, { desc: "D" }).desc, "d");
eq("desc null → prev.desc", () => rowFromGetData({ ticker: "X", description: null }, { desc: "D" }).desc, "D");
eq("desc absent → prev.desc", () => rowFromGetData({ ticker: "X" }, { desc: "D" }).desc, "D");
eq('desc "" is a value, not a blank', () => rowFromGetData({ ticker: "X", description: "" }, { desc: "D" }).desc, "");
eq("desc absent with no prev → null", () => rowFromGetData({ ticker: "X" }).desc, null);

// --- E9. REGRESSION #2 / #3 — `ss` (Smart Score) -------------------------------------
// #2: `j.tipranksStockScore?.score ?? prev.ss` could not tell "TipRanks says no Smart
//     Score" (an explicitly present `score: null`, real on ASTI/BCDA) from "the payload
//     reshaped". A real null resurrected a stale number: ASTI stayed frozen at ss 2.
// #3: the fix `"score" in s` THROWS on a truthy primitive — a robustness regression
//     against the `?.score` it replaced, and rowFromGetData is called outside any
//     try/catch in scripts/refresh-data.mjs, so it aborts the whole local refresh.
const ssOf = (ts, prev) => rowFromGetData(ts === undefined ? { ticker: "X" } : { ticker: "X", tipranksStockScore: ts }, prev).ss;
eq("REGRESSION #2: explicit `score: null` beats prev.ss — no score renders '—', not a stale 2", () => ssOf({ score: null }, { ss: 2 }), null);
eq("REGRESSION #2: `score: null` with a prev.ss of 0 still yields null", () => ssOf({ score: null }, { ss: 0 }), null);
eq("REGRESSION #2: `score: null` and no prev → null", () => ssOf({ score: null }, {}), null);
eq("a real score wins over prev.ss", () => ssOf({ score: 4 }, { ss: 2 }), 4);
eq("score 0 is a value, not a blank (nullish test, not falsy)", () => ssOf({ score: 0 }, { ss: 7 }), 0);
eq("score 10 (the TipRanks maximum) passes through", () => ssOf({ score: 10 }, { ss: 2 }), 10);
eq("a reshaped payload — no tipranksStockScore at all → carry prev.ss", () => ssOf(undefined, { ss: 7 }), 7);
eq("an object with no `score` key → carry prev.ss", () => ssOf({ momentum: 1 }, { ss: 7 }), 7);
eq("an explicitly null tipranksStockScore is lumped in with absent → carry", () => ssOf(null, { ss: 7 }), 7);
eq("an explicitly `undefined` score is treated as data (the KEY is present) → null, not carry", () => ssOf({ score: undefined }, { ss: 7 }), null);
eq("no tipranksStockScore and no prev → null", () => ssOf(undefined, {}), null);
// #3 — every truthy primitive must CARRY, never throw. `in` throws on all of these.
for (const junk of [7, -1, 1.5, "x", "score", true, 1e308]) {
  eq(`REGRESSION #3: truthy primitive tipranksStockScore=${String(junk)} carries prev.ss instead of throwing`, () => ssOf(junk, { ss: 7 }), 7);
}
for (const junk of [0, "", false, null, undefined, NaN]) {
  eq(`falsy tipranksStockScore=${String(junk)} carries prev.ss`, () => ssOf(junk, { ss: 7 }), 7);
}
eq("an ARRAY tipranksStockScore has no `score` key → carry, no throw", () => ssOf([], { ss: 7 }), 7);
eq("an array WITH a score-like index still carries", () => ssOf([1, 2, 3], { ss: 7 }), 7);
// FIXED: `ss` was the ONE numeric field bypassing rnd(), so a string score reached
// stocks.json as a STRING and then hit sortRows' string branch, localeCompare-ing against
// numbers. A non-numeric score is a reshaped payload, not a value — carry, don't launder.
eq('a numeric STRING score "7" is coerced to the number 7', () => ssOf({ score: "7" }, { ss: 2 }), 7);
eq("an object score is a reshape → carry prev.ss, never write an object", () => ssOf({ score: { v: 1 } }, { ss: 2 }), 2);
eq("a NaN score is a reshape → carry prev.ss, never write NaN", () => ssOf({ score: NaN }, { ss: 2 }), 2);
eq("a non-numeric string score → carry prev.ss", () => ssOf({ score: "n/a" }, { ss: 2 }), 2);
eq("a reshaped score with NO prev → null, not NaN", () => ssOf({ score: "n/a" }, {}), null);
eq("score 0 still wins over prev (0 is a value)", () => ssOf({ score: 0 }, { ss: 7 }), 0);

// =====================================================================================
// F. consensus mapping — the exact vocabulary. src/lib.ts lowercases and SUBSTRING-matches
//    "strongbuy"/"strongsell", so a space or a spelling change silently breaks filtering.
// =====================================================================================
const CON_VOCAB = { 1: "StrongSell", 2: "Sell", 3: "Neutral", 4: "Buy", 5: "StrongBuy" };
const conOf = (rating) => rowFromGetData({ ticker: "X", consensuses: [{ isLatest: 1, mStars: 1, rating }] }).con;
for (const [rating, name] of Object.entries(CON_VOCAB)) {
  eq(`rowFromGetData: rating ${rating} → "${name}"`, () => conOf(Number(rating)), name);
  eq(`forecastFields: enumId ${rating} → "${name}"`, () => forecastFields({ models: { stocks: [{ _id: "T", analystRatings: { best: { enumId: Number(rating) } } }] } }, "T").con, name);
  truthy(`"${name}" contains no whitespace (the app substring-matches, so a space breaks it)`, () => !/\s/.test(name));
}
truthy('"StrongBuy" lowercases to exactly "strongbuy"', () => CON_VOCAB[5].toLowerCase() === "strongbuy");
truthy('"StrongSell" lowercases to exactly "strongsell"', () => CON_VOCAB[1].toLowerCase() === "strongsell");
truthy('"Buy" must NOT contain "strongbuy" or the filters would over-match', () => !"buy".includes("strongbuy"));
truthy('"Sell" must NOT contain "strongsell"', () => !"sell".includes("strongsell"));
eq("the vocabulary is exactly 5 values, keyed 1–5", () => Object.keys(CON_VOCAB), ["1", "2", "3", "4", "5"]);

// selection precedence: latest best-analyst consensus > any latest > first
eq("con prefers isLatest && mStars === 1", () => rowFromGetData({ ticker: "X", consensuses: [
  { isLatest: 1, rating: 2 }, { isLatest: 1, mStars: 1, rating: 5 }] }).con, "StrongBuy");
eq("con falls back to any isLatest entry", () => rowFromGetData({ ticker: "X", consensuses: [
  { rating: 1 }, { isLatest: true, rating: 4 }] }).con, "Buy");
eq("con falls back to the first entry when none is marked latest", () => rowFromGetData({ ticker: "X", consensuses: [
  { rating: 3 }, { rating: 5 }] }).con, "Neutral");

// unknown / missing / prev fallback
eq("an UNKNOWN rating enum falls back to prev.con", () => rowFromGetData({ ticker: "X", consensuses: [{ isLatest: 1, mStars: 1, rating: 9 }] }, { con: "Buy" }).con, "Buy");
eq("an unknown rating enum with no prev → null", () => conOf(9), null);
eq("rating 0 is not in the vocabulary → null", () => conOf(0), null);
eq("rating null falls back to prev.con", () => rowFromGetData({ ticker: "X", consensuses: [{ isLatest: 1, mStars: 1, rating: null }] }, { con: "Buy" }).con, "Buy");
eq("a MISSING consensuses array falls back to prev.con", () => rowFromGetData({ ticker: "X" }, { con: "Buy" }).con, "Buy");
eq("an EMPTY consensuses array falls back to prev.con", () => rowFromGetData({ ticker: "X", consensuses: [] }, { con: "Buy" }).con, "Buy");
eq("consensuses explicitly null falls back to prev.con", () => rowFromGetData({ ticker: "X", consensuses: null }, { con: "Buy" }).con, "Buy");
eq("no consensus and no prev.con → null", () => rowFromGetData({ ticker: "X" }).con, null);
eq('TYPE LAUNDERING: a string rating "5" still maps (object keys are strings)', () => conOf("5"), "StrongBuy");
// b/h/s ride along with the selected consensus
eq("b/h/s come from the SELECTED consensus, not the first one", () => {
  const r = rowFromGetData(payload(), PREV_FULL); return [r.b, r.h, r.s];
}, [30, 4, 1]);
eq("b/h/s default to 0 when the selected consensus omits the counts", () => {
  const r = rowFromGetData({ ticker: "X", consensuses: [{ isLatest: 1, mStars: 1, rating: 4 }] }, { b: 7, h: 8, s: 9 });
  return [r.b, r.h, r.s];
}, [0, 0, 0]);
eq("b/h/s fall back to prev when there is NO consensus at all", () => {
  const r = rowFromGetData({ ticker: "X" }, { b: 7, h: 8, s: 9 }); return [r.b, r.h, r.s];
}, [7, 8, 9]);
eq("a consensus count of 0 stays 0", () => {
  const r = rowFromGetData({ ticker: "X", consensuses: [{ isLatest: 1, mStars: 1, rating: 3, nB: 0, nH: 0, nS: 0 }] }, { b: 7 });
  return [r.b, r.h, r.s];
}, [0, 0, 0]);
eq("forecastFields: enumId absent → con null (NO prev fallback on this path)",
  () => forecastFields({ models: { stocks: [{ _id: "T", analystRatings: { best: {} } }] } }, "T").con, null);
eq("forecastFields: enumId null → con null", () => forecastFields({ models: { stocks: [{ _id: "T", analystRatings: { best: { enumId: null } } }] } }, "T").con, null);
eq("forecastFields: enumId 9 (unknown) → con null", () => forecastFields({ models: { stocks: [{ _id: "T", analystRatings: { best: { enumId: 9 } } }] } }, "T").con, null);
eq("forecastFields: enumId 0 → con null", () => forecastFields({ models: { stocks: [{ _id: "T", analystRatings: { best: { enumId: 0 } } }] } }, "T").con, null);
eq("forecastFields: analystRatings absent → con null", () => forecastFields({ models: { stocks: [{ _id: "T" }] } }, "T").con, null);

// =====================================================================================
// G. forecastFields — the ONLY per-ticker source for ai / air / aipt / sec
// =====================================================================================
const ff = (stock, ticker = "T") => forecastFields({ models: { stocks: [{ _id: "PEER", report: { score: 1 } }, { _id: ticker, ...stock }] } }, ticker);

// --- G1. REGRESSION #1 — `ai` must NOT be rescaled ----------------------------------
// `forecastFields` divided report.score by 10 on a false claim that the app wants 0–10.
// Both sources are 0–100: the screener's aiAnalystData.overallScore spreads 39–85 live,
// and report.score reads 71 / 75 / 79 for TER / AAPL / NVDA. The ÷10 corrupted exactly
// the two pinned tickers (TER 7.8 for a real 71) for 58 commits.
eq("REGRESSION #1: report.score 78 → ai 78 (NOT 7.8)", () => ff({ report: { score: 78 } }).ai, 78);
for (const score of [39, 71, 75, 79, 85]) {
  eq(`REGRESSION #1: live-observed score ${score} passes through undivided`, () => ff({ report: { score } }).ai, score);
}
truthy("REGRESSION #1: a 0–100 score never lands in the 0–10 band that aiScaleError flags",
  () => ff({ report: { score: 71 } }).ai > AI_SCALE_FLOOR);
truthy("REGRESSION #1: forecastFields output alone does not trip the scale guard",
  () => aiScaleError([{ t: "TER", ai: ff({ report: { score: 71 } }).ai }, { t: "NVDA", ai: 79 }]) === null);
truthy("REGRESSION #1: a rescaled ai mixed with screener rows WOULD trip the guard (the guard is live)",
  () => aiScaleError([{ t: "TER", ai: 7.1 }, { t: "NVDA", ai: 79 }]) !== null);
eq("ai is rounded to 1dp", () => ff({ report: { score: 78.46 } }).ai, 78.5);
eq("ai score 0 → 0, not null (a real zero is data)", () => ff({ report: { score: 0 } }).ai, 0);
eq("ai score null → null", () => ff({ report: { score: null } }).ai, null);
eq("ai score absent → null", () => ff({ report: { ratingId: "neutral" } }).ai, null);
eq('TYPE LAUNDERING: ai score "71" (string) → 71 (rnd coerces)', () => ff({ report: { score: "71" } }).ai, 71);
truthy("a NON-NUMERIC ai score yields NaN, not null — rnd does not validate",
  () => Number.isNaN(ff({ report: { score: "n/a" } }).ai));
truthy("an OBJECT ai score also yields NaN", () => Number.isNaN(ff({ report: { score: {} } }).ai));
truthy("refresh-data-ci.mjs guards that NaN explicitly (`typeof v === 'number' && !isFinite`)",
  () => { const v = ff({ report: { score: "n/a" } }).ai; return typeof v === "number" && !Number.isFinite(v); });

// --- G2. aipt is a DOLLAR TARGET, not a score ---------------------------------------
// Verified against live prices: TER 406 vs px 367.69, AAPL 348 vs 308.91, NVDA 223 vs 200.75.
for (const [aipt, px] of [[406, 367.69], [348, 308.91], [223, 200.75]]) {
  const f = ff({ report: { rating: { priceTarget: { value: aipt } } }, prices: { daily: { priceUSD: px } } });
  eq(`aipt ${aipt} is a dollar target, unscaled`, () => f.aipt, aipt);
  truthy(`aipt ${aipt} is the same order of magnitude as px ${px} — not a 0–100 score`,
    () => f.aipt / f.px > 0.5 && f.aipt / f.px < 3);
}
eq("aipt and ai are read from DIFFERENT report fields and do not cross-contaminate",
  () => { const f = ff({ report: { score: 71, rating: { priceTarget: { value: 406 } } } }); return [f.ai, f.aipt]; }, [71, 406]);
eq("aipt is rounded to 2dp", () => ff({ report: { rating: { priceTarget: { value: 406.129 } } } }).aipt, 406.13);
eq("aipt absent → null", () => ff({ report: { score: 71 } }).aipt, null);
eq("aipt when report.rating is null → null", () => ff({ report: { rating: null } }).aipt, null);
eq("aipt when priceTarget has no value → null", () => ff({ report: { rating: { priceTarget: {} } } }).aipt, null);
eq("aipt value 0 → 0", () => ff({ report: { rating: { priceTarget: { value: 0 } } } }).aipt, 0);

// --- G3. missing / null / empty `report` --------------------------------------------
const AI_TRIO_NULL = { ai: null, air: null, aipt: null };
const trio = (f) => ({ ai: f.ai, air: f.air, aipt: f.aipt });
eq("report ABSENT → ai/air/aipt all null (the ticker stays blank, it is not invented)", () => trio(ff({})), AI_TRIO_NULL);
eq("report null → ai/air/aipt all null (`|| {}` guard, no throw)", () => trio(ff({ report: null })), AI_TRIO_NULL);
eq("report {} → ai/air/aipt all null", () => trio(ff({ report: {} })), AI_TRIO_NULL);
eq("report absent still returns the full 14-key shape (so fillNulls has nothing to fill)",
  () => Object.keys(ff({})).sort(), ["ai", "aipt", "air", "b", "chg", "con", "desc", "h", "n", "pt", "px", "s", "sec", "up"]);
truthy("forecastFields omits `ss` and `mc` entirely — fillNulls therefore cannot touch them",
  () => !("ss" in ff({ report: { score: 1 } })) && !("mc" in ff({ report: { score: 1 } })));
truthy("a report-less payload cannot blank a good row: fillNulls skips its nulls",
  () => fillNulls({ ai: 71, air: "Outperform", aipt: 406 }, ff({})).ai === 71);

// --- G4. bundle selection by `_id` ---------------------------------------------------
const BUNDLE = { models: { stocks: [{ _id: "PEER", report: { score: 11 } }, { _id: "TER", report: { score: 78 } }] } };
eq("the requested ticker is selected by _id, peers are ignored", () => forecastFields(BUNDLE, "TER").ai, 78);
eq("a peer stub in the same bundle does not leak", () => forecastFields(BUNDLE, "PEER").ai, 11);
eq("BUNDLE MISMATCH: a ticker absent from the bundle → {} (not a row of nulls)", () => forecastFields(BUNDLE, "NOPE"), {});
eq("bundle mismatch returns an object with ZERO keys, so fillNulls is a no-op", () => Object.keys(forecastFields(BUNDLE, "NOPE")).length, 0);
eq("a stock with NO _id key is never matched by a real ticker", () => forecastFields({ models: { stocks: [{ report: { score: 5 } }] } }, "TER"), {});
eq("fj null → {}", () => forecastFields(null, "TER"), {});
eq("fj undefined → {}", () => forecastFields(undefined, "TER"), {});
eq("fj {} → {}", () => forecastFields({}, "TER"), {});
eq("fj.models present but stocks absent → {}", () => forecastFields({ models: {} }, "TER"), {});
eq("fj.models.stocks null → {}", () => forecastFields({ models: { stocks: null } }, "TER"), {});
eq("fj.models.stocks empty → {}", () => forecastFields({ models: { stocks: [] } }, "TER"), {});
eq("_id matching is exact and case-sensitive", () => forecastFields(BUNDLE, "ter"), {});
// FIXED: a falsy ticker matched an _id-less stub, grafting one stock's fields onto another.
eq("forecastFields(fj, undefined) → {} (a falsy ticker must match nothing)",
  () => forecastFields({ models: { stocks: [{ report: { score: 5 } }] } }, undefined), {});
eq("forecastFields(fj, '') → {}", () => forecastFields({ models: { stocks: [{ report: { score: 5 } }] } }, ""), {});
// FIXED: `|| []` did not guard a non-array, so `.find` threw. Array.isArray does.
eq("models.stocks as a non-array object → {}, no throw",
  () => forecastFields({ models: { stocks: {} } }, "TER"), {});
eq("models.stocks as a string → {}, no throw", () => forecastFields({ models: { stocks: "x" } }, "TER"), {});
eq("a null row inside stocks is skipped, not dereferenced",
  () => forecastFields({ models: { stocks: [null, { _id: "TER", report: { score: 71 } }] } }, "TER").ai, 71);

// --- G5. the remaining forecastFields mappings ---------------------------------------
eq("n prefers company.name", () => ff({ company: { name: "Teradyne", companyName: "IGNORED" } }).n, "Teradyne");
eq("n falls back to company.companyName", () => ff({ company: { companyName: "CN" } }).n, "CN");
eq("n with company null → null (no prev fallback on this path)", () => ff({ company: null }).n, null);
eq("n absent → null", () => ff({}).n, null);
eq("px prefers prices.daily.priceUSD", () => ff({ prices: { daily: { priceUSD: 333.76, price: 999 } } }).px, 333.76);
eq("px falls back to prices.daily.price", () => ff({ prices: { daily: { price: 12.345 } } }).px, 12.35);
eq("px with prices absent → null", () => ff({}).px, null);
eq("chg converts a fractional gain to a percent, 2dp", () => ff({ prices: { daily: { gain: 0.03538 } } }).chg, 3.54);
eq("chg handles a negative gain", () => ff({ prices: { daily: { gain: -0.0316 } } }).chg, -3.16);
eq("chg gain 0 → 0, not null (a flat day is data)", () => ff({ prices: { daily: { gain: 0 } } }).chg, 0);
eq("chg gain null → null", () => ff({ prices: { daily: { gain: null } } }).chg, null);
eq("chg gain absent → null", () => ff({ prices: { daily: {} } }).chg, null);
eq("pt comes from analystRatings.best.priceTarget.value", () => ff({ analystRatings: { best: { priceTarget: { value: 448.82 } } } }).pt, 448.82);
eq("up converts best.priceTarget.upside to a percent, 1dp", () => ff({ analystRatings: { best: { priceTarget: { upside: 0.3923 } } } }).up, 39.2);
eq("up upside 0 → 0, not null", () => ff({ analystRatings: { best: { priceTarget: { upside: 0 } } } }).up, 0);
eq("up upside absent → null", () => ff({ analystRatings: { best: { priceTarget: {} } } }).up, null);
eq("b/h/s come from best.buy/hold/sell", () => { const f = ff({ analystRatings: { best: { buy: 10, hold: 1, sell: 0 } } }); return [f.b, f.h, f.s]; }, [10, 1, 0]);
eq("b/h/s are undefined (not null) when best is absent — fillNulls skips undefined values",
  () => { const f = ff({}); return [f.b, f.h, f.s]; }, [undefined, undefined, undefined]);
eq("desc comes from company.description", () => ff({ company: { description: "d" } }).desc, "d");
eq("desc absent → null", () => ff({}).desc, null);
eq("sec is mapped through sectorName", () => ff({ company: { sector: "consumerCyclical" } }).sec, "ConsumerCyclical");
eq("an unknown sector slug → null (never a made-up sector)", () => ff({ company: { sector: "quantum" } }).sec, null);

// =====================================================================================
// H. airName — real slug vocabulary is outperform / neutral / underperform
// =====================================================================================
eq('airName("outperform") → "Outperform"', () => airName("outperform"), "Outperform");
eq('airName("neutral") → "Neutral"', () => airName("neutral"), "Neutral");
eq('airName("underperform") → "Underperform"', () => airName("underperform"), "Underperform");
eq("airName leaves an already-capitalised value alone", () => airName("Outperform"), "Outperform");
eq("airName only touches the FIRST character — the rest of the slug is preserved verbatim", () => airName("outPerform"), "OutPerform");
// MALFORMED OUTPUT — documented, not endorsed. airName capitalises character 0 only, so a
// multi-word slug keeps its separator and its lower-case second word. If TipRanks ever emits
// one, the app renders "Strong_buy" / "Strong buy" — neither is in the AI-rating vocabulary.
// FIXED: airName upper-cased character 0 only, so a multi-word ratingId shipped
// "Strong_buy" — in neither the app's AI-rating vocabulary nor a valid display string.
// Each word is now title-cased and separators normalise to a single space.
eq('airName("strong_buy") → "Strong Buy"', () => airName("strong_buy"), "Strong Buy");
eq('airName("strong buy") → "Strong Buy"', () => airName("strong buy"), "Strong Buy");
eq('airName("strong-buy") → "Strong Buy"', () => airName("strong-buy"), "Strong Buy");
eq('airName("  outperform  ") trims', () => airName("  outperform  "), "Outperform");
eq('airName("_") → null (no words)', () => airName("_"), null);
truthy("MALFORMED: unlike sectorName, airName does NOT normalise separators away",
  () => airName("strong_buy") !== "StrongBuy" && sectorName("real-estate") === "RealEstate");
eq('airName("") → null (empty is falsy, treated as no rating)', () => airName(""), null);
eq("airName(null) → null", () => airName(null), null);
eq("airName(undefined) → null", () => airName(undefined), null);
eq("airName(0) → null (falsy guard, not a nullish one)", () => airName(0), null);
eq('airName(false) → null', () => airName(false), null);
eq('airName of a single character', () => airName("o"), "O");
eq("airName coerces a non-string: 5 → \"5\"", () => airName(5), "5");
eq("airName on an already-uppercase acronym is unchanged", () => airName("AI"), "AI");
eq("airName is used for `air` in forecastFields", () => ff({ report: { ratingId: "outperform" } }).air, "Outperform");
eq("air with ratingId absent → null", () => ff({ report: { score: 1 } }).air, null);
eq("air with ratingId null → null", () => ff({ report: { ratingId: null } }).air, null);
eq("air with ratingId '' → null", () => ff({ report: { ratingId: "" } }).air, null);

// =====================================================================================
// I2. rndPx — price precision. A flat 2dp silently ANNIHILATES a sub-penny quote
// (0.0034 -> 0, which fmtPx renders "$0.00"), and 42 of 351 shipped rows are under $1.
// The $1 switch point is the contract: 4dp below, 2dp at-or-above.
// =====================================================================================
eq("a sub-penny price survives at 4dp instead of rounding to 0", () => rndPx(0.0034), 0.0034);
eq("a sub-penny price is never 0", () => rndPx(0.0001) !== 0, true);
eq("the real cheapest shipped row is untouched", () => rndPx(0.17), 0.17);
eq("just under $1 keeps 4dp", () => rndPx(0.9999), 0.9999);
eq("below $1, the 5th decimal still rounds", () => rndPx(0.00005), 0.0001);
// at and above $1 it must stay 2dp — cents are the right precision for a real quote, and
// widening it here would churn every price in stocks.json on the next run
eq("exactly $1 switches to 2dp", () => rndPx(1), 1);
eq("$1 and a fraction rounds to cents", () => rndPx(1.23456), 1.23);
eq("a normal quote rounds to cents", () => rndPx(367.6912), 367.69);
eq("a large quote rounds to cents", () => rndPx(1234.5678), 1234.57);
// null/absent propagates — every px writer feeds this an optional field
eq("null in, null out", () => rndPx(null), null);
eq("undefined in, null out", () => rndPx(undefined), null);
// 0 is a value, not an absence: a nullish test, not a falsy one
eq("0 stays 0 rather than becoming null", () => rndPx(0), 0);
// negatives are nonsense for a price but must not silently flip branch on Number(x) < 1
eq("a negative price takes the 4dp branch, not a throw", () => rndPx(-0.5), -0.5);
// numeric strings: the payloads are unvalidated, so coercion has to be deliberate
eq('the string "0.0034" coerces and keeps 4dp', () => rndPx("0.0034"), 0.0034);
eq('the string "367.6912" coerces to cents', () => rndPx("367.6912"), 367.69);
// and the mappers must actually USE it — this is the regression that motivated the export
eq("rowFromGetData rounds a sub-penny last price at 4dp",
  () => rowFromGetData({ ticker: "PENNY", prices: [{ p: 0.0034 }] }, {}).px, 0.0034);
eq("forecastFields rounds a sub-penny daily price at 4dp",
  () => forecastFields({ models: { stocks: [{ _id: "P", prices: { daily: { priceUSD: 0.0034 } } }] } }, "P").px, 0.0034);

// =====================================================================================
// I. sectorName — slug → the app's PascalCase sector, matched by normalising both sides
// =====================================================================================
const APP_SECTORS = ["BasicMaterials", "CommunicationServices", "ConsumerCyclical", "ConsumerDefensive",
  "Energy", "Financial", "General", "Healthcare", "Industrials", "RealEstate", "Technology", "Utilities"];
for (const s of APP_SECTORS) {
  eq(`sectorName round-trips "${s}" through its own lower-case form`, () => sectorName(s.toLowerCase()), s);
  eq(`sectorName is idempotent on "${s}"`, () => sectorName(s), s);
}
eq("sectorName maps the camelCase slug the forecast payload actually sends", () => sectorName("consumerCyclical"), "ConsumerCyclical");
eq("sectorName is case-insensitive (SHOUTING)", () => sectorName("TECHNOLOGY"), "Technology");
eq("sectorName is case-insensitive (mIxEd)", () => sectorName("tEcHnOlOgY"), "Technology");
eq("sectorName strips interior whitespace", () => sectorName("Real Estate"), "RealEstate");
eq("sectorName strips leading/trailing whitespace", () => sectorName("  technology  "), "Technology");
eq("sectorName strips hyphens", () => sectorName("real-estate"), "RealEstate");
eq("sectorName strips ampersands and slashes", () => sectorName("Basic&Materials"), "BasicMaterials");
eq("sectorName strips underscores", () => sectorName("communication_services"), "CommunicationServices");
eq("sectorName on an UNKNOWN sector → null, never a guess", () => sectorName("cryptocurrency"), null);
eq("sectorName on a near-miss → null (no fuzzy matching)", () => sectorName("tech"), null);
eq('sectorName("") → null', () => sectorName(""), null);
eq("sectorName(null) → null", () => sectorName(null), null);
eq("sectorName(undefined) → null", () => sectorName(undefined), null);
eq("sectorName(0) → null", () => sectorName(0), null);
eq("sectorName of a number → null (coerced, then unmatched)", () => sectorName(123), null);
eq("sectorName of a pure-punctuation slug → null (normalises to empty)", () => sectorName("---"), null);
eq("sectorName never returns undefined — the `?? null` is load-bearing for fillNulls", () => sectorName("nope"), null);

// =====================================================================================
// J. fillNulls — fills blanks only, and NEVER overwrites. This is precisely why the two
//    0–10 rows could not self-heal: 7.8 is non-null, so the correct 71 was refused.
//    refresh-data-ci.mjs therefore overwrites ai/air/aipt/chg explicitly after this call.
// =====================================================================================
eq("fillNulls fills a null", () => fillNulls({ ai: null }, { ai: 78 }), { ai: 78 });
eq("fillNulls fills an undefined value", () => fillNulls({ ai: undefined }, { ai: 78 }), { ai: 78 });
eq("fillNulls ADDS a key the row does not have", () => fillNulls({}, { sec: "Energy" }), { sec: "Energy" });
eq("fillNulls does NOT overwrite a non-null value", () => fillNulls({ sec: "Energy" }, { sec: "Technology" }), { sec: "Energy" });
eq("fillNulls REFUSES to correct a wrong-but-non-null ai — this is why 7.8 stayed 7.8", () => fillNulls({ ai: 7.8 }, { ai: 71 }), { ai: 7.8 });
eq("fillNulls skips a null in `extra` (a blank source cannot blank a good row)", () => fillNulls({ ss: 6 }, { ss: null }), { ss: 6 });
eq("fillNulls skips an undefined in `extra`", () => fillNulls({ ai: null }, { ai: undefined }), { ai: null });
eq("fillNulls cannot fill a null from a null", () => fillNulls({ ai: null }, { ai: null }), { ai: null });
eq("0 is a legitimate value and must NOT be treated as blank", () => fillNulls({ chg: 0 }, { chg: 3.54 }), { chg: 0 });
eq('"" is a legitimate value and must NOT be treated as blank', () => fillNulls({ desc: "" }, { desc: "real" }), { desc: "" });
eq("false is a legitimate value and must NOT be treated as blank", () => fillNulls({ flag: false }, { flag: true }), { flag: false });
eq("NaN is non-null, so fillNulls refuses to replace it", () => { const r = fillNulls({ ai: NaN }, { ai: 71 }); return Number.isNaN(r.ai); }, true);
eq("a 0 in `extra` DOES fill a null (0 != null)", () => fillNulls({ chg: null }, { chg: 0 }), { chg: 0 });
eq('an "" in `extra` DOES fill a null', () => fillNulls({ desc: null }, { desc: "" }), { desc: "" });
eq("a false in `extra` DOES fill a null", () => fillNulls({ flag: null }, { flag: false }), { flag: false });
eq("fillNulls with a null `extra` is a no-op", () => fillNulls({ ai: null }, null), { ai: null });
eq("fillNulls with an undefined `extra` is a no-op", () => fillNulls({ ai: null }, undefined), { ai: null });
eq("fillNulls with an empty `extra` is a no-op", () => fillNulls({ ai: null }, {}), { ai: null });
truthy("fillNulls returns the SAME row object (callers rely on mutation in place)",
  () => { const row = { ai: null }; return fillNulls(row, { ai: 1 }) === row; });
truthy("fillNulls does not mutate `extra`",
  () => { const extra = { ai: 78 }; fillNulls({ ai: null }, extra); return Object.keys(extra).length === 1 && extra.ai === 78; });
eq("a mixed row: blanks filled, real values kept, extra's nulls ignored",
  () => fillNulls({ ai: null, sec: "Energy", ss: 6, chg: 0 }, { ai: 78, sec: "Technology", ss: null, chg: 9.9, mc: 500 }),
  { ai: 78, sec: "Energy", ss: 6, chg: 0, mc: 500 });
eq("the real enrich composition: fillNulls(rowFromGetData(...), forecastFields(...))", () => {
  const row = rowFromGetData({ ticker: "TER", prices: [{ p: 367.69 }] }, {});   // keep-path row: no ai/sec
  fillNulls(row, ff({ company: { sector: "technology" }, report: { score: 71, ratingId: "outperform" } }, "TER"));
  return [row.t, row.px, row.sec, row.ai, row.air];
}, ["TER", 367.69, "Technology", 71, "Outperform"]);
eq("fillNulls cannot repair a CARRIED stale ai — only the explicit overwrite can", () => {
  const row = rowFromGetData({ ticker: "TER" }, { ai: 44, air: "Underperform" });  // carried, non-null
  fillNulls(row, ff({ report: { score: 71, ratingId: "outperform" } }, "TER"));
  return [row.ai, row.air];                                                        // still stale
}, [44, "Underperform"]);

// =====================================================================================
// K. aiScaleError — the guard that makes the ÷10 class of bug un-shippable
// =====================================================================================
const rowsOf = (...ai) => ai.map((v, i) => ({ t: `T${i}`, ai: v }));
const rep = (n, ai) => Array.from({ length: n }, (_, i) => ({ t: `T${i}`, ai }));

// --- K1. the mixing signature -------------------------------------------------------
const mixed = aiScaleError([{ t: "TER", ai: 7.8 }, { t: "AAPL", ai: 8.2 }, { t: "NVDA", ai: 79 }]);
truthy("MIXING: two scales in one column is caught", () => mixed !== null);
truthy("MIXING: the message NAMES every offender with its value", () => mixed.includes("TER=7.8") && mixed.includes("AAPL=8.2"));
truthy("MIXING: the message does not name the innocent rows", () => !mixed.includes("NVDA"));
truthy("MIXING: the message reports the healthy span", () => mixed.includes("79–79"));
truthy("MIXING: the message reports the offender count", () => mixed.includes("2/3"));
truthy("MIXING: the message points at the code to fix", () => mixed.includes("ci/keep.mjs"));
truthy("MIXING: a single ÷10 row among many 0–100 rows is caught (the real bug's shape — 2 of 344)",
  () => { const rows = [...rep(340, 60), { t: "TER", ai: 7.1 }]; const e = aiScaleError(rows); return e !== null && e.includes("TER=7.1"); });
truthy("MIXING: 1 offender in a sample of only 2 is caught (no sample-size floor on this arm)",
  () => aiScaleError([{ t: "A", ai: 7 }, { t: "B", ai: 70 }]) !== null);
truthy("MIXING: nulls do not count towards the offender tally",
  () => aiScaleError([{ t: "A", ai: 7 }, { t: "B", ai: 70 }, { t: "C", ai: null }]).includes("1/2"));

// --- K2. the all-low signature and the sample-size boundary -------------------------
const MIN_SAMPLE = 20;  // AI_SCALE_MIN_SAMPLE is module-private; pinned here by behaviour
eq(`all-low with ${MIN_SAMPLE - 1} rows → no verdict (too small a sample to prove anything)`, () => aiScaleError(rep(MIN_SAMPLE - 1, 5)), null);
truthy(`all-low with exactly ${MIN_SAMPLE} rows → CAUGHT (the sample-size cliff)`, () => aiScaleError(rep(MIN_SAMPLE, 5)) !== null);
truthy("all-low message says the whole column looks 0–10 and reports the max",
  () => { const e = aiScaleError(rep(MIN_SAMPLE, 5)); return e.includes("entirely 0–10") && e.includes("max 5"); });
eq("a SINGLE low row is never a verdict on its own", () => aiScaleError([{ t: "A", ai: 7.8 }]), null);
truthy("a whole column rescaled to 0–10 across a realistic sample is caught",
  () => aiScaleError(Array.from({ length: 344 }, (_, i) => ({ t: `T${i}`, ai: 3.9 + (i % 47) / 10 }))) !== null);
truthy("an all-low column with fewer than the sample floor of SCORED rows escapes",
  () => aiScaleError([...rep(19, 5), ...rep(1, null)].map((r, i) => ({ ...r, t: `T${i}` }))) === null);

// --- K3. the AI_SCALE_FLOOR boundary ------------------------------------------------
truthy(`exactly AI_SCALE_FLOOR (${AI_SCALE_FLOOR}) counts as LOW — the comparison is <=`,
  () => { const e = aiScaleError([{ t: "A", ai: AI_SCALE_FLOOR }, { t: "B", ai: 70 }]); return e !== null && e.includes("A=10"); });
eq("just above the floor is HIGH and does not trip", () => aiScaleError([{ t: "A", ai: AI_SCALE_FLOOR + 0.0001 }, { t: "B", ai: 70 }]), null);
truthy("a column entirely AT the floor over a large sample is caught", () => aiScaleError(rep(MIN_SAMPLE, AI_SCALE_FLOOR)) !== null);
eq("all rows above the floor → no verdict, whatever the spread", () => aiScaleError(rep(MIN_SAMPLE, AI_SCALE_FLOOR + 1)), null);

// --- K4. legitimate wide spreads must NOT trip -------------------------------------
eq("a uniform 0–100 column is fine", () => aiScaleError([{ t: "A", ai: 71 }, { t: "B", ai: 46 }, { t: "C", ai: null }]), null);
eq("the live spread 39–85 is fine", () => aiScaleError(rowsOf(39, 41, 55, 60, 71, 75, 79, 85)), null);
eq("a wide spread 11 → 85 is fine (no max/min ratio test — ratio 7.7)", () => aiScaleError(rowsOf(11, 85)), null);
eq("an extreme-but-single-scale spread 10.5 → 99 is fine (ratio 9.4)", () => aiScaleError(rowsOf(10.5, 99)), null);
eq("a column of exactly 100s is fine", () => aiScaleError(rep(MIN_SAMPLE, 100)), null);
eq("a large healthy column is fine", () => aiScaleError(Array.from({ length: 344 }, (_, i) => ({ t: `T${i}`, ai: 39 + (i % 47) }))), null);

// --- K5. an emptied column ---------------------------------------------------------
truthy("an entirely wiped ai column is caught, not reported OK", () => aiScaleError(rep(351, null)) !== null);
truthy("the emptied-column message counts the missing rows", () => aiScaleError(rep(351, null)).includes("351/351"));
truthy("the emptied-column message blames the mapping, not TipRanks",
  () => aiScaleError(rep(351, null)).includes("mapping broke"));
const halfNull = (total, nulls) => Array.from({ length: total }, (_, i) => ({ t: `T${i}`, ai: i < nulls ? null : 50 }));
eq("exactly HALF the column scored → no verdict (the test is `scored < total * 0.5`)", () => aiScaleError(halfNull(20, 10)), null);
truthy("one row below half → CAUGHT", () => aiScaleError(halfNull(20, 11)) !== null);
eq(`a fully wiped column of only ${MIN_SAMPLE - 1} rows escapes the emptied-column arm`, () => aiScaleError(rep(MIN_SAMPLE - 1, null)), null);
eq("the normal ~7-of-351 genuinely-unscored rows are fine", () => aiScaleError(halfNull(351, 7)), null);
truthy("a NaN ai counts as MISSING, not as a low score", () => aiScaleError(rep(MIN_SAMPLE, NaN)).includes("missing"));
truthy("a non-numeric ai string counts as missing", () => aiScaleError(rep(MIN_SAMPLE, "n/a")).includes("missing"));
truthy("an Infinity ai counts as missing (Number.isFinite gate)", () => aiScaleError(rep(MIN_SAMPLE, Infinity)).includes("missing"));

// --- K6. degenerate input ---------------------------------------------------------
eq("no rows → no verdict", () => aiScaleError([]), null);
eq("null rows → no verdict", () => aiScaleError(null), null);
eq("undefined rows → no verdict", () => aiScaleError(undefined), null);
eq("null/undefined ELEMENTS are skipped, not dereferenced", () => aiScaleError([null, { t: "A", ai: 70 }, undefined]), null);
truthy("a row with no `t` is reported as `?`", () => aiScaleError([{ ai: 7 }, { ai: 70 }]).includes("?=7"));
truthy('TYPE LAUNDERING: a string ai "7" is scored and flagged as low',
  () => aiScaleError([{ t: "A", ai: "7" }, { t: "B", ai: "50" }]) !== null);
truthy("a boolean ai coerces to 1 and is flagged as low", () => aiScaleError([{ t: "A", ai: true }, { t: "B", ai: 70 }]) !== null);
truthy("a negative ai is flagged as low", () => aiScaleError([{ t: "A", ai: -5 }, { t: "B", ai: 70 }]) !== null);

// --- K7. the `floor` parameter — a FOOTGUN, documented by test --------------------
// The parameter reads like a knob for strictness, but it is the LOW/HIGH split point, so
// LOWERING it moves offenders into the "high" bucket and SILENCES the guard. Only raising
// it tightens. A caller reaching for `aiScaleError(rows, 5)` to "be careful" disables the
// check on exactly the values it was built to catch.
const REAL_BUG = [{ t: "TER", ai: 7.8 }, { t: "AAPL", ai: 8.2 }, { t: "NVDA", ai: 79 }];
truthy("floor at the default catches the real bug", () => aiScaleError(REAL_BUG) !== null);
truthy("floor 20 (RAISED) still catches it — raising tightens", () => aiScaleError(REAL_BUG, 20) !== null);
eq("FOOTGUN: floor 5 (LOWERED) SILENCES the guard — 7.8 and 8.2 become 'high'", () => aiScaleError(REAL_BUG, 5), null);
eq("FOOTGUN: floor 0 silences it completely", () => aiScaleError(REAL_BUG, 0), null);
eq("FOOTGUN: floor 100 also silences it (everything is low, and 3 < the sample floor)", () => aiScaleError(REAL_BUG, 100), null);
truthy("floor 100 over a large sample flips to the all-low verdict instead", () => aiScaleError(rep(MIN_SAMPLE, 50), 100) !== null);
truthy("FOOTGUN: a lowered floor lets a genuine 0–10 column through as long as it clears the new split",
  () => aiScaleError(rep(MIN_SAMPLE, 9), 5) === null);
eq("the floor is reported in the message so a non-default is visible", () => aiScaleError(REAL_BUG, 20).includes("≤ 20"), true);

// =====================================================================================
// report
// =====================================================================================
if (fails.length) {
  console.error(`FAIL ci/test-keep.mjs — ${fails.length}/${checks} assertion(s) failed:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`keep OK — ${checks} assertions across ${Object.keys(EXPECTED_EXPORTS).length} exports (mapping, consensus vocab, slug names, fillNulls, ai-scale guard, keep/expiry)`);
