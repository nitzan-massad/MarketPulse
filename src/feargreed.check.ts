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
import { ariaSummary, bandOf, clamp01, extremes, needlePoint, shortDate, sparkPath, trend, yOf,
  type FearGreed } from "./feargreed";

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

// ── trend chart: FIXED 0-100 axis ─────────────────────────────────────────────
// The axis is the whole point of this redraw. Auto-scaling a bounded index to its own
// range made a calm year look violent, and made a 10-point move look identical whether
// or not it crossed Neutral.
const pt = (d: string, v: number) => ({ d, v });
const H = [pt("2025-10-06", 66.5), pt("2025-12-01", 11.6), pt("2026-03-30", 10.4),
           pt("2026-05-11", 68.7), pt("2026-09-14", 33.3)];

eq(yOf(100, 60), 0, "100 draws at the top of the box");
eq(yOf(0, 60), 60, "0 draws at the bottom");
eq(yOf(50, 60), 30, "50 draws exactly halfway — the fill's anchor");
eq(yOf(25, 60), 45, "the scale is linear over the full 0-100");
eq(yOf(140, 60), 0, "an impossible score is clamped, not drawn off the box");

const sp = sparkPath(H, 300, 60);
ok(sp !== null, "a real series produces a path");
ok(sp!.d.startsWith("M "), "path starts with a moveto");
eq(sp!.lastX, 300, "the last point sits on the right edge");
eq(sp!.mid, 30, "mid is the y of 50, where the diverging fill is anchored");
eq(sp!.hi, 68.7, "hi is the series high");
eq(sp!.lo, 10.4, "lo is the series low");
eq(sp!.points.length, H.length, "one point per sample");

// The fixed axis means identical values draw at identical heights regardless of the
// rest of the series — which an auto-scaled chart cannot promise.
const calm = sparkPath([pt("a", 48), pt("b", 52), pt("c", 50)], 300, 60);
const wild = sparkPath([pt("a", 5), pt("b", 95), pt("c", 50)], 300, 60);
eq(calm!.points[2].y, wild!.points[2].y, "50 draws at the same height in a calm and a wild year");
ok(!calm!.d.includes("NaN"), "a near-flat series does not divide by zero");

eq(sparkPath([pt("a", 5)], 300, 60), null, "a single point is not a line");
eq(sparkPath([], 300, 60), null, "an empty series is not a line");

// ── extremes: the labelled peaks and troughs ──────────────────────────────────
// minGap exists because the year's two highest readings were 68.7 and 68.5 one week
// apart — the same peak. Without a gap the chart labels it twice and misses the other.
const twinPeak = [pt("w0", 40), pt("w1", 68.5), pt("w2", 68.7), pt("w3", 41),
                  pt("w4", 30), pt("w5", 20), pt("w6", 22), pt("w7", 66.5),
                  pt("w8", 35), pt("w9", 12), pt("w10", 33)];
const ex = extremes(twinPeak, 2, 4);
eq(ex.peaks.length, 2, "exactly two peaks");
eq(ex.troughs.length, 2, "exactly two troughs");
ok(Math.abs(ex.peaks[0] - ex.peaks[1]) >= 4, "the two peaks are at least minGap apart");
ok(!(ex.peaks.includes(1) && ex.peaks.includes(2)), "adjacent twin highs are not both labelled");
ok(ex.peaks.includes(2), "the highest reading is always one of them");
ok(ex.troughs.includes(9), "the deepest reading is always one of them");
ok(ex.peaks[0] < ex.peaks[1], "peaks come back in chronological order");

// asking for more than the series can separate returns fewer, not duplicates
const few = extremes([pt("a", 1), pt("b", 2), pt("c", 3)], 2, 6);
eq(few.peaks.length, 1, "a short series yields one peak rather than two overlapping ones");
eq(new Set(few.peaks).size, few.peaks.length, "no index is returned twice");

// ── shortDate ─────────────────────────────────────────────────────────────────
// Parsed as UTC: `new Date("2026-05-11")` is midnight UTC, and rendering it in a
// negative-offset timezone without timeZone:"UTC" would print May 10.
// Locale-agnostic on purpose: DATE_LOCALE is ["he-IL","en-GB"], so the month renders in
// Hebrew here and the assertions must not assume English month names.
ok(/11/.test(shortDate("2026-05-11")), "renders the day, not the day before");
ok(/30/.test(shortDate("2026-03-30")), "month end does not slip");
ok(shortDate("2026-05-11") !== shortDate("2026-06-11"), "the month is part of the label");
ok(!/Invalid/i.test(shortDate("2026-05-11")), "never renders Invalid Date");
ok(shortDate("2026-05-11").trim().length > 2, "the label is more than a bare number");
eq(shortDate(""), "", "a missing date renders nothing rather than Invalid Date");
eq(shortDate("nonsense"), "", "an unparseable date renders nothing");

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
