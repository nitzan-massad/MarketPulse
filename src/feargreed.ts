import { DATE_LOCALE } from "./lib";
// Pure logic for the Fear & Greed gauge: bands, needle geometry, trend chart.
// No React, no fetch — paired with feargreed.check.ts, like lib/consensus/alertEngine.
//
// The 0-100 scale is CNN's and is never rescaled here (same rule as `ai`). Band cuts are
// CNN's published ones, so "34" lands in Fear on our dial exactly as it does on theirs.

export interface Component {
  key: string;
  label: string;
  score: number;
  rating: string;
}
/** One weekly sample. `d` is CNN's own date — never derived by counting back. */
export interface HistoryPoint {
  d: string;
  v: number;
}
export interface FearGreed {
  score: number;
  rating: string;
  asOf: string;
  previous: { close: number; week: number; month: number; year: number };
  components: Component[];
  history: HistoryPoint[];
}

export type BandKey = "ef" | "fe" | "nu" | "gr" | "eg";
export interface Band {
  key: BandKey;
  /** Full name, for the accessible label. */
  label: string;
  /** Short form for tight columns — "Extreme" alone would not say which end. */
  short: string;
}

// Upper bound of each band, inclusive. 50 is a true midpoint: Neutral straddles it.
const BANDS: [number, Band][] = [
  [25, { key: "ef", label: "Extreme Fear", short: "EXT FEAR" }],
  [45, { key: "fe", label: "Fear", short: "FEAR" }],
  [55, { key: "nu", label: "Neutral", short: "NEUTRAL" }],
  [75, { key: "gr", label: "Greed", short: "GREED" }],
  [100, { key: "eg", label: "Extreme Greed", short: "EXT GREED" }],
];

export function bandOf(score: number): Band {
  for (const [to, band] of BANDS) if (score <= to) return band;
  return BANDS[BANDS.length - 1][1];
}

/** Clamp to the dial's range so a bad reading can never point the needle off the arc. */
export const clamp01 = (score: number): number => Math.min(100, Math.max(0, score));

/**
 * Point on a 180° arc for `score`, sweeping left (0) to right (100).
 * Negative `r` reaches back past the pivot — used for the needle's counterweight.
 */
export function needlePoint(score: number, cx: number, cy: number, r: number): [number, number] {
  const a = Math.PI * (1 - clamp01(score) / 100);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}

/** Direction of travel vs a prior reading. `flat` when the move rounds to nothing. */
export function trend(score: number, prior: number): { dir: "up" | "down" | "flat"; delta: number } {
  const delta = Math.round((score - prior) * 10) / 10;
  return { dir: delta > 0 ? "up" : delta < 0 ? "down" : "flat", delta: Math.abs(delta) };
}

export interface Spark {
  d: string;
  /** y for the neutral 50 line — the fill is anchored here, not at the floor. */
  mid: number;
  lastX: number;
  lastY: number;
  /** y of the 52-week high and low, for the reference rules. */
  hiY: number;
  loY: number;
  hi: number;
  lo: number;
  points: { x: number; y: number; i: number }[];
}

/**
 * The chart is drawn on a FIXED 0-100 axis, not scaled to the series' own range.
 * The index is bounded by definition, so auto-scaling inflates every wiggle to full
 * height — a year that ran 10-69 looked far more violent than it was, and a 10-point
 * move read the same whether or not it crossed Neutral.
 */
export const yOf = (v: number, h: number): number => h - (clamp01(v) / 100) * h;

/** `[lo, hi]` of the y axis. Defaults to the fixed 0-100 — see yOf. Short ranges pass a
 *  zoomed domain, or a week that moved 4 points would draw as a flat line. */
