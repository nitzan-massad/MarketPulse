// Dependency-free self-check for the intraday session slice. No test framework by design.
// Run:
//   npx tsc src/chartSession.ts src/chartSession.check.ts --outDir /tmp/cs \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/cs/chartSession.check.js
import { fmtMin, sessionSlice } from "./chartSession";

let failed = 0;
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failed++; console.error(`FAIL ${label}: got ${g}, want ${w}`); }
  else console.log(`ok   ${label}`);
}

// multi-day feed (yesterday afternoon + today morning) -> keep only today, mid-session
const closes = [10, 11, 12, 20, 21, 22, 23];
const stamps = [
  "2026-07-24 14:30", "2026-07-24 15:00", "2026-07-24 15:30",
  "2026-07-25 09:30", "2026-07-25 09:35", "2026-07-25 09:40", "2026-07-25 09:45",
];
const s = sessionSlice(closes, stamps)!;
eq("keeps only the latest session", s.closes, [20, 21, 22, 23]);
eq("first bar is 9:30", s.mins[0], 570);
eq("domain starts at open", s.dStart, 570);
eq("domain end fixed to 16:00 while partial", s.dEnd, 960);
eq("last bar 9:45", s.lastMin, 585);
eq("mid-session is live", s.live, true);

// completed session -> not live
const full = sessionSlice([1, 2, 3], ["2026-07-25 15:50", "2026-07-25 15:55", "2026-07-25 16:00"])!;
eq("closed session not live", full.live, false);
eq("closed domain end 16:00", full.dEnd, 960);

// guards
eq("daily stamps -> null (fall back)", sessionSlice([1, 2], ["2026-07-24", "2026-07-25"]), null);
eq("too few bars -> null", sessionSlice([1], ["2026-07-25 09:30"]), null);
eq("fmtMin", fmtMin(585), "9:45");
eq("fmtMin pads", fmtMin(600), "10:00");

if (failed) throw new Error(`${failed} chartSession check(s) failed`);
console.log("\nall chartSession checks passed");
