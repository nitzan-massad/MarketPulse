// The stock modal's chart series from the Worker's /bars (CNBC) — the pure half, unit-checked
// in chartBars.check.ts. No `import.meta` here: the check compiles to CommonJS.
//
// The Worker already trims to regular hours, shifts weekly stamps to Monday and keeps Twelve
// Data's stamp shapes (worker/bars.js), so what is left for the client is:
//   - reading its body defensively,
//   - adding TODAY to the daily/weekly/monthly ranges — CNBC's bars stop at yesterday, and
//     without the live price a 1M/1Y % would ignore today's move,
//   - the 1D chart's dashed baseline.

export type BarKind = "intraday" | "day" | "week" | "month";
export interface Bars {
  stamps: string[];
  closes: number[];
}

/** Worker /bars body -> { stamps, closes }; anything malformed -> null (shown as "chart unavailable"). */
export function readBars(body: unknown): Bars | null {
  const b = body as { t?: unknown; c?: unknown } | null;
  if (!b || !Array.isArray(b.t) || !Array.isArray(b.c) || b.t.length !== b.c.length || !b.t.length) return null;
  const stamps: string[] = [];
  const closes: number[] = [];
  for (let i = 0; i < b.t.length; i++) {
    const t = b.t[i];
    const c = b.c[i];
    if (typeof t !== "string" || typeof c !== "number" || !(c > 0)) continue;
    stamps.push(t);
    closes.push(c);
  }
  return stamps.length ? { stamps, closes } : null;
}

const DAY = 86_400_000;
const ms = (ymd: string) => Date.parse(ymd.slice(0, 10) + "T00:00:00Z");
const ymdOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const mondayOf = (ymd: string) => {
  const t = ms(ymd);
  const dow = new Date(t).getUTCDay(); // 0 = Sunday
  return ymdOf(t - ((dow + 6) % 7) * DAY);
};

/** Today's live price on the end of a daily-type series (NEW arrays; the cached series is never
 *  mutated). day: append when `live.day` is after the last bar. week/month: replace the last
 *  close when it is the same week/month, else append the new week's Monday / month's 1st.
 *  Intraday, no live price, or live.day not after the last bar -> unchanged (pre-market,
 *  nights and weekends: the quote's day IS the last bar's, so there is no phantom bar). */
export function withLive(bars: Bars, live: { day: string; px: number } | null, kind: BarKind): Bars {
  const n = bars.stamps.length;
  if (kind === "intraday" || !live || !(live.px > 0) || !n) return bars;
  const last = bars.stamps[n - 1];
  if (kind === "day" && live.day <= last) return bars;
  const stamps = bars.stamps.slice();
  const closes = bars.closes.slice();
  if (kind === "day") {
    stamps.push(live.day);
    closes.push(live.px);
  } else {
    const key = kind === "week" ? mondayOf(live.day) : `${live.day.slice(0, 7)}-01`;
    if (key === last.slice(0, 10)) closes[n - 1] = live.px;
    else if (key > last) {
      stamps.push(key);
      closes.push(live.px);
    } else return bars; // the live price is older than the series' last bar
  }
  return { stamps, closes };
}

/** The 1D chart's dashed baseline (the previous session's close) for the session dated
 *  `sessionDate`: the quote's prior close when the quote is FOR that session; the quote's own
 *  price when the quote is still on an earlier session (the first minutes after 9:30, before
 *  CNBC rolls its quote — then its price IS the previous close); else the session's first close. */
export function sessionBase(
  sessionDate: string,
  firstClose: number,
  quote: { day: string | null; px: number | null; pc: number | null } | null,
): number {
  if (quote && !quote.day) return quote.pc != null && quote.pc > 0 ? quote.pc : firstClose; // Finnhub-priced: no day known
  if (quote?.day === sessionDate && quote.pc != null && quote.pc > 0) return quote.pc;
  if (quote?.day && quote.day < sessionDate && quote.px != null && quote.px > 0) return quote.px;
  return firstClose;
}
