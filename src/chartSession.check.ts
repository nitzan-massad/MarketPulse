// Dependency-free self-check for the intraday session slice. No test framework by design.
// Run:
//   npx tsc src/chartSession.ts src/chartSession.check.ts --outDir /tmp/cs \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/cs/chartSession.check.js
import { fmtMin, marketOpen, nearestIndex, sessionSlice } from "./chartSession";

let failed = 0;
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { failed++; console.error(`FAIL ${label}: got ${g}, want ${w}`); }
  else console.log(`ok   ${label}`);
}

const NOON = { date: "2026-07-25", min: 12 * 60 }; // during-hours "now" on 2026-07-25

// multi-day feed (yesterday afternoon + today morning) -> keep only today, mid-session
const closes = [10, 11, 12, 20, 21, 22, 23];
const stamps = [
  "2026-07-24 14:30", "2026-07-24 15:00", "2026-07-24 15:30",
  "2026-07-25 09:30", "2026-07-25 09:35", "2026-07-25 09:40", "2026-07-25 09:45",
];
const s = sessionSlice(closes, stamps, NOON)!;
eq("keeps only the latest session", s.closes, [20, 21, 22, 23]);
eq("first bar is 9:30", s.mins[0], 570);
eq("domain starts at open", s.dStart, 570);
eq("domain end fixed to 16:00 while partial", s.dEnd, 960);
eq("last bar 9:45", s.lastMin, 585);
eq("mid-session with market open is live", s.live, true);

// completed session (now after close) -> not live
const afterHours = { date: "2026-07-25", min: 18 * 60 };
const full = sessionSlice([1, 2, 3], ["2026-07-25 15:50", "2026-07-25 15:55", "2026-07-25 16:00"], afterHours)!;
eq("after-hours not live", full.live, false);
eq("closed domain end 16:00", full.dEnd, 960);

// EVTL bug: illiquid last bar 15:55 from a PRIOR day, viewed on a closed day -> not live
const evtl = sessionSlice([1, 2, 3], ["2026-07-24 15:45", "2026-07-24 15:50", "2026-07-24 15:55"], { date: "2026-07-25", min: 12 * 60 })!;
eq("prior-day session on a closed day is not live", evtl.live, false);

// pre-market (before 9:30) -> not live even if a today bar somehow exists
eq("pre-market not live", sessionSlice([1, 2], ["2026-07-25 09:30", "2026-07-25 09:35"], { date: "2026-07-25", min: 9 * 60 })!.live, false);
// unknown clock -> never live
eq("no now -> not live", sessionSlice([1, 2], ["2026-07-25 09:30", "2026-07-25 09:35"], null)!.live, false);

// guards
eq("daily stamps -> null (fall back)", sessionSlice([1, 2], ["2026-07-24", "2026-07-25"], NOON), null);
eq("too few bars -> null", sessionSlice([1], ["2026-07-25 09:30"], NOON), null);
eq("fmtMin", fmtMin(585), "9:45");
eq("fmtMin pads", fmtMin(600), "10:00");

// marketOpen: 2026-07-25 is a Saturday -> closed regardless of time
eq("Saturday is closed", marketOpen({ date: "2026-07-25", min: 12 * 60 }), false);
// 2026-07-24 is a Friday
eq("Friday midday is open", marketOpen({ date: "2026-07-24", min: 12 * 60 }), true);
eq("Friday after 16:00 is closed", marketOpen({ date: "2026-07-24", min: 16 * 60 + 5 }), false);
eq("Friday pre-open is closed", marketOpen({ date: "2026-07-24", min: 9 * 60 }), false);

// nearestIndex — the chart scrubber snaps to a real data point
const XS = [0, 10, 20, 30, 40];
eq("scrub: exact hit", nearestIndex(XS, 20), 2);
eq("scrub: rounds to closer neighbour", nearestIndex(XS, 23), 2);
eq("scrub: rounds up past midpoint", nearestIndex(XS, 26), 3);
eq("scrub: exact midpoint keeps the earlier point", nearestIndex(XS, 25), 2);
eq("scrub: left of range clamps to first", nearestIndex(XS, -50), 0);
eq("scrub: right of range clamps to last", nearestIndex(XS, 999), 4);
eq("scrub: single point", nearestIndex([7], 999), 0);
eq("scrub: empty -> -1", nearestIndex([], 5), -1);

if (failed) throw new Error(`${failed} chartSession check(s) failed`);
console.log("\nall chartSession checks passed");
