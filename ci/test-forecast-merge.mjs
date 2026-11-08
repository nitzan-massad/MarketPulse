// Self-check for the SSR/JSON merge. Run: node ci/test-forecast-merge.mjs
// No network, no filesystem. Imports the real functions — ci/forecast-merge.mjs is pure and
// import-safe precisely so this file does not have to mirror them the way
// ci/test-forecast-gate.mjs had to mirror the old inline gate.
import assert from "node:assert/strict";
import { carryForward, forecastsFromPayload, keepPrevTarget, mergeForecasts, mergeKey, pickSource, shouldFetchPage } from "./forecast-merge.mjs";

const row = (n, d, pt, extra = {}) => ({ n, f: n + " & Co", st: null, r: "Buy", pt, opt: null, d, ...extra });

/* ------------------------------------------------------------------ the gate */
{
  const some = [row("A", "2026-07-01", 10)];
  // merge on: always fetch, whatever the JSON path returned
  for (const fc of [[], some])
    for (const filtered of [0, 4, 194, undefined, null])
      assert.equal(shouldFetchPage(fc, { expertRatingsFilteredCount: filtered }, true), true,
        `merge on must always fetch (rows=${fc.length}, filtered=${filtered})`);

  // merge off: the legacy fallback, byte-for-byte. SSR_MERGE=0 has to be a true rollback.
  assert.equal(shouldFetchPage([], { expertRatingsFilteredCount: 4 }, false), true, "off: empty + withheld -> fetch");
  assert.equal(shouldFetchPage([], { expertRatingsFilteredCount: 0 }, false), false, "off: empty + nothing withheld -> skip");
  assert.equal(shouldFetchPage(some, { expertRatingsFilteredCount: 4 }, false), false, "off: JSON had rows -> skip");
  assert.equal(shouldFetchPage([], {}, false), false, "off: absent filteredCount -> skip");
  assert.equal(shouldFetchPage([], undefined, false), false, "off: absent payload must not throw");
}

/* ------------------------------------------------- THE GUARDRAIL: never subtract */
{
  const json = [row("A", "2026-07-01", 10), row("B", "2026-06-01", 20), row("C", "2026-05-01", 30)];
  // A truncated FlareSolverr read parses to a valid PREFIX. Under union that can only shrink
  // the gain. This is the property that replaced the plan's row-count sanity check.
  for (const ssr of [[], null, undefined, [row("A", "2026-07-01", 10)]]) {
    const out = mergeForecasts(ssr, json);
    assert.ok(out.length >= json.length, `ssr=${JSON.stringify(ssr)}: merge must never lose rows`);
    for (const j of json)
      assert.ok(out.some((o) => mergeKey(o) === mergeKey(j)), `ssr=${JSON.stringify(ssr)}: lost ${j.n}`);
  }
  assert.deepEqual(mergeForecasts([], json), json, "SSR parsing to nothing leaves JSON untouched");
  assert.deepEqual(mergeForecasts([], []), [], "both empty -> []");
  assert.deepEqual(mergeForecasts(null, null), [], "both absent -> [] , never a throw");
}

/* ---------------------------------------------------------------- the union */
{
  const ssrOnly = row("Fresh", "2026-08-20", 50);
  const shared = row("Both", "2026-07-15", 12);
  const jsonOnly = row("Deep", "2025-11-01", 7);
  const out = mergeForecasts([ssrOnly, shared], [shared, jsonOnly]);
  assert.equal(out.length, 3, "union is ssr-only + shared + json-only, shared counted once");
  assert.deepEqual(out.map((f) => f.n), ["Fresh", "Both", "Deep"], "sorted newest first");
}

