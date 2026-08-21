// Dependency-free self-check for watchlist ordering. No test framework by design
// (mirrors alertEngine.check.ts / share.check.ts).
//
// What this guards:
//   1. "Recently added is LAST." The bug being fixed is that the watchlist had no ordering
//      at all — Watchlist.tsx filtered the bundled snapshot and inherited ITS row order, so
//      the list silently reshuffled every 5h when CI rewrote stocks.json.
//   2. A drop lands where the user dropped it. planMove takes a midpoint, and a midpoint
//      equal to a neighbour's key falls through to the TICKER tiebreak — the row would
//      quietly settle one position off. That is the renumber path.
//   3. The legacy all-same-timestamp list. The array->map migration stamped every ticker
//      with one `Date.now()`, so a real user's whole list can be a single tie.
//
// Run:
//   npx tsc src/watchlistOrder.ts src/watchlistOrder.check.ts --outDir /tmp/wo \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/wo/watchlistOrder.check.js
import {
  keyForAppend,
  moveItem,
  NEW_GAP,
  orderTickers,
  planMove,
  renumber,
  type KeyMap,
  type MovePlan,
} from "./watchlistOrder";

let failed = 0;
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.error(`FAIL ${label}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// Apply a plan the way the hook does, so the checks assert on the RESULTING ORDER — the
// thing the user actually sees — instead of on a bare key value.
function apply(keys: KeyMap, plan: MovePlan): string[] {
  if (plan.kind === "renumber") return orderTickers(plan.keys);
  const next = { ...keys };
  if (plan.kind === "key") next[plan.ticker] = plan.key;
  return orderTickers(next);
}

// A list starred A, B, C, D in that order, a minute apart.
const T0 = 1_700_000_000_000;
const ABCD: KeyMap = { A: T0, B: T0 + 60_000, C: T0 + 120_000, D: T0 + 180_000 };
const order = orderTickers(ABCD);

// ---- 1. the default order ------------------------------------------------
eq("oldest first, newest last", order, ["A", "B", "C", "D"]);
eq("a newly starred ticker sorts after everything", orderTickers({ ...ABCD, E: keyForAppend(ABCD, T0 + 240_000) }), ["A", "B", "C", "D", "E"]);
eq("append beats the newest key even if the clock is behind", keyForAppend(ABCD, T0) > ABCD.D, true);
eq("append into an empty list uses the clock", keyForAppend({}, T0), T0);
eq("append after a renumbered list still lands last", orderTickers({ ...renumber(["A", "B", "C"]), Z: keyForAppend(renumber(["A", "B", "C"]), T0) }), ["A", "B", "C", "Z"]);

// ---- ties and junk -------------------------------------------------------
// THE REGRESSION: the legacy array->map migration gave every ticker the same timestamp
const tied: KeyMap = { MSFT: T0, AAPL: T0, NVDA: T0 };
eq("an all-tied list is deterministic, not render-order", orderTickers(tied), ["AAPL", "MSFT", "NVDA"]);
eq("...and stable across repeated calls", orderTickers(tied), orderTickers(tied));
eq("a corrupt key sorts last, never first", orderTickers({ A: T0, BAD: NaN, C: T0 + 1 }), ["A", "C", "BAD"]);
eq("a missing key sorts last too", orderTickers({ A: T0, GONE: undefined as unknown as number }), ["A", "GONE"]);
eq("an empty list is an empty order", orderTickers({}), []);

// ---- 2. moves ------------------------------------------------------------
eq("drag the first row to the middle", apply(ABCD, planMove(order, ABCD, 0, 2)), ["B", "C", "A", "D"]);
eq("drag the last row to the top", apply(ABCD, planMove(order, ABCD, 3, 0)), ["D", "A", "B", "C"]);
eq("drag the first row to the bottom", apply(ABCD, planMove(order, ABCD, 0, 3)), ["B", "C", "D", "A"]);
eq("drag a middle row up one", apply(ABCD, planMove(order, ABCD, 2, 1)), ["A", "C", "B", "D"]);
eq("drag a middle row down one", apply(ABCD, planMove(order, ABCD, 1, 2)), ["A", "C", "B", "D"]);
eq("dropping a row on itself is a no-op", planMove(order, ABCD, 1, 1).kind, "none");
eq("a move costs exactly one write", planMove(order, ABCD, 0, 2).kind, "key");

// out-of-range and degenerate input must not throw or scramble the list
eq("a negative source index does nothing", planMove(order, ABCD, -1, 2).kind, "none");
eq("a source index past the end does nothing", planMove(order, ABCD, 9, 0).kind, "none");
eq("a destination past the end clamps to the bottom", apply(ABCD, planMove(order, ABCD, 0, 99)), ["B", "C", "D", "A"]);
eq("a negative destination clamps to the top", apply(ABCD, planMove(order, ABCD, 3, -5)), ["D", "A", "B", "C"]);
eq("a single-item list has nowhere to move", planMove(["A"], { A: T0 }, 0, 0).kind, "none");

// every position is reachable from every position
let bad: string[] = [];
for (let f = 0; f < 4; f++) {
  for (let t = 0; t < 4; t++) {
    const got = apply(ABCD, planMove(order, ABCD, f, t));
    const want = moveItem(order, f, t);
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${f}->${t} got ${got.join("")} want ${want.join("")}`);
  }
}
eq("all 16 from->to combinations land exactly where moveItem says", bad, []);

