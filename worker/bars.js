// CNBC's chart bars: the stock modal's chart, the P/E-history closes and a closed session's
// open/high/low (replacing Twelve Data, and Finnhub for off-hours O/H/L).
// Undocumented — the same endpoint cnbc.com's charts call. The SERVER owns every window (the
// client only names a range): CNBC doesn't cap them, and 5-minute bars for a year are 2 MB.
// Output keeps Twelve Data's stamp shapes, so the chart, its session logic and peHistory are
// unchanged: intraday "YYYY-MM-DD HH:MM", daily "YYYY-MM-DD", weekly = that week's Monday,
// monthly "YYYY-MM-01". Pure (no Workers globals): ci/test-cnbc-bars.mjs and ci/scrape-pe.mjs
// import it straight into Node.

export const CNBC_BARS = "https://ts-api.cnbc.com/harmony/app/bars/";

const MIN = 60_000;
const HOUR = 60 * MIN;
// back: how far before today (ET) the window starts. ttl: how long the Worker keeps an answer.
// PE: the P/E overlay's 5 years of weekly closes, split-adjusted ONLY (see splitOnlyCloses).
export const RANGES = Object.freeze({
  "1D": { int: "5M", back: { d: 5 }, ttl: MIN },
  "1W": { int: "30M", back: { d: 10 }, ttl: 5 * MIN },
  "1M": { int: "1D", back: { m: 1 }, ttl: HOUR },
  "3M": { int: "1D", back: { m: 3 }, ttl: HOUR },
  "6M": { int: "1D", back: { m: 6 }, ttl: HOUR },
  YTD: { int: "1D", ytd: true, ttl: HOUR },
  "1Y": { int: "1D", back: { y: 1 }, ttl: HOUR },
  "2Y": { int: "1D", back: { y: 2 }, ttl: HOUR },
  "5Y": { int: "1W", back: { y: 5 }, ttl: HOUR },
  ALL: { int: "1MO", all: true, ttl: 6 * HOUR },
  PE: { int: "1W", back: { y: 5, d: 21 }, ttl: 6 * HOUR },
  // A finished session's open/high/low (CNBC's quote zeroes them once the market closes). Keyed by
  // that session's date, so it never changes: cached for half a day.
  OHLC: { int: "1D", back: { d: 10 }, ttl: 12 * HOUR },
});

// A weekday at/after 09:30 New York time. No holiday calendar: on a weekday holiday the
// today-only window is empty and the Worker retries with the 5-day one.
export function sessionStarted(nowMs) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(nowMs));
  const g = (t) => p.find((x) => x.type === t).value;
  const mins = (parseInt(g("hour"), 10) % 24) * 60 + parseInt(g("minute"), 10);
  return !["Sat", "Sun"].includes(g("weekday")) && mins >= 9 * 60 + 30;
}

/** CNBC answered, but has no bars for this symbol/range (unknown symbol, no session in the window). */
export class NoData extends Error {}

const pad = (n, w = 2) => String(n).padStart(w, "0");
const fmt = ({ y, m, d }) => `${y}${pad(m)}${pad(d)}`;

/** Today's date in New York. */
export function etToday(nowMs) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(nowMs));
  const g = (t) => parseInt(p.find((x) => x.type === t).value, 10);
  return { y: g("year"), m: g("month"), d: g("day") };
}

