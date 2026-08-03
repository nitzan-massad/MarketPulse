// Dependency-free self-check for metricChange, the New Arrivals change-row helper.
// No test framework by design (mirrors alertEngine.check.ts / consensusNull.check.ts).
//
// The bug this guards: changesFor used to require BOTH sides non-null
// (`fs.ss != null && s.ss != null`), so a metric appearing or DISAPPEARING produced no
// change row at all. A stock losing its Smart Score or analyst coverage showed nothing —
// silently, exactly when it mattered. Against today's data that hid 9 real changes
// (7 vanished: SNTI ALGS DARE ACTU KYNB KBSX BEAT; 2 appeared: CALC DFNS).
//
// Run:
//   npx tsc src/lib.ts src/metricChange.check.ts --outDir /tmp/mc \
//     --module commonjs --target es2020 --lib es2020,dom --resolveJsonModule \
//     --esModuleInterop --skipLibCheck \
//   && node /tmp/mc/metricChange.check.js
import { metricChange } from "./lib";

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

// ---- no change -------------------------------------------------------------
eq("equal values → no change", metricChange(7, 7), null);
eq("both null → no change", metricChange(null, null), null);
eq("both undefined → no change", metricChange(undefined, undefined), null);
eq("null vs undefined → no change (both absent)", metricChange(null, undefined), null);
eq("zero unchanged → no change", metricChange(0, 0), null);

// ---- real moves keep a direction ------------------------------------------
eq("rise → up", metricChange(6, 8), { o: "6", n: "8", dir: "up" });
eq("fall → down", metricChange(9, 5), { o: "9", n: "5", dir: "down" });
eq("decimal move keeps precision", metricChange(7.8, 71), { o: "7.8", n: "71", dir: "up" });
// 0 is a value, not a blank — a falsy check here would drop a real change
eq("0 → 4 is a rise, not an appearance", metricChange(0, 4), { o: "0", n: "4", dir: "up" });
eq("4 → 0 is a fall, not a disappearance", metricChange(4, 0), { o: "4", n: "0", dir: "down" });
eq("negative values compare numerically", metricChange(-2, 3), { o: "-2", n: "3", dir: "up" });

// ---- THE REGRESSION: appearing and disappearing must surface, with no direction ----
eq("VANISHED: 7 → null renders a dash and no direction",
  metricChange(7, null), { o: "7", n: "—", dir: null });
eq("APPEARED: null → 4 renders a dash and no direction",
  metricChange(null, 4), { o: "—", n: "4", dir: null });
eq("undefined → 4 behaves as appeared", metricChange(undefined, 4), { o: "—", n: "4", dir: null });
eq("7 → undefined behaves as vanished", metricChange(7, undefined), { o: "7", n: "—", dir: null });
// a value vanishing must never be reported as a fall to zero, or as a rise
{
  const v = metricChange(9, null);
  eq("vanished is not dir:down", v?.dir === "down", false);
  eq("vanished is not dir:up", v?.dir === "up", false);
  eq("vanished new value is the dash, not '0' or 'null'", v?.n, "—");
}

// ---- the real cases this unhid, from committed data ------------------------
eq("BEAT Smart Score 9 → null", metricChange(9, null), { o: "9", n: "—", dir: null });
eq("CALC Smart Score null → 4", metricChange(null, 4), { o: "—", n: "4", dir: null });

if (failed) throw new Error(`${failed} metricChange check(s) failed`);
console.log("\nall metricChange checks passed");