/* -------------------------------------------- dedup is name|date, not firm|date */
{
  // Two analysts at one firm on one date: firm|date would collapse them, name|date must not.
  const a = { n: "Ann", f: "BigBank", st: null, r: "Buy", pt: 10, opt: null, d: "2026-08-01" };
  const b = { n: "Bob", f: "BigBank", st: null, r: "Hold", pt: 9, opt: null, d: "2026-08-01" };
  assert.equal(mergeForecasts([a, b], []).length, 2, "same firm + date, different analyst = two rows");
  // Same analyst, two dates: two ratings, both kept; stars carried to the page row by name.
  assert.deepEqual(mergeForecasts([row("Ann", "2026-08-01", 10)], [row("Ann", "2026-06-01", 8, { st: 4.2 })]),
    [row("Ann", "2026-08-01", 10, { st: 4.2 }), row("Ann", "2026-06-01", 8, { st: 4.2 })], "different dates = two rows");
  // Case and whitespace must not create a phantom duplicate.
  assert.equal(mergeForecasts([row("Ann", "2026-08-01", 10)], [row(" ann ", "2026-08-01", 99)]).length, 1,
    "name matching is case- and space-insensitive");
  // The page renders the analyst twice per row (avatar + name); a duplicate must collapse.
  assert.equal(mergeForecasts([row("Ann", "2026-08-01", 10), row("Ann", "2026-08-01", 10)], []).length, 1);
}

/* ------------------------------------------------------------- precedence */
{
  const ssr = { n: "Ann", f: "SSR Firm", st: null, r: "Buy", pt: 44, opt: 40, d: "2026-08-01" };
  const jsn = { n: "Ann", f: "JSON Firm", st: 4.6, r: "Hold", pt: 11, opt: null, d: "2026-08-01" };
  const [m] = mergeForecasts([ssr], [jsn]);
  assert.equal(m.pt, 44, "pt: SSR wins — the JSON copy is nulled for anonymized rows");
  assert.equal(m.opt, 40, "opt: SSR wins");
  assert.equal(m.f, "SSR Firm", "f: SSR wins, so a row stays internally consistent");
  assert.equal(m.r, "Buy", "r: SSR wins");
  assert.equal(m.st, 4.6, "st: JSON wins — SSR does not render stars");
  // A star already joined by withStars must not be overwritten by the JSON one.
  const [m2] = mergeForecasts([{ ...ssr, st: 3.1 }], [jsn]);
  assert.equal(m2.st, 3.1, "an SSR row that already has stars keeps them");
  // No JSON counterpart -> stars stay null rather than borrowing another row's.
  const [m3] = mergeForecasts([ssr], [row("Someone Else", "2026-08-01", 5, { st: 5 })]);
  assert.equal(m3.st, null, "stars are never borrowed across analysts");
}

/* ------------------------------------- anonymized rows never join on their own */
{
  // This is what an anonymized payload row looks like after toForecasts would have dropped it:
  // no name, no target. If one ever reaches the merge it must not become a visible row.
  const anon = { n: null, f: "Hidden Bank", st: 4, r: "Buy", pt: null, opt: null, d: "2026-08-19" };
  assert.deepEqual(mergeForecasts([], [anon]), [], "a nameless JSON row is not a forecast");
  assert.deepEqual(mergeForecasts([anon], []), [], "a nameless SSR row is a parse artefact");
  const real = row("Ann", "2026-08-01", 10);
  assert.deepEqual(mergeForecasts([real], [anon]), [real], "it does not pollute a good merge");
}

/* ------------------------------------------------------ the BIOA regression */
{
  // The bug that motivated the plan, at its real numbers: 9 real broker ratings exist, the
  // API teaser let 2 through, the old `!fc.length` gate never fired because 2 > 0.
  const json = [row("Thomas Shrader", "2026-08-05", 40, { st: 4.6 }), row("Roger Song", "2026-07-31", 21, { st: 3.8 })];
  const ssr = [
    row("Thomas Shrader", "2026-08-05", 40), row("Roger Song", "2026-07-31", 21),
    row("A N Other", "2026-08-07", 25), row("B Broker", "2026-08-07", 20),
    row("C Broker", "2026-08-06", 73), row("D Broker", "2026-08-06", 35),
    row("E Broker", "2026-08-06", 50), row("F Broker", "2026-08-06", 21),
    row("G Broker", "2026-08-04", 30),
  ];
  const out = mergeForecasts(ssr, json);
  assert.equal(out.length, 9, "all 9 real broker ratings survive the merge");
  assert.equal(out[0].d, "2026-08-07", "the freshest rating is now the top row");
  assert.equal(out.find((f) => f.n === "Thomas Shrader").st, 4.6, "stars carried from the JSON path");
  assert.ok(out.length > json.length, "and it is strictly more than the API alone gave us");
}

