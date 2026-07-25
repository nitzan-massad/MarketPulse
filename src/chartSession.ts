// Pure helper for the 1-day intraday chart's session state. Dependency-free (no React)
// so it can be unit-checked — see chartSession.check.ts.
//
// TwelveData's 1D feed returns the last 78 five-minute bars; mid-session that spills into
// the previous day, which is what made the old time axis look out of order. Keeping only
// the latest session both fixes that AND lets the chart draw a fixed 9:30–16:00 axis with
// the untraded remainder shaded.
export const SESSION_OPEN = 9 * 60 + 30; // 9:30 -> 570
export const SESSION_CLOSE = 16 * 60; // 16:00 -> 960

export interface SessionSlice {
  closes: number[];
  mins: number[]; // minute-of-day per kept bar, parallel to closes
  dStart: number; // x-domain start (minutes)
  dEnd: number; // x-domain end (minutes)
  lastMin: number; // minute of the latest bar ("now")
  live: boolean; // still before the close -> partial session, shade the remainder
}

// closes/stamps are parallel, oldest-first; stamps are "YYYY-MM-DD HH:MM".
// Returns null when the stamps aren't intraday-parseable or there are too few bars,
// so the caller can fall back to the plain index-based chart.
export function sessionSlice(closes: number[], stamps: string[]): SessionSlice | null {
  if (closes.length !== stamps.length || closes.length < 2) return null;
  const parsed = stamps.map((s) => {
    const [d, t] = (s || "").split(" ");
    if (!t) return null;
    const [hh, mm] = t.split(":").map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return { d, min: hh * 60 + mm };
  });
  if (parsed.some((p) => p === null)) return null;
  const p = parsed as { d: string; min: number }[];
  const lastDate = p[p.length - 1].d;
  const keep: number[] = [];
  for (let i = 0; i < p.length; i++) if (p[i].d === lastDate) keep.push(i);
  if (keep.length < 2) return null;
  const mins = keep.map((i) => p[i].min);
  const lastMin = mins[mins.length - 1];
  return {
    closes: keep.map((i) => closes[i]),
    mins,
    dStart: Math.min(SESSION_OPEN, mins[0]),
    dEnd: Math.max(SESSION_CLOSE, lastMin),
    lastMin,
    live: lastMin < SESSION_CLOSE - 2, // ~15:58 or later reads as done
  };
}

// minute-of-day -> "H:MM" (no timezone math; the exchange stamps are already local to it)
export function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = ("" + (min % 60)).padStart(2, "0");
  return `${h}:${m}`;
}
