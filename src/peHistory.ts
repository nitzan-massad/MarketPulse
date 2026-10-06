// Historic trailing P/E for the stock modal's "P/E history" overlay.
//
// Inputs, all already fetched elsewhere: the 5Y weekly closes the price chart uses (Twelve
// Data), and two Finnhub series from the same /stock/metric?metric=all response the modal
// already makes: `series.quarterly.eps` and `series.quarterly.peTTM`.
//
// Per quarter we settle ONE trailing-12-month EPS in the price's currency, then every week's
// P/E is that week's close / the newest quarter's TTM that had been REPORTED by then:
//   - US filers: the sum of 4 consecutive quarters of EPS. Exact, and split-adjusted on both
//     sides (verified on NVDA/AVGO/WMT/CMG across their splits).
//   - Foreign filers report EPS in home currency per ordinary share (TSM: TWD, ~5x off; ASND
//     EUR, ~18% off). Finnhub's own quarterly peTTM is in the listing's currency, so for them
//     TTM = quarter-end close / peTTM — per quarter, so FX drift is followed too.
//   - No EPS series at all (banks: BAC) -> the same implied TTM from peTTM.
// Shared by ci/scrape-pe.mjs (imported directly) and the app's live fallback, so they cannot drift.

export interface EpsPoint {
  d: string; // quarter end, YYYY-MM-DD
  v: number; // EPS for that quarter (or, for a peTTM series, the P/E at that quarter end)
}
export interface PePoint {
  d: string;
  v: number | null; // null = gap: no positive TTM earnings, or not meaningful (see PE_MAX)
  loss?: true; // the gap is because trailing earnings were <= 0 — the chart marks it "Unprofitable"
  high?: true; // the gap is because the P/E was above PE_MAX — the chart marks it "Over 200×"
}

const DAY = 864e5;
/** Quarters are dated by period END but published weeks later. Using the end date leaked each
 *  quarter ~1 month early (AVGO's chart jumped 62x -> 129x six weeks before the report). */
export const REPORT_LAG_DAYS = 35;
/** No new quarter for this long after it would have been reported: stopped reporting. */
const STALE_DAYS = 200;
/** Adjacent quarter ends further apart than this are not consecutive quarters (a data hole,
 *  or a half-year filer whose 6-month figure would be summed as if it were 3). */
const MAX_QUARTER_GAP_DAYS = 120;
/** Not meaningful: beyond these a P/E says more about a one-off than about valuation (CRIS hit
 *  0.04x from a one-off gain; near-zero earnings make 1000x+). Shown as a gap.
 *  ponytail: fixed bounds; a per-stock percentile clip if these ever hide something real. */
export const PE_MAX = 200;
export const PE_MIN = 3; // loss-makers with a one-off gain otherwise chart a "median" of 2-3x
/** US filers' summed-EPS P/E sits within ~5% of Finnhub's; beyond this it is a currency gap. */
const CURRENCY_TOLERANCE = 0.07;

const days = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / DAY;

