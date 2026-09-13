// Pure logic for the Fear & Greed gauge: bands, needle geometry, sparkline path.
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
export interface FearGreed {
  score: number;
  rating: string;
  asOf: string;
  previous: { close: number; week: number; month: number; year: number };
  components: Component[];
  history: number[];
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
  lastX: number;
  lastY: number;
  min: number;
  max: number;
}

/**
 * Sparkline path across the full width, scaled to the series' own range.
 * A flat series would divide by zero, so it is drawn down the middle instead.
 */
export function sparkPath(values: number[], w: number, h: number): Spark | null {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const y = (v: number) => (span === 0 ? h / 2 : h - ((v - min) / span) * h);
  let d = "";
  for (let i = 0; i < values.length; i++) {
    const x = (i / (values.length - 1)) * w;
    d += (i ? " L " : "M ") + x.toFixed(1) + " " + y(values[i]).toFixed(1);
  }
  return { d, lastX: w, lastY: Number(y(values[values.length - 1]).toFixed(1)), min, max };
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
