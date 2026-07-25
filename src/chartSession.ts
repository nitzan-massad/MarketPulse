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
  live: boolean; // market is open RIGHT NOW -> partial session, shade the remainder
}

// Wall-clock "now" in US-Eastern (where TwelveData's US bars are stamped).
export interface EasternNow {
  date: string; // "YYYY-MM-DD"
  min: number; // minute-of-day
}

// closes/stamps are parallel, oldest-first; stamps are "YYYY-MM-DD HH:MM".
// `now` is the current US-Eastern wall clock; pass null when unknown (never claims live).
// Returns null when the stamps aren't intraday-parseable or there are too few bars,
// so the caller can fall back to the plain index-based chart.
export function sessionSlice(closes: number[], stamps: string[], now: EasternNow | null): SessionSlice | null {
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
  // Live ONLY if the latest bar is today's session AND the Eastern clock is inside
  // regular hours. On any non-trading day there's no bar dated today -> not live,
  // so an illiquid stock whose last print was before 16:00 no longer reads as open.
  const live = !!now && lastDate === now.date && now.min >= SESSION_OPEN && now.min < SESSION_CLOSE;
  return {
    closes: keep.map((i) => closes[i]),
    mins,
    dStart: Math.min(SESSION_OPEN, mins[0]),
    dEnd: Math.max(SESSION_CLOSE, lastMin),
    lastMin,
    live,
  };
}

// Is the US market open right now? Weekday + regular hours in Eastern. (Holidays aren't
// modeled — a rare weekday false-positive — but weekends/nights are correct.)
export function marketOpen(now: EasternNow = easternNow()): boolean {
  const [y, m, d] = now.date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12)).getUTCDay(); // 0=Sun … 6=Sat
  return dow >= 1 && dow <= 5 && now.min >= SESSION_OPEN && now.min < SESSION_CLOSE;
}

// Current US-Eastern wall clock, via Intl (handles DST). Browser/Node both have Date here.
export function easternNow(): EasternNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());
  const g: Record<string, string> = {};
  for (const x of parts) g[x.type] = x.value;
  let hh = parseInt(g.hour, 10);
  if (hh === 24) hh = 0; // some engines emit 24 at midnight
  return { date: `${g.year}-${g.month}-${g.day}`, min: hh * 60 + parseInt(g.minute, 10) };
}

// minute-of-day -> "H:MM" (no timezone math; the exchange stamps are already local to it)
export function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = ("" + (min % 60)).padStart(2, "0");
  return `${h}:${m}`;
}
