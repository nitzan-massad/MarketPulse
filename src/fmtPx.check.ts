// Dependency-free self-check for fmtPx, the price formatter. No test framework by design
// (mirrors alertEngine.check.ts / metricChange.check.ts).
//
// The bug this guards: the pipeline was taught to STORE sub-dollar prices at 4dp
// (ci/keep.mjs `rndPx`) because a flat 2dp annihilates a sub-penny quote — but fmtPx still
// rendered every price under $100 with toFixed(2), so a real $0.0034 quote still displayed
// as "$0.00". The storage fix was invisible where it mattered. 42 of 351 shipped rows are
// under $1 and a delisting-track penny stock is exactly the row a watcher is watching.
//
// Run:
//   npx tsc src/lib.ts src/fmtPx.check.ts --outDir /tmp/fp \
//     --module commonjs --target es2020 --lib es2020,dom --resolveJsonModule \
//     --esModuleInterop --skipLibCheck \
//   && node /tmp/fp/fmtPx.check.js
import { fmtPx } from "./lib";

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

// ---- THE REGRESSION: a sub-penny price must not render as $0.00 ------------
eq("sub-penny keeps 4dp", fmtPx(0.0034), "$0.0034");
eq("a sub-penny price never renders as $0.00", fmtPx(0.0034) === "$0.00", false);
eq("the smallest storable price still shows a digit", fmtPx(0.0001), "$0.0001");
// rndPx stores 4dp below $1, so anything smaller is already rounded away upstream
eq("half a cent keeps its digits instead of rounding to zero", fmtPx(0.005), "$0.0050");

// ---- the cent/sub-cent boundary -------------------------------------------
eq("exactly one cent uses 2dp", fmtPx(0.01), "$0.01");
eq("just under a cent uses 4dp", fmtPx(0.0099), "$0.0099");

// ---- everything that already worked must keep working ---------------------
eq("the cheapest shipped row is unchanged", fmtPx(0.17), "$0.17");
eq("a normal sub-$100 price keeps cents", fmtPx(12.5), "$12.50");
eq("$100 and up drops the cents", fmtPx(367.69), "$368");
eq("exactly $100 drops the cents", fmtPx(100), "$100");
eq("just under $100 keeps them", fmtPx(99.99), "$99.99");
eq("no price renders as a dash", fmtPx(null), "—");
eq("zero is a value, not a blank", fmtPx(0), "$0.0000");

// ---- negatives can't reach px, but must not produce "$-0.0000" either -----
eq("a negative below a cent still reads as a negative", fmtPx(-0.5), "$-0.50");
eq("a negative under a cent uses 4dp", fmtPx(-0.001), "$-0.0010");

if (failed) throw new Error(`${failed} fmtPx check(s) failed`);
console.log("\nall fmtPx checks passed");