// Calendar arithmetic on a {y,m,d}: months clamp to the month's last day (Mar 31 - 1M = Feb 28/29).
function shift({ y, m, d }, { y: dy = 0, m: dm = 0, d: dd = 0 }) {
  const months = y * 12 + (m - 1) - dy * 12 - dm;
  const ny = Math.floor(months / 12);
  const nm = (months % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const t = new Date(Date.UTC(ny, nm - 1, Math.min(d, last) - dd));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The upstream URL for a range. Day-granular start and end (end = tomorrow 00:00 ET), so the
 *  URL is identical for a whole ET day — CNBC's own cache then serves repeats in ~60 ms. */
export function barsUrl(sym, range, nowMs, adj = "adjusted", wide = false) {
  const cfg = RANGES[range];
  const today = etToday(nowMs);
  // 1D once today's session has begun: today only (~18 KB from CNBC, not 5 days' ~100 KB of
  // 04:00-20:00 bars — the cold answer is ~0.3 s faster). Before 09:30, on weekends, and as the
  // retry when today has no bars (a holiday: `wide`), 5 days reach back to the last session.
  const back = range === "1D" && !wide && sessionStarted(nowMs) ? { d: 0 } : cfg.back;
  const start = cfg.all ? { y: 1970, m: 1, d: 1 } : cfg.ytd ? { y: today.y - 1, m: 12, d: 20 } : shift(today, back);
  const end = shift(today, { d: -1 });
  return `${CNBC_BARS}${encodeURIComponent(sym)}/${cfg.int}/${fmt(start)}000000/${fmt(end)}000000/${adj}/EST5EDT.json`;
}

// "20261022093000" -> regular US session? (bar START in 09:30..15:55; the 16:00 bar is the
// closing auction, whose volume alone is ~3x the day's)
export const isRth = (tt) => {
  const hm = parseInt(tt.slice(8, 12), 10);
  return hm >= 930 && hm < 1600;
};

const ymdOf = (tt) => `${tt.slice(0, 4)}-${tt.slice(4, 6)}-${tt.slice(6, 8)}`;

/** The Monday of a bar's week, "YYYY-MM-DD" (CNBC stamps weeks on Sunday; Twelve Data, and
 *  every committed P/E cache, on Monday). */
export function mondayOf(tt) {
  const t = new Date(Date.UTC(+tt.slice(0, 4), +tt.slice(4, 6) - 1, +tt.slice(6, 8)));
  const dow = t.getUTCDay(); // 0 = Sunday
  t.setUTCDate(t.getUTCDate() + (dow === 0 ? 1 : 1 - dow));
  return t.toISOString().slice(0, 10);
}

// CNBC body -> oldest-first raw rows {tt, c}; junk closes dropped. Throws NoData / reshape Error.
function rows(body) {
  if (body?.status === "ERROR") throw new NoData(String(body.statusMessage || "no data"));
  const raw = body?.barData?.priceBars;
  if (!Array.isArray(raw)) throw new Error("cnbc bars: unexpected envelope");
  const out = [];
  for (const b of raw) {
    const tt = String(b?.tradeTime ?? "");
    const c = typeof b?.close === "number" ? b.close : Number(String(b?.close ?? "").replace(/,/g, ""));
    if (!/^\d{14}$/.test(tt) || !Number.isFinite(c) || c <= 0) continue;
    out.push({ tt, c: Math.round(c * 1e4) / 1e4 });
  }
  out.sort((a, b) => (a.tt < b.tt ? -1 : a.tt > b.tt ? 1 : 0));
  return out;
}

/** CNBC body -> { t, c } parallel arrays for `range`, oldest first. Closes only: the modal draws a
 *  line, and its day volume comes from the quote. ponytail: add o/h/l/v arrays when candles or a
 *  volume chart ship. */
export function parseBars(body, range, nowMs = Date.now()) {
  const cfg = RANGES[range];
  let r = rows(body);
  const intraday = cfg.int === "5M" || cfg.int === "30M";
  // ponytail: regular hours only (the chart's axis is 09:30-16:00, as Twelve Data's was);
  // returning the 04:00-20:00 bars behind an ?ext=1 is the upgrade if the chart ever draws them.
  if (intraday) {
    r = r.filter((x) => isRth(x.tt));
    const days = [...new Set(r.map((x) => x.tt.slice(0, 8)))];
    const keep = new Set(days.slice(range === "1D" ? -1 : -5));
    r = r.filter((x) => keep.has(x.tt.slice(0, 8)));
  }
  if (cfg.ytd) {
    // The last bar before Jan 1 anchors the year, so (last - first) / first is the true YTD.
    const y = String(etToday(nowMs).y);
    const firstThis = r.findIndex((x) => x.tt.slice(0, 4) === y);
    r = firstThis < 0 ? r.slice(-1) : r.slice(Math.max(0, firstThis - 1));
  }
  if (!r.length) throw new NoData("no bars in the window");
  const stamp = intraday
    ? (tt) => `${ymdOf(tt)} ${tt.slice(8, 10)}:${tt.slice(10, 12)}`
    : cfg.int === "1W"
      ? mondayOf
      : cfg.int === "1MO"
        ? (tt) => `${tt.slice(0, 4)}-${tt.slice(4, 6)}-01`
        : ymdOf;
  return { t: r.map((x) => stamp(x.tt)), c: r.map((x) => x.c) };
}

/** The open/high/low/close of the session dated `day` ("YYYY-MM-DD") from a daily-bar body.
 *  CNBC adds a session's daily bar once it has closed, which is exactly when its quote stops
 *  carrying open/high/low. No bar for that day (still trading, or a bad date) -> NoData. */
export function sessionOhlc(body, day) {
  if (body?.status === "ERROR") throw new NoData(String(body.statusMessage || "no data"));
  const raw = body?.barData?.priceBars;
  if (!Array.isArray(raw)) throw new Error("cnbc bars: unexpected envelope");
  const want = day.replace(/-/g, "");
  const b = raw.find((x) => String(x?.tradeTime ?? "").slice(0, 8) === want);
  const n = (v) => {
    const x = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(x) && x > 0 ? Math.round(x * 1e4) / 1e4 : null;
  };
  const o = n(b?.open), h = n(b?.high), l = n(b?.low), c = n(b?.close);
  if (o == null || h == null || l == null || c == null) throw new NoData(`no bar for ${day}`);
  return { day, o, h, l, c };
}

// Stock-split ratios (and their inverses, for reverse splits) recognised in the
// unadjusted/adjusted factor's steps.
const SPLITS = [1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 75, 80, 100, 150, 200];
const isSplit = (step) => SPLITS.some((s) => Math.abs(step / s - 1) < 0.01 || Math.abs(step * s - 1) < 0.01);

/** Split-adjusted-only closes from CNBC's `adjusted` (which also back-adjusts spin-offs and
 *  special dividends) and `unadjusted` series of the same weeks. The basis the P/E history needs:
 *  Finnhub's EPS is split-adjusted but not spin-adjusted (its own peTTM uses unadjusted prices), so
 *  a spin-adjusted price would chart CTVA's pre-spin P/E 6.7x too low. (Twelve Data was
 *  inconsistent here — split-only for CTVA, spin-adjusted for GE — so GE-like caches move once
 *  refetched, to the right values.) Walking newest -> oldest, a step in
 *  unadj/adj that is a split is kept; any other step (> 1%) is undone for every older week.
 *  Misaligned inputs (different weeks) -> the adjusted closes unchanged. */
export function splitOnlyCloses(adj, unadj) {
  if (adj.t.length !== unadj.t.length || adj.t.some((t, i) => t !== unadj.t[i])) return adj.c.slice();
  const n = adj.c.length;
  const out = adj.c.slice();
  let mult = 1;
  for (let i = n - 2; i >= 0; i--) {
    const step = unadj.c[i] / adj.c[i] / (unadj.c[i + 1] / adj.c[i + 1]);
    if (Math.abs(step - 1) > 0.01 && !isSplit(step)) mult *= step;
    out[i] = Math.round(adj.c[i] * mult * 1e4) / 1e4;
  }
  return out;
}