// ---- 3. the exhausted-gap path ------------------------------------------
// Neighbours one apart: a midpoint would tie with one of them and the ticker tiebreak
// would then decide the position instead of the drop.
const tight: KeyMap = { A: 100, B: 101, C: 102, D: 103 };
const tightOrder = orderTickers(tight);
eq("touching neighbours trigger a renumber, not a tied key", planMove(tightOrder, tight, 3, 1).kind, "renumber");
eq("...and the row still lands exactly where it was dropped", apply(tight, planMove(tightOrder, tight, 3, 1)), ["A", "D", "B", "C"]);
eq("a renumbered map re-spaces every ticker", renumber(["A", "B", "C"]), { A: NEW_GAP, B: 2 * NEW_GAP, C: 3 * NEW_GAP });
eq("renumbering preserves the order it was given", orderTickers(renumber(["D", "C", "B", "A"])), ["D", "C", "B", "A"]);
eq("a roomy gap does NOT renumber", planMove(order, ABCD, 3, 1).kind, "key");

// the midpoint has to be strictly between, or the tiebreak decides the position
const mid = planMove(order, ABCD, 3, 1);
eq("the midpoint is strictly inside the gap", mid.kind === "key" && mid.key > ABCD.A && mid.key < ABCD.B, true);

// repeated drops into the same gap must converge on a renumber instead of silently failing
let keys: KeyMap = { ...ABCD };
let ord = orderTickers(keys);
let sawRenumber = false;
for (let i = 0; i < 40; i++) {
  const plan = planMove(ord, keys, 3, 1); // always drop the last row into the same gap
  if (plan.kind === "renumber") { sawRenumber = true; keys = plan.keys; }
  else if (plan.kind === "key") keys = { ...keys, [plan.ticker]: plan.key };
  ord = orderTickers(keys);
  eq(`repeat drop ${i + 1} keeps all four rows`, ord.length, 4);
}
eq("40 drops into one gap end in a renumber, not a broken order", sawRenumber, true);

// ---- moveItem, used for the optimistic repaint --------------------------
eq("moveItem matches the documented example", moveItem(["A", "B", "C", "D"], 0, 2), ["B", "C", "A", "D"]);
eq("moveItem leaves the input untouched", (() => { const src = ["A", "B"]; moveItem(src, 0, 1); return src; })(), ["A", "B"]);
eq("moveItem survives an out-of-range source", moveItem(["A", "B"], 5, 0), ["A", "B"]);

if (failed) throw new Error(`${failed} watchlistOrder check(s) failed`);
console.log("\nall watchlistOrder checks passed");
