// Dependency-free self-check for the nullable-consensus contract. No test framework
// by design (mirrors alertEngine.check.ts). The bug this guards against: types.ts
// declared `con: string` while the writers emit null (ci/refresh-data-ci.mjs:72,
// ci/keep.mjs:81,114), so an unrated row (1) painted with Hold styling because
// consClass fell through to "h", and (2) was dropped by the default ["StrongBuy"]
// filter, vanishing from the table for a refresh cycle. Seen on AMTX/NXXT/SNES/CBUS/BEAT.
// Run:
//   npx tsc src/lib.ts src/consensusNull.check.ts --outDir /tmp/cn \
//     --module commonjs --target es2020 --lib es2020,dom --resolveJsonModule \
//     --esModuleInterop --skipLibCheck \
//   && node /tmp/cn/consensusNull.check.js
import { consClass, consLabel, passes, sortRows, type FilterState } from "./lib";
import type { Stock } from "./types";

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

const row = (t: string, con: string | null, b = 0, h = 0, s = 0): Stock => ({
  t, n: t + " Inc", sec: "Technology", px: 10, chg: 0, pt: 20, up: 100, con, b, h, s,
  ss: null, ai: null, air: null, aipt: null, mc: 5000,
});
const filter = (over: Partial<FilterState> = {}): FilterState => ({
  q: "", sectors: [], sectorNot: false, consensuses: [], cap: 0, ...over,
});

// ---- 1. an unknown consensus must not masquerade as Hold ------------------
eq("consClass(null) is not the Hold class", consClass(null) === "h", false);
eq("consClass(null) → no rating class", consClass(null), "");
eq('consClass("") → no rating class', consClass(""), "");
eq("consClass(undefined) → no rating class", consClass(undefined), "");
// the neutral placeholder, matching the "—" the numeric cells already use
eq("consLabel(null) → dash", consLabel(null), "—");
eq('consLabel("") → dash', consLabel(""), "—");
// real ratings keep their classes — "h" still belongs to genuine Hold/Neutral
eq('consClass("Hold") → h', consClass("Hold"), "h");
eq('consClass("Neutral") → h', consClass("Neutral"), "h");
eq('consClass("StrongBuy") → sb', consClass("StrongBuy"), "sb");
eq('consClass("ModerateBuy") → b', consClass("ModerateBuy"), "b");
eq('consClass("StrongSell") → ss', consClass("StrongSell"), "ss");
eq('consClass("Sell") → s', consClass("Sell"), "s");
eq('consLabel("StrongBuy") splits camelCase', consLabel("StrongBuy"), "Strong Buy");

// ---- 2. the consensus filter keeps unknown-consensus rows -----------------
// DECISION: unknown is not "not StrongBuy" — it's missing data, so the row stays
// visible rather than blinking out of the table for one refresh cycle.
const sb = filter({ consensuses: ["StrongBuy"] });
eq("null con survives the StrongBuy filter", passes(row("AMTX", null), sb), true);
eq('"" con survives the StrongBuy filter', passes(row("SNES", ""), sb), true);
eq("known matching con passes", passes(row("NVDA", "StrongBuy"), sb), true);
eq("known non-matching con is still dropped", passes(row("HOLDR", "Hold"), sb), false);
eq("no consensus filter → everything passes", passes(row("AMTX", null), filter()), true);
// the keep is scoped to the consensus test only: other filters still apply to the row
eq("null con still obeys the sector filter",
  passes(row("AMTX", null), filter({ consensuses: ["StrongBuy"], sectors: ["Energy"] })), false);
eq("null con still obeys the market-cap floor",
  passes(row("AMTX", null), filter({ consensuses: ["StrongBuy"], cap: 999999 })), false);
eq("null con still obeys the search query",
  passes(row("AMTX", null), filter({ consensuses: ["StrongBuy"], q: "zzz" })), false);

// ---- 3. sorting on consensus is deterministic and null-safe ---------------
// The comparator sorts on the analyst mix (b/h/s), never the rating string, so a
// null `con` cannot skew the order or throw. An unrated row has no distribution
// either (b/h/s = 0), which parks it at the "fewest buys" end.
const mixed = [row("A", "StrongBuy", 3), row("N", null, 0), row("B", "Buy", 1)];
eq("con desc: unrated (0 buys) sorts last", sortRows(mixed, "con", -1).map((r) => r.t), ["A", "B", "N"]);
eq("con asc: unrated sorts first", sortRows(mixed, "con", 1).map((r) => r.t), ["N", "B", "A"]);
// order follows the distribution, not the string: an unrated row with 9 buys leads
eq("con desc ranks by analyst mix, not the rating string",
  sortRows([row("A", "StrongBuy", 3), row("N", null, 9)], "con", -1).map((r) => r.t), ["N", "A"]);
// two unrated rows compare equal → stable, input order preserved, no throw
eq("two null cons compare equal (stable)",
  sortRows([row("N1", null), row("N2", null)], "con", -1).map((r) => r.t), ["N1", "N2"]);
eq("sorting an all-null-con list does not throw",
  sortRows([row("N1", null), row("N2", null), row("N3", null)], "con", 1).length, 3);
// and null `con` is inert when some other column drives the sort
eq("sorting by another column with null cons present",
  sortRows([row("A", null, 0), row("B", "Buy", 1)], "t", 1).map((r) => r.t), ["A", "B"]);

if (failed) throw new Error(`${failed} consensus-null check(s) failed`);
console.log("\nall consensus-null checks passed");
