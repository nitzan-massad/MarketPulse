// Dependency-free self-check for the Fear & Greed gauge's pure logic. No test framework
// by design (mirrors alertEngine.check.ts). What this guards:
//   1. band cuts matching CNN's published ones — a reading must not land in a band the
//      source would not put it in, or our dial disagrees with the number beside it
//   2. needle geometry — 0 points left, 50 straight up, 100 right; an out-of-range score
//      is clamped rather than swinging the needle off the arc
//   3. sparkPath's flat-series case, which divides by zero if the range is not guarded
// Run:
//   npx tsc src/feargreed.ts src/feargreed.check.ts --outDir /tmp/fg \
//     --module commonjs --target es2020 --lib es2020,dom --resolveJsonModule \
//     --esModuleInterop --skipLibCheck \
//   && node /tmp/fg/feargreed.check.js
import { ariaSummary, bandOf, clamp01, needlePoint, sparkPath, trend, type FearGreed } from "./feargreed";

let n = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${msg}\n  expected ${e}\n  actual   ${a}`);
}
function ok(cond: boolean, msg: string) {
  n++;
  if (!cond) throw new Error(`FAIL ${msg}`);
}
const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;

// ── bands: CNN's cuts, and the boundaries are inclusive upper bounds ───────────
eq(bandOf(0).key, "ef", "0 is Extreme Fear");
eq(bandOf(25).key, "ef", "25 is the top of Extreme Fear, not the bottom of Fear");
eq(bandOf(25.1).key, "fe", "just past 25 crosses into Fear");
eq(bandOf(33.3).key, "fe", "the live reading this shipped with is Fear");
eq(bandOf(45).key, "fe", "45 is still Fear");
eq(bandOf(50).key, "nu", "50 is Neutral — the scale has a true midpoint");
eq(bandOf(55).key, "nu", "55 is the top of Neutral");
eq(bandOf(75).key, "gr", "75 is the top of Greed");
eq(bandOf(100).key, "eg", "100 is Extreme Greed");
eq(bandOf(140).key, "eg", "an impossible score still resolves to a band, never undefined");

// "Extreme" on its own does not say which end — the short labels must stay distinguishable.
ok(bandOf(10).short !== bandOf(90).short, "Extreme Fear and Extreme Greed have different short labels");
eq(bandOf(10).short, "EXT FEAR", "extreme-fear short label names its end");
eq(bandOf(90).short, "EXT GREED", "extreme-greed short label names its end");

// ── clamping ──────────────────────────────────────────────────────────────────
eq(clamp01(-5), 0, "a negative score clamps to 0");
eq(clamp01(120), 100, "an over-range score clamps to 100");
eq(clamp01(33.3), 33.3, "an in-range score is untouched");

// ── needle geometry on a 180° arc, centre (100,100), r 80 ─────────────────────
const [x0, y0] = needlePoint(0, 100, 100, 80);
ok(near(x0, 20) && near(y0, 100), "0 points at the left end of the arc");
const [x50, y50] = needlePoint(50, 100, 100, 80);
ok(near(x50, 100) && near(y50, 20), "50 points straight up");
const [x100, y100] = needlePoint(100, 100, 100, 80);
ok(near(x100, 180) && near(y100, 100), "100 points at the right end");

const [xf, yf] = needlePoint(33.3, 100, 100, 80);
ok(xf < 100, "a Fear reading points left of vertical");
ok(yf < 100, "…and above the pivot, never below it");

// An out-of-range score must not swing the needle past the arc's ends.
const [xOver] = needlePoint(999, 100, 100, 80);
ok(near(xOver, 180), "an over-range score pins to the right end rather than wrapping");

// Negative radius reaches back past the pivot — that is the counterweight, and it must
// land on the opposite side of centre from the tip.
const [xTip] = needlePoint(33.3, 100, 100, 66);
const [xTail] = needlePoint(33.3, 100, 100, -8);
ok(xTip < 100 && xTail > 100, "tail sits opposite the tip across the pivot");

// ── sparkline ─────────────────────────────────────────────────────────────────
const sp = sparkPath([10, 50, 30, 90], 300, 60);
ok(sp !== null, "a real series produces a path");
eq(sp!.min, 10, "min taken from the series");
eq(sp!.max, 90, "max taken from the series");
ok(sp!.d.startsWith("M "), "path starts with a moveto");
eq(sp!.lastX, 300, "the last point sits on the right edge");
ok(near(sp!.lastY, 0), "the series high draws at the top of the box");
ok(sp!.d.split(" L ").length === 4, "one segment per point");

// A flat series has zero range — the naive scale divides by zero and yields NaN.
const flat = sparkPath([40, 40, 40], 300, 60);
ok(flat !== null, "a flat series still draws");
ok(!flat!.d.includes("NaN"), "a flat series does not divide by zero");
ok(near(flat!.lastY, 30), "a flat series draws down the middle");

eq(sparkPath([5], 300, 60), null, "a single point is not a line");
eq(sparkPath([], 300, 60), null, "an empty series is not a line");

// ── trend ─────────────────────────────────────────────────────────────────────
eq(trend(33.3, 45.2), { dir: "down", delta: 11.9 }, "a fall reports down with a positive magnitude");
eq(trend(45.2, 33.3), { dir: "up", delta: 11.9 }, "a rise reports up");
eq(trend(33.3, 33.3), { dir: "flat", delta: 0 }, "no move is flat, not up");

// ── accessible summary — the SVG is aria-hidden, so this is the whole description ──
const fg: FearGreed = {
  score: 33.3,
  rating: "fear",
  asOf: "2026-09-11T23:59:53",
  previous: { close: 33.1, week: 45.2, month: 60.1, year: 60.3 },
  components: [],
  history: [],
};
const label = ariaSummary(fg);
ok(label.includes("33"), "the summary states the reading");
ok(label.includes("Fear"), "…and the band");
ok(label.includes("down"), "…and which way it moved");
ok(/breakdown/i.test(label), "…and what activating the control does");

console.log(`feargreed.check OK — ${n} assertions`);