/** A Finnhub quarterly series (`eps`, `peTTM`) -> oldest-first points. Malformed rows dropped. */
export function parseEps(raw: unknown): EpsPoint[] {
  if (!Array.isArray(raw)) return [];
  const pts = raw
    .map((p) => ({ d: String((p as { period?: unknown }).period ?? ""), v: Number((p as { v?: unknown }).v) }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.d) && Number.isFinite(p.v))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  // Finnhub sometimes lists one quarter twice, under its fiscal AND calendar end (CAVA:
  // 2025-12-28 and 2025-12-31). Summed as two quarters that made CAVA's TTM ~4x too big.
  // Two "quarters" under 60 days apart are one: keep the later.
  const out: EpsPoint[] = [];
  for (const p of pts) {
    if (out.length && days(p.d, out[out.length - 1].d) < 60) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Sum of eps[i-3..i] when those are 4 consecutive quarters, else null. */
export function ttmSum(eps: EpsPoint[], i: number): number | null {
  if (i < 3) return null;
  let sum = eps[i].v;
  for (let k = i; k > i - 3; k--) {
    if (days(eps[k].d, eps[k - 1].d) > MAX_QUARTER_GAP_DAYS) return null;
    sum += eps[k - 1].v;
  }
  return sum;
}

/** The last weekly close ON OR BEFORE `d`. Twelve Data stamps a weekly bar with its Monday
 *  but the close is that Friday's, so the bar only counts once Monday + 4 days <= d. Taking
 *  the bar that merely STARTS by `d` paired BAC's 2025-03-31 (a Monday) quarter with the
 *  4 April post-tariff close and knocked its implied EPS ~15%: a +21% P/E step from nothing. */
export function closeAt(stamps: string[], closes: number[], d: string): number | null {
  for (let i = stamps.length - 1; i >= 0; i--) {
    const fri = days(d, stamps[i].slice(0, 10)) - 4; // days from that bar's Friday to d
    if (fri < 0) continue;
    return fri <= 10 && Number.isFinite(closes[i]) ? closes[i] : null;
  }
  return null;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** One TTM EPS per quarter end, in the price's currency (see the header for the rules). */
const SPLIT_FACTORS = [2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50, 100];

/** Finnhub sometimes leaves EPS from before a stock split unadjusted (ORLY 15:1 in 2025: 11.41
 *  then 0.63) while prices ARE adjusted, so TTMs straddling the split come out ~15x off. A
 *  quarter-to-quarter EPS drop where the pre-split TTM is a common split factor times Finnhub's
 *  own (adjusted) TTM for that same quarter is a split: earlier quarters are divided by it. A real
 *  earnings collapse has no such factor between the two, so it is left alone. */
export function adjustSplits(eps: EpsPoint[], implied: Map<string, number>): EpsPoint[] {
  const out = eps.map((p) => ({ ...p }));
  for (let k = out.length - 1; k > 0; k--) {
    const a = out[k - 1].v, b = out[k].v;
    if (!(a > 0 && b > 0) || a / b < 1.8) continue;
    // the split factor = pre-split TTM / Finnhub's adjusted TTM for that same quarter (exact,
    // unlike a/b, which also carries that quarter's real earnings change)
    const raw = ttmSum(out, k - 1);
    const adj = implied.get(out[k - 1].d);
    if (raw == null || adj == null || !(raw > 0)) continue; // no evidence: leave it
    const ratio = raw / adj;
    const f = SPLIT_FACTORS.reduce((best, x) => (Math.abs(Math.log(x / ratio)) < Math.abs(Math.log(best / ratio)) ? x : best));
    if (Math.abs(Math.log(f / ratio)) > Math.log(1.35)) continue; // not near a split factor: a real collapse
    for (let i = 0; i < k; i++) out[i].v /= f;
  }
  return out;
}

export function quarterTtm(epsRaw: EpsPoint[], peq: EpsPoint[], stamps: string[], closes: number[]): EpsPoint[] {
  const implied = new Map<string, number>();
  for (const p of peq) {
    const c = p.v > 0 ? closeAt(stamps, closes, p.d) : null;
    if (c != null) implied.set(p.d, c / p.v);
  }
  const eps = adjustSplits(epsRaw, implied);
  const sums = new Map<string, number>();
  eps.forEach((p, i) => {
    const s = ttmSum(eps, i);
    if (s != null) sums.set(p.d, s);
  });
  // how far the summed EPS sits from the listing-currency one: ~1 for US filers
  const ratios: number[] = [];
  for (const [d, s] of sums) {
    const im = implied.get(d);
    if (im != null && s > 0) ratios.push(im / s);
  }
  const r = ratios.length ? median(ratios) : 1;
  const foreign = Math.abs(r - 1) > CURRENCY_TOLERANCE;

  const out: EpsPoint[] = [];
  for (const d of [...new Set([...sums.keys(), ...implied.keys()])].sort()) {
    const s = sums.get(d);
    const im = implied.get(d);
    // a loss quarter has no positive peTTM, so `im` is absent and the (negative) sum carries it.
    // A non-positive sum while Finnhub's own TTM is positive is a bad EPS row on our side:
    // Finnhub's figure wins.
    let v = !foreign && s != null && !(s <= 0 && im != null) ? s : im != null ? im : s != null ? s * r : null;
    // A foreign filer's implied TTM that is way off its own currency-adjusted sum is one bad
    // Finnhub peTTM row (ONON Q3-24: 209x), not a currency gap: the adjusted sum wins.
    if (foreign && im != null && s != null && s > 0 && (im / (s * r) > 1.5 || (s * r) / im > 1.5)) v = s * r;
    if (v != null) out.push({ d, v });
  }
  return out;
}

/** Weekly P/E. Stamps may carry a time; only the date is used.
 *  `reports` maps a quarter end to the day its results were announced (SEC filings, see
 *  ci/sec-reports.mjs), matched within a week to absorb 52/53-week fiscal calendars. A quarter
 *  with no known date falls back to the REPORT_LAG_DAYS guess. */
export function peSeries(
  stamps: string[], closes: number[], eps: EpsPoint[], peq: EpsPoint[] = [], reports: Record<string, string> = {},
): PePoint[] {
  const q = quarterTtm(eps, peq, stamps, closes);
  const keys = Object.keys(reports);
  const reportOf = (d: string) => {
    const k = keys.find((r) => Math.abs(days(r, d)) <= 7);
    const at = k ? reports[k] : undefined;
    return at && at > d && days(at, d) < 200 ? at : undefined;
  };
  const eff = q.map((x) => reportOf(x.d));
  const effective = (k: number, fri: string) => (eff[k] ? fri >= eff[k]! : days(fri, q[k].d) >= REPORT_LAG_DAYS);
  let j = -1;
  // A price that halves or doubles in one week while no new quarter lands is a corporate action
  // (CTVA's spin-off: 78.52 -> 11.92) that the old per-share EPS doesn't reflect. Blank the
  // weeks from that break until the next quarter is reported, instead of charting a fake collapse.
  let brokenAt = -2;
  return stamps.map((s, i) => {
    const d = s.slice(0, 10);
    // the bar is stamped Monday but closes Friday: judge "reported yet?" at the close
    const fri = new Date(Date.parse(d) + 4 * DAY).toISOString().slice(0, 10);
    const before = j;
    while (j + 1 < q.length && effective(j + 1, fri)) j++;
    if (j !== before) brokenAt = -2;
    else if (i > 0 && closes[i - 1] > 0 && (closes[i] / closes[i - 1] < 0.5 || closes[i] / closes[i - 1] > 2)) brokenAt = j;
    if (j < 0 || days(fri, q[j].d) > REPORT_LAG_DAYS + STALE_DAYS || brokenAt === j) return { d, v: null };
    const ttm = q[j].v;
    if (ttm <= 0) return { d, v: null, loss: true };
    const pe = Number.isFinite(closes[i]) ? closes[i] / ttm : null;
    if (pe != null && pe > PE_MAX) return { d, v: null, high: true };
    return { d, v: pe != null && pe >= PE_MIN ? pe : null };
  });
}

/** The points within the last `years` of the series (by the newest date). */
export function lastYears(pts: PePoint[], years: number): PePoint[] {
  if (!pts.length) return pts;
  const end = Date.parse(pts[pts.length - 1].d);
  return pts.filter((p) => end - Date.parse(p.d) <= years * 365.25 * DAY);
}

export interface PeStats { lo: number; hi: number; med: number }
export function peStats(pts: PePoint[]): PeStats | null {
  const v = pts.map((p) => p.v).filter((x): x is number => x != null);
  if (v.length < 2) return null;
  return { lo: Math.min(...v), hi: Math.max(...v), med: median(v) };
}

/** Worth a chart: at least half a year of weeks with a P/E (counting "over 200x" weeks, so a
 *  richly valued grower like DDOG still gets one). */
export const hasPeHistory = (pts: PePoint[]): boolean => pts.filter((p) => p.v != null || p.high).length >= 26;

/** Axis ticks: a "nice" step giving ~4-6 lines across [lo, hi] (NVDA's 25-243 got 24 before). */
export function niceTicks(lo: number, hi: number): number[] {
  if (!(hi > lo)) [lo, hi] = [lo - 1, hi + 1];
  const raw = (hi - lo) / 5;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(6));
  if (out[out.length - 1] < hi) out.push(+(out[out.length - 1] + step).toFixed(6));
  return out;
}
