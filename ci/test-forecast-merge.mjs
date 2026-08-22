// Self-check for the SSR/JSON merge. Run: node ci/test-forecast-merge.mjs
// No network, no filesystem. Imports the real functions — ci/forecast-merge.mjs is pure and
// import-safe precisely so this file does not have to mirror them the way
// ci/test-forecast-gate.mjs had to mirror the old inline gate.
import assert from "node:assert/strict";
import { mergeForecasts, mergeKey, shouldFetchPage } from "./forecast-merge.mjs";

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
  // Same analyst, two dates: two ratings.
  assert.equal(mergeForecasts([row("Ann", "2026-08-01", 10), row("Ann", "2026-06-01", 8)], []).length, 2);
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

console.log("ok   forecast merge: gate, additive guarantee, union, dedup, precedence, anonymized rows, BIOA");