/* ------------------------------------- stock-forecast/payload.json -> Forecast[] */
{
  // Shape verified on the live MA payload, 2026-11-07 (46 ratings, 91 experts).
  const fj = { models: {
    experts: [
      { _id: "u1", name: "Owen Lau", firm: "Clear Street" },
      { _id: "u2", name: "Unknown Analyst", firm: "Deutsche Bank " },
      { _id: "u3", name: "Unknown Analyst", firm: "Argus" },
      { _id: "ai", name: "OpenAI Financial - Credit Services", firm: "TipRanks - OpenAI" },
      { _id: "u4", name: "No Target", firm: "DZ BANK" },
    ],
    ratings: [
      { object: { ticker: "MA" }, expert: { uid: "u1" }, date: "2026-10-30T00:00:00.000Z", position: "buy", priceTarget: { value: 732 }, oldPriceTarget: 729 },
      { object: { ticker: "MA" }, expert: { uid: "u2" }, date: "2026-10-15T00:00:00.000Z", position: "buy", priceTarget: { value: 668 } },
      { object: { ticker: "MA" }, expert: { uid: "u3" }, date: "2026-10-15T00:00:00.000Z", position: "hold", priceTarget: { value: 600 } },
      { object: { ticker: "MA" }, expert: { uid: "ai" }, date: "2026-10-29T00:00:00.000Z", position: "buy", priceTarget: { value: 699 } },
      { object: { ticker: "MA" }, expert: { uid: "u4" }, date: "2026-11-03T00:00:00.000Z", position: "sell", priceTarget: null },
      { object: { ticker: "MA" }, expert: { uid: "missing" }, date: "2026-10-01T00:00:00.000Z", position: "buy", priceTarget: { value: 1 } },
      { object: { ticker: "V" }, expert: { uid: "u1" }, date: "2026-10-30T00:00:00.000Z", position: "buy", priceTarget: { value: 400 } },
    ],
  } };
  const rows = forecastsFromPayload(fj, "MA");
  assert.deepEqual(rows, [
    { n: "Owen Lau", f: "Clear Street", r: "Buy", pt: 732, opt: 729, d: "2026-10-30" },
    { n: "Unknown Analyst", f: "Deutsche Bank", r: "Buy", pt: 668, opt: null, d: "2026-10-15" },
    { n: "Unknown Analyst", f: "Argus", r: "Hold", pt: 600, opt: null, d: "2026-10-15" },
  ], "named + unranked rows kept; AI, no-target, orphan and peer-ticker rows dropped; firm trimmed");
  assert.equal(forecastsFromPayload({}, "MA"), null, "reshaped payload -> null (caller falls back to the page)");
  // AMD 2026-11-04: the payload's PROFILE firm is where the analyst works now; getData's per-rating
  // firm (joined on eUid, anonymized experts included) wins.
  const amd = { models: {
    experts: [{ _id: "oc", name: "David O'Connor", firm: "Exane BNP Paribas" }, { _id: "ml", name: "Mark Lear", firm: "Piper Sandler" }, { _id: "zz", name: "Not In GetData", firm: "Profile Firm" }],
    ratings: [
      { object: { ticker: "AMD" }, expert: { uid: "oc" }, date: "2026-11-04T00:00:00.000Z", position: "buy", priceTarget: { value: 650 } },
      { object: { ticker: "AMD" }, expert: { uid: "ml" }, date: "2026-11-06T00:00:00.000Z", position: "buy", priceTarget: { value: 61 } },
      { object: { ticker: "AMD" }, expert: { uid: "zz" }, date: "2026-11-01T00:00:00.000Z", position: "buy", priceTarget: { value: 5 } },
    ],
  } };
  const gd = { experts: [{ name: "David O'Connor", firm: "Piper Sandler", eUid: "oc" }, { name: null, firm: "Scotiabank ", eUid: "ml" }] };
  assert.deepEqual(forecastsFromPayload(amd, "AMD", gd).map((r) => r.f), ["Piper Sandler", "Scotiabank", "Profile Firm"],
    "getData firm (named or anonymized) beats the payload profile firm; unknown experts keep the profile firm");
  assert.equal(forecastsFromPayload(null, "MA"), null);
  // two Unknown Analysts on one date are two ratings, not a duplicate
  assert.equal(mergeForecasts(rows, []).length, 3, "Unknown Analysts at different firms must not collapse");
  assert.notEqual(mergeKey(rows[1]), mergeKey(rows[2]));
  assert.equal(mergeKey({ n: "Owen Lau", f: "X", d: "2026-10-30" }), mergeKey({ n: "owen lau ", f: "Y", d: "2026-10-30" }),
    "named analysts still key on name|date only");
}

