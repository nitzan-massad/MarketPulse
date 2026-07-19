// Dependency-free self-check for the alert ratchet. No test framework by design.
// Run:
//   npx tsc src/alertEngine.ts src/alertEngine.check.ts --outDir /tmp/ae \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/ae/alertEngine.check.js
import { evalAlert } from "./alertEngine";

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

// added @ $100, ref starts = addPx
eq("sub-threshold → null", evalAlert(104, { addPx: 100, ref: 100 }), null);
eq("+5% up fires", evalAlert(105, { addPx: 100, ref: 100 }), { dir: "up", pct: 5, newRef: 105 });
eq("+5% again from ratcheted ref", evalAlert(110.25, { addPx: 100, ref: 105 }), {
  dir: "up",
  pct: 10,
  newRef: 110.25,
});
eq("reversal: down from raised ref shows small cumulative pct", evalAlert(99.75, { addPx: 100, ref: 105 }), {
  dir: "down",
  pct: 0,
  newRef: 99.75,
});
eq("big drop", evalAlert(80, { addPx: 100, ref: 100 }), { dir: "down", pct: -20, newRef: 80 });
eq("guard: zero current → null", evalAlert(0, { addPx: 100, ref: 100 }), null);
eq("guard: zero ref → null", evalAlert(105, { addPx: 100, ref: 0 }), null);

if (failed) throw new Error(`${failed} alertEngine check(s) failed`);
console.log("\nall alertEngine checks passed");