export function sparkPath(history: HistoryPoint[], w: number, h: number, domain: [number, number] = [0, 100]): Spark | null {
  if (!history || history.length < 2) return null;
  const [d0, d1] = domain;
  const y = (v: number) => Math.min(h, Math.max(0, h - ((v - d0) / (d1 - d0)) * h));
  const vals = history.map((p) => p.v);
  const hi = Math.max(...vals);
  const lo = Math.min(...vals);
  const points = history.map((p, i) => ({
    x: (i / (history.length - 1)) * w,
    y: y(p.v),
    i,
  }));
  let d = "";
  for (const pt of points) d += (d ? " L " : "M ") + pt.x.toFixed(1) + " " + pt.y.toFixed(1);
  const last = points[points.length - 1];
  return { d, mid: y(50), lastX: last.x, lastY: last.y, hiY: y(hi), loY: y(lo), hi, lo, points };
}

export interface Extremes {
  peaks: number[];
  troughs: number[];
}

/**
 * The `count` highest peaks and `count` deepest troughs, as indices into `history`.
 *
 * `minGap` is the point of this: the two highest readings of the year were 68.7 and 68.5,
 * one week apart — the same peak, which would get labelled twice. Requiring a gap between
 * picks makes them read as distinct events instead.
 */
export function extremes(history: HistoryPoint[], count = 2, minGap = 6): Extremes {
  const pick = (dir: 1 | -1): number[] => {
    const order = history
      .map((_, i) => i)
      .sort((a, b) => dir * (history[b].v - history[a].v));
    const out: number[] = [];
    for (const i of order) {
      if (out.length >= count) break;
      if (out.every((j) => Math.abs(i - j) >= minGap)) out.push(i);
    }
    return out.sort((a, b) => a - b);
  };
  return { peaks: pick(1), troughs: pick(-1) };
}

/** "May 11" — the label under a peak. Parsed as UTC so it cannot slip a day by timezone. */
export function shortDate(iso: string): string {
  const [y, m, day] = iso.split("-").map(Number);
  if (!y || !m || !day) return "";
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString(DATE_LOCALE, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * What a screen reader hears instead of the dial. The SVG itself is aria-hidden, so this
 * is the only description of the reading — it carries the number, the band and the move.
 */
export function ariaSummary(fg: FearGreed): string {
  const t = trend(fg.score, fg.previous.week);
  const move =
    t.dir === "flat" ? "unchanged from a week ago" : `${t.delta} ${t.dir} from a week ago`;
  return `Fear and Greed Index ${Math.round(fg.score)} of 100, ${bandOf(fg.score).label}, ${move}. Show breakdown`;
}

export interface Range { key: string; days: number; label: string; per: string; fixedAxis: boolean }
/** The trend chart's ranges. 6M and 1Y keep the fixed 0-100 axis; shorter ones zoom. */
export const RANGES: Range[] = [
  { key: "1W", days: 7, label: "1-week trend", per: "week", fixedAxis: false },
  { key: "1M", days: 31, label: "1-month trend", per: "month", fixedAxis: false },
  { key: "3M", days: 92, label: "3-month trend", per: "3 months", fixedAxis: false },
  { key: "6M", days: 183, label: "6-month trend", per: "6 months", fixedAxis: true },
  { key: "1Y", days: 366, label: "52-week trend", per: "year", fixedAxis: true },
];

/** The points inside the last `days` calendar days (by the newest point's date), never fewer than 2. */
export function sliceDays(history: HistoryPoint[], days: number): HistoryPoint[] {
  if (history.length < 2) return history;
  const end = Date.parse(history[history.length - 1].d);
  const out = history.filter((p) => end - Date.parse(p.d) < days * 864e5);
  return out.length >= 2 ? out : history.slice(-2);
}

/** A zoomed y domain: the series' own range, padded, at least `minSpan` tall so a quiet
 *  week does not inflate a 2-point wiggle to full height. Clamped to 0-100. */
export function zoomDomain(history: HistoryPoint[], minSpan = 20): [number, number] {
  const vals = history.map((p) => p.v);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(minSpan, (hi - lo) * 1.25);
  const mid = (hi + lo) / 2;
  const d0 = Math.max(0, Math.min(100 - span, mid - span / 2));
  return [d0, Math.min(100, d0 + span)];
}