/* ------------------------------------------ carryForward: keep what we recovered */
{
  // AMD 2026-11-04: Mizuho's rating is anonymized in getData and fell below the page's ~15 rows.
  const prev = [
    { n: "Vijay Rakesh", f: "Mizuho", st: 4.2, r: "Buy", pt: 610, opt: 500, d: "2026-11-04" },
    { n: "Old Rating", f: "Gone & Co", st: 3, r: "Buy", pt: 100, opt: null, d: "2026-08-01" },
    { n: "Superseded", f: "Newer Co", st: 3, r: "Buy", pt: 90, opt: null, d: "2026-10-01" },
  ];
  const data = { experts: [
    { name: null, firm: "Mizuho", ratings: [{ date: "2026-11-04T00:00:00" }] },
    { name: null, firm: "Newer Co", ratings: [{ date: "2026-10-01T00:00:00" }] },
    { name: null, aiModel: true, firm: "TipRanks - OpenAI", ratings: [{ date: "2026-11-04T00:00:00" }] },
  ] };
  const now = [{ n: "Superseded", f: "Newer Co", st: 3, r: "Buy", pt: 95, opt: 90, d: "2026-11-05" }];
  const out = carryForward(now, prev, data);
  assert.deepEqual(out.map((f) => `${f.n}|${f.d}`), ["Superseded|2026-11-05", "Vijay Rakesh|2026-11-04"],
    "hidden-and-current row carried; expired and superseded rows stay gone; newest first");
  assert.deepEqual(carryForward(now, prev, { experts: [] }), now, "nothing hidden -> nothing carried");
  assert.deepEqual(carryForward(now, null, data), now, "no previous file -> unchanged");
  // already covered (same firm+date in this run) -> not duplicated
  const covered = [{ n: "V. Rakesh", f: "Mizuho ", st: null, r: "Buy", pt: 610, opt: null, d: "2026-11-04" }];
  assert.equal(carryForward(covered, prev, data).filter((f) => f.f.trim() === "Mizuho").length, 1,
    "a firm+date already in the output is not carried again");
}

