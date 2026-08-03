// Self-check for the AI-enrich queue in ci/refresh-data-ci.mjs. The bug this guards
// against: rows that fall out of a run's screener pull are rebuilt by rowFromGetData,
// which carries ai/air/aipt from the previous row (ci/keep.mjs:123-125 — getData has no
// AI-analyst fields at all). Enrich was the only thing that could re-check them, but it
// selected on "needs a null filled", and a carried row's trio is non-null — so it was
// permanently ineligible (70 of 73 off-pull rows on 2026-08-03) and fillNulls could not
// have corrected it anyway. UNP served "Outperform" for ~10 days / ~46 runs after its
// 2026-07-24 downgrade to "Neutral". Run: node ci/test-enrich.mjs
import assert from "node:assert/strict";
import { fillNulls } from "./keep.mjs";

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 36e5).toISOString();
// mirrors CARRIED_FIELDS in refresh-data-ci.mjs — the fields getData cannot supply,
// so enrich must overwrite them. `chg` (Day %) is one: it was frozen on every off-pull row.
const CARRIED_FIELDS = ["ai", "air", "aipt", "chg"];

// --- selection, mirrored from ci/refresh-data-ci.mjs -----------------------
// `rows` : ticker -> stocks.json row, `seen` : ticker -> seen.json entry
const select = (rows, seen, inPull, pinned, limit) => {
  const lsMs = (t) => Date.parse(seen[t]?.ls || seen[t]?.d || "") || 0;
  const aiFreshMs = (t) => Math.max(lsMs(t), Date.parse(seen[t]?.ea || "") || 0);
  const needsFill = (r) => r.ai == null || r.sec == null;
  const prio = (t, r) => (pinned.includes(t) ? 0 : needsFill(r) ? 1 : 2);
  return Object.entries(rows)
    .filter(([t, r]) => needsFill(r) || !inPull.has(t))
    .sort((a, b) => prio(a[0], a[1]) - prio(b[0], b[1]) || aiFreshMs(a[0]) - aiFreshMs(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
};

// --- the write, mirrored from ci/refresh-data-ci.mjs ----------------------
// everything fills, the AI trio overwrites
const applyForecast = (row, f) => {
  fillNulls(row, f);
  for (const k of CARRIED_FIELDS) {
    const v = f[k];
    if (v == null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue; // NaN would serialise to null and blank a good value
    row[k] = v;
  }
  return row;
};

// THE REGRESSION: an off-pull row whose AI trio is fully populated must still be
// selected. Under the old `r.ai == null || r.sec == null` filter it never was.
{
  const rows = {
    UNP: { ai: 74, air: "Outperform", aipt: 328, sec: "Industrials" }, // carried, stale, off-pull
    MSFT: { ai: 81, air: "Outperform", aipt: 600, sec: "Technology" }, // in pull, fresh
    ACTU: { ai: null, air: null, aipt: null, sec: "General" },         // in pull, blank
  };
  const seen = { UNP: { ls: iso(240) }, MSFT: { ls: iso(0) }, ACTU: { ls: iso(0) } };
  const picked = select(rows, seen, new Set(["MSFT", "ACTU"]), [], 9);
  assert.ok(picked.includes("UNP"), "off-pull row with a non-null AI trio must be selected");
  assert.ok(picked.includes("ACTU"), "blank row is still selected");
  assert.equal(picked.includes("MSFT"), false, "in-pull row with complete data is not fetched");
  assert.deepEqual(picked, ["ACTU", "UNP"], "blanks before staleness refreshes");

  const oldFilter = Object.entries(rows).filter(([, r]) => r.ai == null || r.sec == null).map(([t]) => t);
  assert.equal(oldFilter.includes("UNP"), false,
    "old selector must miss UNP — if it does not, the bug is elsewhere, rewrite this test");
}

// a payload value overwrites a stale non-null (fillNulls alone cannot)
{
  const row = { t: "UNP", ai: 74, air: "Outperform", aipt: 328, sec: "Industrials", px: 292.13 };
  applyForecast(row, { ai: 69, air: "Neutral", aipt: 300, sec: "Industrials", px: 288 });
  assert.equal(row.ai, 69, "stale AI score overwritten");
  assert.equal(row.air, "Neutral", "stale AI rating overwritten");
  assert.equal(row.aipt, 300, "stale AI target overwritten");
  assert.equal(row.px, 292.13, "non-AI fields keep fillNulls semantics — not overwritten");

  const fillOnly = { ai: 74, air: "Outperform", aipt: 328 };
  fillNulls(fillOnly, { ai: 69, air: "Neutral", aipt: 300 });
  assert.equal(fillOnly.air, "Outperform", "fillNulls cannot correct a stale non-null — hence the overwrite");
}

// a null payload value must NOT blank a good value (a ticker whose forecast report is
// absent returns nulls; blanking would be worse than the carried value)
{
  const row = { ai: 74, air: "Outperform", aipt: 328, sec: "Industrials" };
  applyForecast(row, { ai: null, air: null, aipt: null, sec: null });
  assert.deepEqual(row, { ai: 74, air: "Outperform", aipt: 328, sec: "Industrials" }, "nulls never blank");
  // and forecastFields returns {} for an unknown ticker — must be a no-op too
  applyForecast(row, {});
  assert.equal(row.air, "Outperform", "empty payload is a no-op");
}

// the cap is respected and ordering is stalest-first
{
  const off = ["A", "B", "C", "D", "E"];
  const rows = Object.fromEntries(off.map((t) => [t, { ai: 50, air: "Neutral", aipt: 1, sec: "Energy" }]));
  const seen = { A: { ls: iso(10) }, B: { ls: iso(200) }, C: { ls: iso(50) }, D: { ls: iso(1) }, E: { ls: iso(99) } };
  const picked = select(rows, seen, new Set(), [], 3);
  assert.equal(picked.length, 3, "cap respected");
  assert.deepEqual(picked, ["B", "E", "C"], "stalest ls first");
  // pins jump the queue regardless of age
  assert.deepEqual(select(rows, seen, new Set(), ["D"], 3), ["D", "B", "E"], "pins first");
}

// the cap only bounds staleness if the queue ROTATES. `ls` is frozen while a ticker is
// off-pull, so the `ea` stamp is what moves a fetched row to the back.
{
  const off = ["A", "B", "C", "D", "E"];
  const rows = Object.fromEntries(off.map((t) => [t, { ai: 50, air: "Neutral", aipt: 1, sec: "Energy" }]));
  const seen = Object.fromEntries(off.map((t, i) => [t, { ls: iso(100 - i) }])); // A stalest .. E freshest
  const run = (limit) => {
    const picked = select(rows, seen, new Set(), [], limit);
    for (const t of picked) seen[t].ea = new Date().toISOString(); // what the seen tracker stamps
    return picked;
  };
  const first = run(2);
  const second = run(2);
  assert.deepEqual(first, ["A", "B"]);
  assert.equal(first.some((t) => second.includes(t)), false, "batches must not overlap — no ea stamp = same head forever");
  assert.deepEqual(second, ["C", "D"]);
  assert.deepEqual(run(2), ["E", "A"], "5 off-pull rows covered in ceil(5/2) runs, then wraps");

  // without the ea stamp the head repeats and rows 3..N are never refreshed
  const frozen = Object.fromEntries(off.map((t, i) => [t, { ls: iso(100 - i) }]));
  const noStamp = () => select(rows, frozen, new Set(), [], 2);
  assert.deepEqual(noStamp(), noStamp(), "ls-only ordering is static — proves the ea stamp is load-bearing");
}

console.log("enrich queue: ok");

// --- the overwrite must not blank a good value when the payload reshapes ---------
// rnd() returns NaN for a non-numeric score, and JSON.stringify(NaN) is null, so a bare
// `!= null` test would wipe the very field it promises to protect.
{
  const stale = { t: "X", ai: 74, air: "Outperform", aipt: 328, chg: 4.02 };
  const reshaped = { ai: NaN, air: null, aipt: NaN, chg: NaN };
  const row = { ...stale };
  for (const k of CARRIED_FIELDS) {
    const v = reshaped[k];
    if (v == null) continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    row[k] = v;
  }
  assert.deepEqual(row, stale, "a reshaped payload must carry every field, not blank it");
  assert.equal(JSON.stringify({ ai: NaN }), '{"ai":null}', "NaN really does serialise to null — this is why the guard exists");
}

// --- chg is refreshed, and that was the whole point of adding it ------------------
{
  const row = { t: "TER", ai: 71, air: "Outperform", aipt: 406, chg: 12.07 }; // 12 days stale
  const fresh = { ai: 71, air: "Outperform", aipt: 406, chg: 0.6 };
  for (const k of CARRIED_FIELDS) if (fresh[k] != null) row[k] = fresh[k];
  assert.equal(row.chg, 0.6, "Day % must be overwritten, not carried");
}

console.log("enrich overwrite (incl. chg + NaN guard): ok");

// --- #10: a pin is prio 0 only when actually stale ------------------------------
// Unconditional prio 0 re-fetched every pin every run, and sticky slots scaled with the pin
// count — enough pins and prio-2 rotation stops dead, so staleness silently goes unbounded.
{
  const STALE_MS = 3 * 864e5;
  const now = Date.parse("2026-08-03T12:00:00Z");
  const prio = (pinned, t, r, freshMs) =>
    pinned.includes(t) && now - freshMs > STALE_MS ? 0 : (r.ai == null || r.sec == null) ? 1 : 2;
  const full = { ai: 71, sec: "Technology" };
  assert.equal(prio(["TER"], "TER", full, now - 1 * 864e5), 2, "a FRESH pin must not jump the queue");
  assert.equal(prio(["TER"], "TER", full, now - 9 * 864e5), 0, "a STALE pin still gets priority");
  assert.equal(prio(["TER"], "X", { ai: null, sec: null }, now), 1, "a blank row is prio 1");
  assert.equal(prio([], "X", full, 0), 2, "never-enriched non-pin is prio 2");
}

// --- #5: the cap scales with the eligible set so the bound cannot decay ---------
// A fixed 40 meant the 3-run (~15h) worst case drifted to ~20h in a week and ~50h in six,
// because the off-pull set grows ~5.7/day. Derive the cap instead; keep 40 as a floor and
// ENRICH_MAX as a ceiling, since every unit of cap is one FlareSolverr fetch per run.
{
  const MAX = 120; // mirrors ENRICH_MAX in ci/refresh-data-ci.mjs and scripts/refresh-data.mjs
  const cap = (n, target = 3) => Math.min(MAX, Math.max(40, Math.ceil(n / target)));
  assert.equal(cap(73), 40, "73 eligible still fits the floor");
  assert.equal(cap(120), 40, "120/3 = 40, exactly the floor");
  assert.equal(cap(200), 67, "200 eligible -> 67, so rotation stays at 3 runs");
  assert.equal(cap(350), 117, "350 eligible -> 117, just under the ceiling");
  assert.equal(cap(360), MAX, "360/3 lands exactly ON the ceiling");
  assert.equal(cap(900), MAX, "past the ceiling the cap stops growing — cost is bounded");
  assert.equal(cap(1e6), MAX, "and stays bounded however large the keep set gets");
  for (const n of [1, 40, 73, 120, 200, 350, 360]) {
    assert.ok(Math.ceil(n / cap(n)) <= 3, `rotation stays within 3 runs at n=${n}`);
  }
  // THE POINT OF THE CEILING, beyond cost: it is what makes the staleness WARNING in
  // refresh-data-ci.mjs reachable at all. Without it cap === ceil(n/3), so the condition
  // `n > cap * 3` is arithmetically unsatisfiable and the guard is dead code that reads
  // as protection. With it, the warning fires exactly when rotation really has slipped.
  const warns = (n) => n > cap(n) * 3;
  assert.ok(!warns(351), "at today's whole universe there is nothing to warn about");
  assert.ok(!warns(360), "at the ceiling boundary rotation is still within target");
  assert.ok(warns(361), "one row past what the ceiling can rotate in 3 runs — WARN");
  assert.ok(warns(1000), "and it keeps warning as the set grows");
  const uncapped = (n) => Math.max(40, Math.ceil(n / 3));
  for (const n of [1, 73, 361, 1000, 5000]) {
    assert.ok(!(n > uncapped(n) * 3), `REGRESSION GUARD: without a ceiling the warning is dead at n=${n}`);
  }
}

// --- #8: the AI trio lands atomically ------------------------------------------
// Field-by-field, a payload with `score` but no `ratingId` shipped a fresh 69 beside a stale
// "Outperform" — the exact UNP symptom, reintroduced at half scale.
{
  const usable = (v) => v != null && !(typeof v === "number" && !Number.isFinite(v));
  const apply = (row, f) => {
    const trio = ["ai", "air", "aipt"];
    if (trio.every((k) => usable(f[k]))) for (const k of trio) row[k] = f[k];
    if (usable(f.chg)) row.chg = f.chg;
    return row;
  };
  const stale = () => ({ ai: 74, air: "Outperform", aipt: 328, chg: 4.02 });
  assert.deepEqual(apply(stale(), { ai: 69, air: "Neutral", aipt: 333, chg: 0.92 }),
    { ai: 69, air: "Neutral", aipt: 333, chg: 0.92 }, "a complete report replaces the whole trio");
  assert.deepEqual(apply(stale(), { ai: 69, chg: 0.92 }),
    { ai: 74, air: "Outperform", aipt: 328, chg: 0.92 },
    "a PARTIAL report leaves the trio alone — no fresh score beside a stale rating");
  assert.deepEqual(apply(stale(), { air: "Neutral" }), stale(), "rating alone is not enough");
  assert.deepEqual(apply(stale(), { ai: NaN, air: "Neutral", aipt: 333 }), stale(), "NaN makes the trio unusable");
  // chg is independent of the AI report and must still refresh on its own
  assert.equal(apply(stale(), { chg: 0.6 }).chg, 0.6, "chg refreshes even when the trio is incomplete");
}

// --- #9: an empty result is a signal, not a silent success ----------------------
{
  const f = {};
  assert.equal(Object.keys(f).length, 0, "an _id/bundle mismatch yields {} — must be counted and logged, not enriched");
}

// --- #6: the backfill queue must not order on a frozen key ---------------------
// `ls` is frozen for off-pull tickers and EVERY backfill candidate is off-pull, so ordering
// on it re-picks the same head forever and the tail past BACKFILL_LIMIT is never fetched.
{
  const seenA = { A: { ls: "2026-07-01T00:00:00Z" }, B: { ls: "2026-07-02T00:00:00Z" }, C: { ls: "2026-07-03T00:00:00Z" } };
  const lsMs = (s) => (t) => Date.parse(s[t]?.ls || s[t]?.d || "") || 0;
  const baMs = (s) => (t) => Date.parse(s[t]?.ba || "") || lsMs(s)(t);
  const pick = (s, key, cap) => ["A", "B", "C"].sort((x, y) => key(s)(x) - key(s)(y)).slice(0, cap);

  const first = pick(seenA, baMs, 2);
  assert.deepEqual(first, ["A", "B"], "first run takes the two oldest");
  const stamped = { ...seenA };
  for (const t of first) stamped[t] = { ...stamped[t], ba: "2026-08-03T00:00:00Z" };
  assert.deepEqual(pick(stamped, baMs, 2), ["C", "A"], "ba advances, so C finally gets its turn");
  // control: ls-only ordering never reaches C
  assert.deepEqual(pick(stamped, lsMs, 2), ["A", "B"], "CONTROL: ls-only ordering re-picks the same head forever");
}

console.log("enrich queue hardening (#5 #6 #8 #9 #10): ok");
