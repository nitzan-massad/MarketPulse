// Self-check for the SSR/JSON merge. Run: node ci/test-forecast-merge.mjs
// No network; reads fixtures only. Imports the real functions — ci/forecast-merge.mjs is pure and
// import-safe precisely so this file does not have to mirror them the way
// ci/test-forecast-gate.mjs had to mirror the old inline gate.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { carryRecentPrev, carryStars, forecastsFromPayload, hiddenTargets, keepNewerPrev, keepPrevRating, latestPerAnalyst, mergeForecasts, mergeKey, missingOf, topUpRows } from "./forecast-merge.mjs";

const row = (n, d, pt, extra = {}) => ({ n, f: n + " & Co", st: null, r: "Buy", pt, opt: null, d, ...extra });

/* ------------------------------------- the page gate: hiddenTargets (payload rating, no target) */
{
  // Samik's newest payload rating (11-15) carries no target; our file has his 10-01 row -> the page may name it.
  const fj = { models: {
    experts: [{ _id: "analyst|1", uid: "s1", name: "Samik Chatterjee", firm: "J.P. Morgan" }, { _id: "analyst|2", uid: "e2", name: "Erik Woodring", firm: "Morgan Stanley" }],
    ratings: [
      { object: { ticker: "AAPL" }, expert: { uid: "s1", id: "analyst|1" }, date: "2026-11-15T00:00:00.000Z", position: "buy", priceTarget: null },
      { object: { ticker: "AAPL" }, expert: { uid: "s1", id: "analyst|1" }, date: "2026-10-01T00:00:00.000Z", position: "buy", priceTarget: { value: 300 } },
      { object: { ticker: "AAPL" }, expert: { uid: "e2", id: "analyst|2" }, date: "2026-11-10T00:00:00.000Z", position: "buy", priceTarget: { value: 310 } },
    ],
  } };
  const file = [row("Samik Chatterjee", "2026-10-01", 300), row("Erik Woodring", "2026-11-10", 310)];
  assert.deepEqual(hiddenTargets(fj, "AAPL", file), ["Samik Chatterjee"], "newest payload rating has no target and is newer than the file row");
  assert.deepEqual(hiddenTargets(fj, "AAPL", [...file, row("Samik Chatterjee", "2026-11-15", 305)]), [], "file already has that date -> no page");
  assert.deepEqual(hiddenTargets(fj, "AAPL", []), [], "no file row -> not needed (no older target the page could add)");
  assert.deepEqual(hiddenTargets(fj, "MSFT", file), [], "another ticker's ratings never count");
  assert.deepEqual(hiddenTargets(null, "AAPL", file), [], "no payload -> nothing (the caller already fetches the page)");
}

/* -------------------------------------------------------------- carryStars */
{
  const prev = [row("Ann", "2026-09-01", 10, { st: 1.3 }), row("Bob", "2026-09-01", 10, { st: 4 })];
  const out = carryStars([row("ann ", "2026-11-01", 12), row("Bob", "2026-11-01", 12, { st: 2.2 }), row("Cy", "2026-11-01", 5)], prev);
  assert.deepEqual(out.map((r) => r.st), [1.3, 2.2, null], "null st filled from prev by analystKey; a set st is left alone; unknown stays null");
  assert.deepEqual(carryStars([row("Ann", "2026-11-01", 12)], null).map((r) => r.st), [null], "no prev -> unchanged");
}