/* ------------------------------------------------ FX-stable targets (review alerts) */
{
  // SHOP: the payload converts at today's FX (128.9995); getData's convertedPriceTarget (127.537) is
  // stable — used whenever getData names the same rating on the same date.
  const fj = { models: {
    experts: [{ _id: "dt", name: "Doug Taylor", firm: "Canaccord" }, { _id: "an", name: "Hidden One", firm: "RBC" }],
    ratings: [
      { object: { ticker: "SHOP" }, expert: { uid: "dt" }, date: "2026-10-01T00:00:00.000Z", position: "buy", priceTarget: { value: 128.9995 }, oldPriceTarget: 120.4 },
      { object: { ticker: "SHOP" }, expert: { uid: "an" }, date: "2026-11-05T00:00:00.000Z", position: "buy", priceTarget: { value: 150.12 } },
    ],
  } };
  const data = { experts: [
    { name: "Doug Taylor", firm: "Canaccord", eUid: "dt", ratings: [{ date: "2026-10-01T00:00:00", convertedPriceTarget: 127.537, convertedOldPriceTarget: 119.2 }] },
    { name: null, firm: "RBC", eUid: "an", ratings: [{ date: "2026-11-05T00:00:00", convertedPriceTarget: null }] },
  ] };
  const rows = forecastsFromPayload(fj, "SHOP", data);
  assert.deepEqual(rows.map((r) => [r.pt, r.opt]), [[127.54, 119.2], [150.12, null]],
    "getData's stable converted target wins when it names the rating; an anonymized one keeps the payload's");
  // a stale getData rating (different date) must not lend its target to a newer payload rating
  const stale = { experts: [{ name: "Doug Taylor", firm: "Canaccord", eUid: "dt", ratings: [{ date: "2026-08-01T00:00:00", convertedPriceTarget: 99 }] }] };
  assert.equal(forecastsFromPayload(fj, "SHOP", stale)[0].pt, 129, "another date's target is never borrowed");

  // keepPrevTarget: FX drift under 1% keeps last run's number; a real revision passes through
  const prev = [{ n: "Hidden One", f: "RBC", r: "Buy", pt: 149.5, opt: 140, d: "2026-11-05" }];
  assert.equal(keepPrevTarget([{ ...prev[0], pt: 150.12, opt: null }], prev)[0].pt, 149.5, "0.4% drift -> previous target kept");
  assert.equal(keepPrevTarget([{ ...prev[0], pt: 160 }], prev)[0].pt, 160, "a 7% move is a real revision");
  assert.equal(keepPrevTarget([{ ...prev[0], pt: 150.12, r: "Hold" }], prev)[0].pt, 150.12, "a changed rating is a new review");
  assert.deepEqual(keepPrevTarget(rows, null), rows, "no previous file -> unchanged");
}

/* ----------------------------------------------------- source choice (pickSource) */
{
  const fc = [row("A", "2026-07-01", 10)];
  assert.equal(pickSource([row("B", "2026-11-01", 5)], fc, { expertRatingsFilteredCount: 10 }, true), "payload", "payload rows -> payload");
  assert.equal(pickSource([], fc, { expertRatingsFilteredCount: 0 }, true), "payload", "empty payload, nothing hidden -> payload (no coverage)");
  assert.equal(pickSource([], fc, { expertRatingsFilteredCount: 3 }, true), "page", "empty payload but getData hid rows -> page");
  assert.equal(pickSource(null, fc, { expertRatingsFilteredCount: 0 }, true), "page", "payload failed -> page");
  assert.equal(pickSource([row("B", "2026-11-01", 5)], fc, { expertRatingsFilteredCount: 3 }, false), "none", "SSR_MERGE=0, JSON had rows -> legacy: nothing");
  assert.equal(pickSource(null, [], { expertRatingsFilteredCount: 3 }, false), "page", "SSR_MERGE=0, empty + withheld -> legacy page fallback");
}

{ // invisible bidi marks in a name must not split one analyst into two keys
  const { cleanName } = await import("./forecast-merge.mjs");
  assert.equal(cleanName("Daniel Zhu\u200f"), "Daniel Zhu");
  assert.equal(cleanName("\u200fAvantika Dhabaria\u200f"), "Avantika Dhabaria");
  assert.equal(cleanName("Mohammad\u200cReza"), "Mohammad\u200cReza", "ZWNJ is real spelling, kept");
  assert.equal(cleanName(null), "");
  const m = mergeForecasts([{ n: "Daniel Zhu", f: "Bernstein", r: "Buy", pt: 400, d: "2026-10-25" }],
    [{ n: "Daniel Zhu\u200f", f: "Bernstein", st: 0.2, r: "Buy", pt: 400, d: "2026-10-25" }]);
  assert.equal(m.length, 1, "bidi-marked duplicate collapses");
  assert.equal(m[0].st, 0.2, "star joins across the bidi mark");
}

console.log("ok   forecast merge: gate, additive guarantee, union, dedup, precedence, anonymized rows, BIOA, payload, carry-forward, FX-stable targets, source choice");