/* -------------------------------------------------------------- carryRecentPrev */
{
  const now = Date.UTC(2026, 10, 18);
  const prev = [row("Recent", "2026-10-19", 10), row("Old", "2026-08-10", 10), row("Present", "2026-10-01", 9)];
  const rows = [row("Present", "2026-11-01", 11)];
  assert.deepEqual(carryRecentPrev(rows, prev, { now }).map((r) => r.n), ["Present", "Recent"], "30-day row kept, 100-day row dropped");
  assert.deepEqual(carryRecentPrev(rows, prev, { now, all: true }).map((r) => r.n), ["Present", "Recent", "Old"], "all:true keeps the 100-day row");
  assert.equal(carryRecentPrev(rows, prev, { now, all: true }).filter((r) => r.n === "Present").length, 1, "never duplicates a present analyst");
  const ua = [{ n: "Unknown Analyst", f: "Argus", r: "Buy", pt: 1, d: "2026-11-01" }];
  assert.equal(carryRecentPrev(ua, [{ n: "Unknown Analyst", f: "DZ Bank", r: "Buy", pt: 2, d: "2026-11-01" }], { now }).length, 2, "Unknown Analyst identity is per firm");
  assert.deepEqual(carryRecentPrev(rows, null, { now }), rows, "no prev -> unchanged");
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
    { n: "Owen Lau", f: "Clear Street", r: "Buy", pt: 732, opt: 729, d: "2026-10-30", st: null },
    { n: "Unknown Analyst", f: "Deutsche Bank", r: "Buy", pt: 668, opt: null, d: "2026-10-15", st: null },
    { n: "Unknown Analyst", f: "Argus", r: "Hold", pt: 600, opt: null, d: "2026-10-15", st: null },
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

  // keepPrevRating: the same analyst + date is the same rating, so last run's firm/target stand
  // (this subsumes the old keepPrevTarget FX-drift case: same date, 0.4% different target)
  const prev = [{ n: "Hidden One", f: "RBC", r: "Buy", pt: 149.5, opt: 140, d: "2026-11-05" }];
  const kept = keepPrevRating([{ ...prev[0], pt: 150.12, opt: null }], prev)[0];
  assert.deepEqual([kept.pt, kept.opt], [149.5, 140], "same analyst+date, FX drift -> previous target kept");
  assert.equal(keepPrevRating([{ ...prev[0], pt: 160 }], prev)[0].pt, 149.5, "same date -> stored rating wins even on a big move");
  assert.equal(keepPrevRating([{ ...prev[0], d: "2026-11-10", pt: 160 }], prev)[0].pt, 160, "a new date is a new review");
  const ua = (f, pt, r = "Buy") => ({ n: "Unknown Analyst", f, r, pt, opt: pt - 1, d: "2026-10-15" });
  const uaOut = keepPrevRating([ua("Deutsche Bank", 700), ua("Argus", 650)], [ua("Argus", 600), ua("Deutsche Bank", 668)]);
  assert.deepEqual(uaOut.map((r) => [r.f, r.pt, r.opt]), [["Deutsche Bank", 668, 667], ["Argus", 600, 599]], "same-date Unknown Analysts match by firm");
  const flip = keepPrevRating([{ ...prev[0], r: "Hold", f: "RBC2", pt: 150, opt: 160 }], [{ ...prev[0], r: "Buy", pt: 160 }])[0];
  assert.deepEqual([flip.r, flip.f, flip.pt, flip.opt], ["Hold", "RBC2", 150, 160], "same-date Buy->Hold flip passes through whole");
  assert.deepEqual(keepPrevRating(rows, null), rows, "no previous file -> unchanged");
  assert.deepEqual(keepPrevRating([{ n: "Ives", d: "2026-11-01", f: "Wedbush", pt: 300 }], [{ n: "Ives", d: "2026-11-01", f: "Yorkville", pt: 310 }]).map((r) => [r.f, r.pt]), [["Yorkville", 310]], "same date keeps prev firm and target");
  assert.deepEqual(keepPrevRating([{ n: "Ives", d: "2026-11-10", f: "Wedbush", pt: 300 }], [{ n: "Ives", d: "2026-11-01", f: "Yorkville", pt: 310 }]).map((r) => [r.f, r.pt]), [["Wedbush", 300]], "new date keeps the new row");
  assert.equal(keepPrevRating([{ n: "Ives", d: "2026-11-01", f: "W", pt: 300, st: 4.1 }], [{ n: "Ives", d: "2026-11-01", f: "Y", pt: 310, st: 3 }])[0].st, 4.1, "other fields come from the new row");

  // stars: round(5 * rank.rank, 1) from the analyst| record (rating.expert.id), not the sha one
  const aapl = JSON.parse(readFileSync(new URL("./fixtures/stock-forecast-aapl.json", import.meta.url), "utf8"));
  const stRows = forecastsFromPayload(aapl, "AAPL", null);
  const my = stRows.find((r) => r.n === "Martin Yang");
  assert.equal(my.st, Math.round(5 * 0.9405121679656434 * 10) / 10, "Martin Yang stars from his analyst|1504 record");
  assert.ok(stRows.length >= 5 && stRows.every((r) => r.st >= 0 && r.st <= 5), "every st in [0,5]");
  const noRank = { models: { experts: [{ _id: "u", name: "No Rank", firm: "X" }], ratings: [{ object: { ticker: "T" }, expert: { uid: "u", id: "analyst|9" }, date: "2026-10-01", position: "buy", priceTarget: { value: 10 } }] } };
  assert.equal(forecastsFromPayload(noRank, "T", null)[0].st, null, "no rank anywhere -> null");
  const uidOnly = { models: { experts: [{ _id: "u", name: "Uid Only", firm: "X", rank: { rank: 0.5 } }], ratings: noRank.models.ratings } };
  assert.equal(forecastsFromPayload(uidOnly, "T", null)[0].st, 2.5, "falls back to the uid record");
  // uid regression (AAPL Jack Zhou): the live payload's expert record is `_id: "analyst|<n>"` with the
  // sha in `uid`, and a rating names it by `expert.uid` — indexing experts on `_id` alone dropped him.
  const jz = { models: { experts: [{ _id: "x", uid: "u1", name: "Jack Zhou", firm: "Barclays" }], ratings: [{ object: { ticker: "AAPL" }, expert: { uid: "u1" }, date: "2026-11-01", position: "buy", priceTarget: { value: 300 } }] } };
  assert.deepEqual(forecastsFromPayload(jz, "AAPL", null).map((r) => r.n), ["Jack Zhou"], "expert found by uid");
  const byId = { models: { experts: jz.models.experts, ratings: [{ ...jz.models.ratings[0], expert: { id: "x" } }] } };
  assert.deepEqual(forecastsFromPayload(byId, "AAPL", null).map((r) => r.n), ["Jack Zhou"], "no uid on the rating -> expert.id");
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

/* ------------------------------------------- page top-up (missingOf / topUpRows) */
{
  const now = Date.UTC(2026, 10, 16);
  const ours = [{ n: "Vijay Rakesh", f: "Mizuho Securities", st: 4.2, r: "Buy", pt: 250, d: "2026-11-11" }];
  const page = [
    { n: "Vijay Rakesh", f: "Mizuho Securities", st: null, r: "Buy", pt: 220, opt: 250, d: "2026-11-15" }, // the target the payload hid
    { n: "Vijay Rakesh", f: "Mizuho Securities", st: null, r: "Buy", pt: 251, d: "2026-11-11" }, // same rating: payload wins
    { n: "Will Soghikian", f: "Leerink Partners", st: null, r: "Buy", pt: 40, d: "2026-10-12" }, // analyst the payload lacks
    { n: "Ancient", f: "Old Bank", st: null, r: "Hold", pt: 9, d: "2026-05-01" }, // history past the carry window: would flap
  ];
  const out = mergeForecasts(ours, topUpRows(page, missingOf(ours, page, now)));
  assert.deepEqual(out.map((r) => [r.n, r.d, r.pt]), [["Vijay Rakesh", "2026-11-15", 220], ["Vijay Rakesh", "2026-11-11", 250], ["Will Soghikian", "2026-10-12", 40]],
    "page adds the newer rating and the missing analyst; payload target kept; old history not added");
  assert.equal(out[0].st, 4.2, "page row's st filled from the same analyst's payload row");
  assert.deepEqual(latestPerAnalyst(out).map((r) => [r.n, r.pt]), [["Vijay Rakesh", 220], ["Will Soghikian", 40]], "new row in, old row out");
  assert.deepEqual(missingOf(ours, [], now), [], "empty page -> nothing");
  // source regression (page row gone, payload still 11-11) keeps 11-15, not 11-11
  const regressed = latestPerAnalyst(keepNewerPrev(ours, latestPerAnalyst(out)));
  assert.deepEqual(regressed.map((r) => [r.d, r.pt]), [["2026-11-15", 220]], "older row never swaps back in");
  assert.deepEqual(keepNewerPrev([], out), [], "never adds an analyst this run lacks");
  assert.equal(latestPerAnalyst([{ n: "Ann", f: "A", d: "2026-11-01" }, { n: "Ann", f: "B", d: "2026-10-01" }]).length, 2, "firm change = two analysts");
  const two = [{ n: "Ann", f: "A", d: "2026-11-01" }, { n: "Bob", f: "A", d: "2026-10-01" }, { n: "Unknown Analyst", f: "X", d: "2026-11-01" }, { n: "Unknown Analyst", f: "Y", d: "2026-10-01" }];
  assert.equal(latestPerAnalyst(two).length, 4, "different analysts at one firm, and Unknown Analysts at different firms, all stay");
}

console.log("ok   forecast merge: page gate, carryStars, carryRecentPrev, additive guarantee, union, dedup, precedence, anonymized rows, BIOA, payload, uid lookup, FX-stable targets, page top-up");
