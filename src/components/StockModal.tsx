import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { easternNow, type EasternNow, fmtMin, marketOpen, nearestIndex, sessionSlice } from "../chartSession";
import { fetchForecasts, type Forecast } from "../forecasts";
import { trackedPayload, useTrackedRev } from "../stocks";
import sectorPe from "../data/sectors.json";
import { consClass, consLabel, DATE_LOCALE, fmtMc, pxDp } from "../lib";
import { reviewKey } from "../reviewAlerts";
import type { Stock } from "../types";
import { tickerTarget, type TickerView } from "../share";
import { useShare } from "../useShare";
import { useTrackRequest, type Mark, type MarkEntry } from "../watchlist";
import type { User } from "firebase/auth";
import ShareBurst from "./ShareBurst";
import CloseButton from "./CloseButton";
import ShareButton, { ShareFail } from "./ShareButton";
import ThumbMark from "./ThumbMark";
import PeHistory from "./PeHistory";
import { parseEps, type EpsPoint } from "../peHistory";
import { earningsParts, fromEntry, todayYmd, type Earnings } from "../earnings";
import { etClock, extNow, mergeModal, sessionOf, needsFhQuote, normSym, quoteStale, type CnbcQuote, type Session } from "../quotes";
import { readBars, sessionBase, withLive, type BarKind } from "../chartBars";
import { WORKER_URL } from "../workerUrl";
import { freshQuote } from "../quoteStore";

// Keys come from build-time env (same pattern App uses for Finnhub). Never hardcoded.
const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_KEY ?? "";
const TWELVEDATA_KEY = import.meta.env.VITE_TWELVEDATA_KEY ?? "";
// FMP powers the live company description ONLY for tickers missing from the
// scraped DB (hybrid: DB desc wins). Optional — absent key just skips it.
const FMP_KEY = import.meta.env.VITE_FMP_KEY ?? "";


// Apple Stocks universal link — opens the Stocks app on iOS/macOS, web elsewhere.
const stocksUrl = (ticker: string) =>
  `https://stocks.apple.com/symbol/${encodeURIComponent(ticker)}`;

type RangeId = "1D" | "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "2Y" | "5Y" | "ALL";

const RANGES: RangeId[] = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y", "2Y", "5Y", "ALL"];
const DEFAULT_RANGE: RangeId = "1D";

// range -> bar kind + how long a fetched series is reused (the window itself lives in the
// Worker, worker/bars.js); `td` = the Twelve Data fallback's interval + outputsize.
const MIN = 60_000;
const RANGE_CFG: Record<RangeId, { kind: BarKind; ttl: number; td: { interval: string; outputsize: number } }> = {
  "1D": { kind: "intraday", ttl: MIN, td: { interval: "5min", outputsize: 78 } },
  "1W": { kind: "intraday", ttl: 5 * MIN, td: { interval: "30min", outputsize: 66 } },
  "1M": { kind: "day", ttl: 60 * MIN, td: { interval: "1day", outputsize: 22 } },
  "3M": { kind: "day", ttl: 60 * MIN, td: { interval: "1day", outputsize: 66 } },
  "6M": { kind: "day", ttl: 60 * MIN, td: { interval: "1day", outputsize: 130 } },
  YTD: { kind: "day", ttl: 60 * MIN, td: { interval: "1day", outputsize: 200 } },
  "1Y": { kind: "day", ttl: 60 * MIN, td: { interval: "1day", outputsize: 252 } },
  "2Y": { kind: "day", ttl: 60 * MIN, td: { interval: "1day", outputsize: 520 } },
  "5Y": { kind: "week", ttl: 60 * MIN, td: { interval: "1week", outputsize: 260 } },
  ALL: { kind: "month", ttl: 360 * MIN, td: { interval: "1month", outputsize: 600 } },
};

interface Quote {
  c: number | null; // current
  dp: number | null; // day %
  o: number | null; // open
  h: number | null; // high
  l: number | null; // low
  pc: number | null; // prev close
  v?: number | null; // the session's volume (CNBC only)
}

interface Metric {
  hi52: number | null;
  lo52: number | null;
  pe: number | null;
  fwdPe: number | null; // consensus forward P/E; absent for loss-makers (~47% of the universe)
  epsTtm: number | null; // trailing EPS — for the live price/EPS P/E (Apple Stocks style)
  beta: number | null;
  avgVol3M: number | null;
  avgVol10D: number | null;
  epsQ: EpsPoint[]; // quarterly EPS history (Finnhub series) — drives the P/E history overlay
  peQ: EpsPoint[]; // quarterly peTTM (Finnhub series) — the foreign-filer / bank anchor for it
}

// live company profile (name / industry / market cap) — replaces the scraped
// DB fields so these are current for any ticker, ranked or not
interface Profile {
  name: string | null;
  sector: string | null;
  mktCap: number | null; // $ millions (same unit as the DB `mc`)
}

interface Series {
  closes: number[];
  stamps: string[]; // bar datetimes, parallel to closes (oldest-first)
}

// module-level caches so reopening / re-selecting ranges never refetches
// Which tickers CI has a P/E history file for (public/pe/_asOf.json, ci/scrape-pe.mjs).
// Fetched once per page load and shared; a failed fetch just means "rely on live EPS".
type PeIndex = Record<string, { ok: boolean; err?: boolean; wait?: boolean }>;
let peIndexP: Promise<PeIndex> | null = null;
const loadPeIndex = (): Promise<PeIndex> =>
  (peIndexP ??= fetch(`${import.meta.env.BASE_URL}pe/_asOf.json`)
    .then((r): Promise<PeIndex> | PeIndex => (r.ok ? r.json() : {}))
    .catch((): PeIndex => ({})));

// Next earnings dates for every listed company (public/earnings.json, ci/scrape-earnings.mjs).
// Fetched once per page load; a failed fetch resolves null and only hides the earnings line
// (never the "not announced" placeholder — that would claim something we don't know).
type EarningsIndex = Record<string, unknown>;
let earningsP: Promise<EarningsIndex | null> | null = null;
const loadEarnings = (): Promise<EarningsIndex | null> =>
  (earningsP ??= fetch(`${import.meta.env.BASE_URL}earnings.json`)
    .then((r): Promise<{ e?: EarningsIndex }> | null => (r.ok ? r.json() : null))
    .then((j) => (j?.e && typeof j.e === "object" ? j.e : null))
    .catch(() => null));

const GHOST_LABEL: Record<Session, string> = {
  regular: "MARKET OPEN",
  pre: "NO PRE-MARKET TRADES",
  post: "NO AFTER-HOURS TRADES",
  closed: "MARKET CLOSED",
};

const NO_EPS: EpsPoint[] = []; // stable empty list, so PeHistory's effect doesn't refire every render
// live: CNBC's fresh quote day + price — today's point on the daily/weekly/monthly charts and
// the 1D baseline's session. null when CNBC is missing or stale (Finnhub-priced).
type QuoteMetric = { quote: Quote; metric: Metric; profile: Profile; ext: CnbcQuote["ext"]; live: { day: string; px: number } | null };
// The live half (CNBC quote, and Finnhub's /quote when needed) expires after a minute so a
// reopened modal shows a current price; Finnhub's metric + profile2 barely move and share the
// one key's 60/min with every visitor, so they are kept for the page's life.
const QUOTE_TTL_MS = 60_000;
const liveQuoteCache = new Map<string, { cq: CnbcQuote | null; fqRaw: Record<string, unknown> | null; at: number }>();
const fundamentalsCache = new Map<string, { mRes: Record<string, unknown> | null; pRes: Record<string, unknown> | null }>();
const seriesCache = new Map<string, { s: Series; at: number }>();
const PE_TTL_MS = 6 * 60 * MIN;
const warmed = new Set<string>(); // stocks whose other ranges were prefetched this page
let warmGen = 0; // bumped by each new warm-up: an older one (a stock paged away from) stops

// Bulls Say / Bears Say — a static per-ticker snapshot scraped from TipRanks'
// free preview (the full list is paywalled). Lazy-fetched from public/bullbear/,
// so it survives CI data refreshes. Absent file -> panel shows "not available".
interface BBPoint {
  t: string; // point title
  b: string; // point body
}
interface BullBear {
  bull: BBPoint[];
  bear: BBPoint[];
  asOf?: string; // YYYY-MM-DD the scrape last refreshed this ticker
}
const bbCache = new Map<string, BullBear | null>();
async function fetchBullBear(ticker: string): Promise<BullBear | null> {
  // tracked-only ticker (not bundled yet): its payload came with RTDB trackedRows. Checked ahead of
  // the cache — a ticker opened before CI published it cached a 404's null.
  const tracked = (await trackedPayload(ticker, "bullbear")) as Partial<BullBear> | null | undefined;
  if (tracked === undefined && bbCache.has(ticker)) return bbCache.get(ticker)!;
  let val: BullBear | null = null;
  try {
    let j = tracked;
    if (j === undefined) {
      const r = await fetch(`${import.meta.env.BASE_URL}bullbear/${encodeURIComponent(ticker)}.json`);
      j = r.ok ? await r.json() : null;
    }
    if (j && ((j.bull && j.bull.length) || (j.bear && j.bear.length)))
      val = { bull: j.bull || [], bear: j.bear || [], asOf: j.asOf };
  } catch {
    /* missing / offline -> not available */
  }
  if (tracked === undefined) bbCache.set(ticker, val);
  return val;
}

// Forecast type + fetchForecasts now live in ../forecasts (shared with the review detector).

// Company description for off-universe tickers (those with no scraped DB desc).
// Source order: (1) baked public/desc.json — hand-scraped from TipRanks for the
// bull/bear set, no key needed; (2) FMP live, if a key is configured.
const descCache = new Map<string, string | null>();
let descMap: Record<string, string> | null = null;
async function loadDescMap(): Promise<Record<string, string>> {
  if (descMap) return descMap;
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}desc.json`);
    descMap = r.ok ? await r.json() : {};
  } catch {
    descMap = {};
  }
  return descMap!;
}
async function fetchDescription(ticker: string): Promise<string | null> {
  if (descCache.has(ticker)) return descCache.get(ticker)!;
  const map = await loadDescMap();
  let val: string | null = map[ticker] || null;
  if (!val && FMP_KEY) {
    try {
      const r = await fetch(
        `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(ticker)}?apikey=${FMP_KEY}`,
      );
      if (r.ok) {
        const j = await r.json();
        const d = Array.isArray(j) && j[0] && typeof j[0].description === "string" ? j[0].description.trim() : "";
        if (d) val = d;
      }
    } catch {
      /* offline / blocked -> no description */
    }
  }
  descCache.set(ticker, val);
  return val;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && isFinite(n) ? n : null;
};

// dp defaults to the shared price rule (cents, or 4dp under a cent) — a flat 2dp here
// printed a real sub-penny quote as "$0.00" in the modal long after the table stopped.
// An explicit dp still wins, for the axis ticks that size their own precision.
// Thousands are grouped ($1,281.91) on the integer part only.
const usd = (v: number | null | undefined, dp?: number): string =>
  v == null ? "—" : "$" + (dp == null ? pxDp(v) : v.toFixed(dp)).replace(/\d+/, (i) => i.replace(/\B(?=(\d{3})+$)/g, ","));

const pct = (v: number | null | undefined): string =>
  v == null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2) + "%";

// compact volume: 169.9M / 4.7B
function fmtVol(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

// CNBC (via the Worker) for the quote and most fundamentals; Finnhub per missing field.
// Finnhub's metric + profile2 still run: CNBC has no P/E history, sector or 3-month volume.
// Outside the session CNBC zeroes open/high/low: they come from the closed session's daily bar
// (Worker /bars?range=OHLC). Finnhub's /quote only runs when CNBC has no fresh quote or no bar.
async function fetchCnbc(ticker: string): Promise<CnbcQuote | null> {
  const held = freshQuote(ticker); // the table's poll / a search prefetch already has it
  if (held) return held;
  const k = normSym(ticker);
  if (!k) return null;
  try {
    const r = await fetch(`${WORKER_URL}/quotes?symbols=${encodeURIComponent(k)}`, {
      signal: AbortSignal.timeout(10_000), // a hung CNBC must not hold back Finnhub's half
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.quotes?.[k] ?? null;
  } catch {
    return null;
  }
}
// What the modal can show the instant it opens, from a CNBC quote the page already holds: price,
// day move, prior close, volume, 52-week range, P/E, EPS, beta, market cap (and in the session
// open/high/low). The rest (sector, 3-month volume, EPS history, off-hours O/H/L) and the chart
// still load as before and fill in over it. A stale held quote seeds nothing: its headline would
// be empty, and the skeletons are what keep the snapshot price from flashing first.
function instantQuoteMetric(ticker: string): QuoteMetric | null {
  const cq = freshQuote(ticker);
  if (!cq || quoteStale(cq, etClock())) return null;
  const m = mergeModal(cq, null, null, null);
  return {
    quote: m.quote,
    metric: { ...m.metric, epsQ: NO_EPS, peQ: NO_EPS },
    profile: m.profile,
    ext: cq.ext ?? null,
    live: cq.day ? { day: cq.day, px: cq.px } : null,
  };
}

// The closed session's open/high/low from the Worker (CNBC's daily bar), or null.
async function sessionOhlc(ticker: string, day: string): Promise<{ o: number; h: number; l: number } | null> {
  const k = normSym(ticker);
  if (!k) return null;
  try {
    const r = await fetch(`${WORKER_URL}/bars?symbol=${encodeURIComponent(k)}&range=OHLC&day=${day}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.o > 0 && j?.h > 0 && j?.l > 0 ? { o: j.o, h: j.h, l: j.l } : null;
  } catch {
    return null;
  }
}

const finnhub = (path: string): Promise<Record<string, unknown> | null> =>
  FINNHUB_KEY
    ? fetch(`https://finnhub.io/api/v1/${path}&token=${FINNHUB_KEY}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    : Promise.resolve(null);

async function fetchQuoteMetric(ticker: string): Promise<QuoteMetric> {
  const enc = encodeURIComponent(ticker);
  const liveHit = liveQuoteCache.get(ticker);
  const live = liveHit && Date.now() - liveHit.at < QUOTE_TTL_MS ? liveHit : null;
  const fund = fundamentalsCache.get(ticker);
  // The quote half runs beside Finnhub's metric + profile, not after them.
  const quoteHalf = async (): Promise<{ cq: CnbcQuote | null; qRes: Record<string, unknown> | null }> => {
    // a newer quote the page holds beats the 60 s cache's copy (no price jumping backwards)
    if (live) return { cq: freshQuote(ticker) ?? live.cq, qRes: live.fqRaw };
    const cq = await fetchCnbc(ticker);
    // A frozen previous-day CNBC quote mid-session gives the live half to Finnhub, as the table does.
    const fresh = quoteStale(cq, etClock()) ? null : cq;
    if (!needsFhQuote(fresh)) return { cq, qRes: null };
    // Off-hours CNBC zeroes open/high/low, but the session that just closed has a daily bar with
    // them (Worker /bars?range=OHLC, cached half a day): no Finnhub call. Finnhub's /quote only
    // when CNBC has no fresh quote, or no bar for that session yet.
    if (fresh?.day) {
      const ohlc = await sessionOhlc(ticker, fresh.day);
      if (ohlc) return { cq, qRes: ohlc };
    }
    return { cq, qRes: await finnhub(`quote?symbol=${enc}`) };
  };
  const [{ cq, qRes }, mRes, pRes] = await Promise.all([
    quoteHalf(),
    fund?.mRes ?? finnhub(`stock/metric?symbol=${enc}&metric=all`),
    fund?.pRes ?? finnhub(`stock/profile2?symbol=${enc}`),
  ]);
  const stale = quoteStale(cq, etClock());
  if (!cq && !mRes && !pRes && !qRes) throw new Error("no quote source answered"); // keep snapshot, retry next open
  if (!live && (cq || qRes)) liveQuoteCache.set(ticker, { cq, fqRaw: qRes, at: Date.now() }); // a miss is retried next open
  // Only the halves that answered: a failed one (say a 429) is asked again next open.
  if (mRes || pRes) fundamentalsCache.set(ticker, { mRes, pRes });

  const m = ((mRes?.metric as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const series = mRes?.series as { quarterly?: { eps?: unknown; peTTM?: unknown } } | undefined;
  const fq = qRes
    ? { c: num(qRes.c), dp: num(qRes.dp), o: num(qRes.o), h: num(qRes.h), l: num(qRes.l), pc: num(qRes.pc) }
    : null;
  // Finnhub answers an unknown symbol with all-zero quote fields: 0 is "no price", not $0.
  if (fq) for (const k of ["c", "o", "h", "l", "pc"] as const) if (fq[k] === 0) fq[k] = null;
  const fm = mRes
    ? {
        hi52: num(m["52WeekHigh"]),
        lo52: num(m["52WeekLow"]),
        pe: num(m.peTTM) ?? num(m.peBasicExclExtraTTM),
        // Finnhub omits the key entirely (not null) when there's no forward estimate
        fwdPe: num(m.forwardPE),
        epsTtm: num(m.epsTTM) ?? num(m.epsBasicExclExtraTTM),
        beta: num(m.beta),
        avgVol3M: num(m["3MonthAverageTradingVolume"]),
        avgVol10D: num(m["10DayAverageTradingVolume"]),
      }
    : null;
  const fp = pRes
    ? {
        name: typeof pRes.name === "string" && pRes.name ? pRes.name : null,
        sector: typeof pRes.finnhubIndustry === "string" && pRes.finnhubIndustry ? pRes.finnhubIndustry : null,
        mktCap: num(pRes.marketCapitalization),
      }
    : null;
  const merged = mergeModal(cq, fq, fm, fp, stale);
  const result: QuoteMetric = {
    quote: merged.quote,
    metric: { ...merged.metric, epsQ: parseEps(series?.quarterly?.eps), peQ: parseEps(series?.quarterly?.peTTM) },
    profile: merged.profile,
    ext: cq?.ext ?? null,
    live: !stale && cq?.day ? { day: cq.day, px: cq.px } : null,
  };
  return result;
}

// Chart bars from the Worker's /bars (CNBC, no key, cached server-side); Twelve Data only as the
// fallback when /bars fails (404/502/timeout). A 400 is our bug, so no fallback. "PE" = the
// P/E overlay's 5 years of weekly closes, split-adjusted only (worker/bars.js splitOnlyCloses).
// ponytail: the Twelve Data fallback stays while CNBC bars is new; delete fetchSeriesTD and
// VITE_TWELVEDATA_KEY after a few weeks without fallback hits.
// `warm`: a background prefetch — /bars only, never the metered Twelve Data fallback.
async function fetchSeries(ticker: string, range: RangeId | "PE", warm = false): Promise<Series> {
  const sym = normSym(ticker);
  const key = `${sym ?? ticker}|${range}`;
  const ttl = range === "PE" ? PE_TTL_MS : RANGE_CFG[range].ttl;
  const hit = seriesCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.s;
  let s: Series | null = null;
  let fallback = true;
  if (sym) {
    try {
      const r = await fetch(`${WORKER_URL}/bars?symbol=${encodeURIComponent(sym)}&range=${range}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) s = readBars(await r.json());
      else if (r.status === 400) fallback = false;
    } catch {
      /* network / timeout -> fallback */
    }
  }
  if (!s && fallback && !warm) s = await fetchSeriesTD(ticker, range === "PE" ? "5Y" : range);
  if (!s) throw new Error("no series");
  seriesCache.set(key, { s, at: Date.now() }); // failures are never cached: the next open retries
  return s;
}

async function fetchSeriesTD(ticker: string, range: RangeId): Promise<Series> {
  if (!TWELVEDATA_KEY) throw new Error("no twelvedata key");
  const { interval, outputsize } = RANGE_CFG[range].td;
  const res = await fetch(
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVEDATA_KEY}`,
  ).then((r) => r.json());
  // TD returns newest-first values[]; error responses have status:"error"
  const raw: unknown[] = Array.isArray(res?.values) ? res.values : [];
  if (res?.status === "error" || raw.length === 0) throw new Error("no series");
  const clean = raw
    .map((v) => {
      const b = v as Record<string, string>;
      return { t: b.datetime, c: parseFloat(b.close) };
    })
    .reverse() // -> oldest-first for plotting
    .filter((b) => isFinite(b.c));
  if (clean.length === 0) throw new Error("no closes");
  return { closes: clean.map((b) => b.c), stamps: clean.map((b) => b.t) };
}

// Apple-Stocks-style chart geometry, in a fixed 600x140 SVG box (scales uniformly
// via height:auto, so text drawn inside is undistorted). Right gutter holds price
// labels; bottom strip holds date/time labels.
const CW = 600;
const CH = 140;
const C_PAD = 12; // top breathing room
const C_R = 44; // right gutter for price labels
const C_B = 16; // bottom strip for date labels

interface ChartModel {
  line: string;
  area: string;
  lastX: number;
  lastY: number;
  up: boolean;
  baseY: number; // dashed reference line (1D: prev close; other ranges: opening price)
  priceTicks: { y: number; label: string }[];
  dateTicks: { x: number; label: string; future?: boolean }[]; // future = time not yet traded
  remaining?: { x: number; w: number }; // 1D live: shaded untraded strip to 16:00
  live?: boolean; // 1D: session still open
  nowLabel?: string; // 1D live: "H:MM" of the latest bar
  pts: { x: number; y: number; v: number; s: string }[]; // every plotted point — drives the scrubber
}

// "nice" round axis values within [lo,hi] (e.g. 134,136,138 — not 134.7)
function niceTicks(lo: number, hi: number, count = 4): number[] {
  const raw = (hi - lo || 1) / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

// daily -> locale numeric day/month (device order, digits only); intraday -> "HH:MM".
// Date built from local parts so there's no timezone day-shift.
function fmtStamp(s: string, intraday: boolean): string {
  const [d, t] = s.split(" ");
  if (intraday && t) return t.slice(0, 5);
  const [y, mo, da] = d.split("-").map(Number);
  return new Date(y, mo - 1, da).toLocaleDateString(DATE_LOCALE, { month: "numeric", day: "numeric" });
}

// scrubber label: intraday -> "24 Jul, 20:35"; daily -> "24 Jul 2026"
function fmtScrub(s: string, intraday: boolean): string {
  const [d, t] = (s || "").split(" ");
  const [y, mo, da] = (d || "").split("-").map(Number);
  if (!y) return s || "";
  const date = new Date(y, (mo || 1) - 1, da || 1);
  if (intraday && t) {
    return `${date.toLocaleDateString(DATE_LOCALE, { day: "numeric", month: "short" })}, ${t.slice(0, 5)}`;
  }
  return date.toLocaleDateString(DATE_LOCALE, { day: "numeric", month: "short", year: "numeric" });
}

// month + 2-digit year (e.g. "Jul '24") for ranges that span multiple years (2Y/5Y/ALL)
function fmtStampLong(s: string): string {
  const [y, mo] = (s.split(" ")[0] || "").split("-").map(Number);
  return new Date(y, (mo || 1) - 1, 1).toLocaleDateString(DATE_LOCALE, { month: "short" }) + " '" + String(y).slice(2);
}

function buildChart(
  closes: number[],
  stamps: string[],
  intraday: boolean,
  opts: { is1D?: boolean; quote?: { day: string | null; px: number | null; pc: number | null } | null; now?: EasternNow | null } = {},
): ChartModel {
  const plotR0 = CW - C_R;
  const plotB0 = CH - C_B;

  // 1D intraday: fixed 9:30–16:00 axis over the latest session, remainder shaded (#3).
  const slice = intraday && opts.is1D ? sessionSlice(closes, stamps, opts.now ?? null) : null;
  if (slice) {
    const c = slice.closes;
    const base = sessionBase(slice.date, c[0], opts.quote ?? null);
    const lo = Math.min(...c, base), hi = Math.max(...c, base), span = hi - lo || 1;
    const x = (min: number) => 6 + ((min - slice.dStart) / (slice.dEnd - slice.dStart)) * (plotR0 - 6);
    const y = (v: number) => C_PAD + (1 - (v - lo) / span) * (plotB0 - C_PAD);
    const pts = c.map((v, i) => `${x(slice.mins[i]).toFixed(1)} ${y(v).toFixed(1)}`);
    const line = "M" + pts.join(" L");
    const lastX = x(slice.lastMin), lastY = y(c[c.length - 1]);
    const area = `${line} L${lastX.toFixed(1)} ${plotB0} L${x(slice.dStart).toFixed(1)} ${plotB0} Z`;
    const dp = hi >= 100 ? 0 : hi >= 10 ? 1 : hi >= 0.01 ? 2 : 4; // 4dp under a cent, or every tick reads 0.00
    const priceTicks = niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi).map((v) => ({ y: y(v), label: v.toFixed(dp) }));
    const dateTicks = [570, 660, 750, 840, 960] // 9:30, 11:00, 12:30, 14:00, 16:00
      .filter((m) => m >= slice.dStart && m <= slice.dEnd)
      .map((m) => ({ x: x(m), label: fmtMin(m), future: m > slice.lastMin }));
    return {
      line, area, lastX, lastY,
      up: c[c.length - 1] >= base,
      baseY: y(base),
      priceTicks, dateTicks,
      remaining: slice.live ? { x: lastX, w: plotR0 - lastX } : undefined,
      live: slice.live,
      nowLabel: fmtMin(slice.lastMin),
      // the kept session is the tail of `stamps`, so map back for a date+time label
      pts: c.map((v, i) => ({
        x: x(slice.mins[i]),
        y: y(v),
        v,
        s: fmtScrub(stamps[stamps.length - c.length + i] || "", true),
      })),
    };
  }

  const n = closes.length;
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  const plotR = CW - C_R;
  const plotB = CH - C_B;
  const x = (i: number) => (n === 1 ? plotR : (i / (n - 1)) * (plotR - 6) + 6);
  const y = (v: number) => C_PAD + (1 - (v - lo) / span) * (plotB - C_PAD);

  const pts = closes.map((v, i) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`);
  const line = "M" + pts.join(" L");
  const lastX = x(n - 1);
  const lastY = y(closes[n - 1]);
  const area = `${line} L${lastX.toFixed(1)} ${plotB} L${x(0).toFixed(1)} ${plotB} Z`;

  const dp = hi >= 100 ? 0 : hi >= 10 ? 1 : hi >= 0.01 ? 2 : 4; // 4dp under a cent, or every tick reads 0.00
  const priceTicks = niceTicks(lo, hi, 4)
    .filter((v) => v >= lo && v <= hi)
    .map((v) => ({ y: y(v), label: v.toFixed(dp) }));

  const nLbl = Math.min(6, n);
  const denom = Math.max(1, nLbl - 1);
  // multi-year ranges (2Y/5Y/ALL) show month + year so labels aren't ambiguous
  const multiYear = !intraday && n > 1 && (stamps[0] || "").slice(0, 4) !== (stamps[n - 1] || "").slice(0, 4);
  const dateTicks = Array.from({ length: nLbl }, (_, k) => {
    const i = Math.round((k / denom) * (n - 1));
    const stamp = stamps[i] || "";
    return { x: x(i), label: multiYear ? fmtStampLong(stamp) : fmtStamp(stamp, intraday) };
  });

  return {
    line,
    area,
    lastX,
    lastY,
    up: closes[n - 1] >= closes[0],
    baseY: y(closes[0]),
    priceTicks,
    dateTicks,
    pts: closes.map((v, i) => ({ x: x(i), y: y(v), v, s: fmtScrub(stamps[i] || "", intraday) })),
  };
}

// Confetti rain over the "We're on it" sheet: 40 pieces, fixed once so a re-render doesn't
// reshuffle them mid-fall. Position, size, colour, delay, sway and spin per piece.
const CONFETTI_COLORS = ["#1b3f73", "#4a78b8", "#9fb8dc", "#e0a43a", "#2e9e6e", "#e56b6f", "#7c5cbf"];
const CONFETTI = Array.from({ length: 40 }, (_, i) => ({
  left: `${Math.random() * 96}%`,
  width: `${5 + (i % 3)}px`,
  height: `${8 + (i % 3) * 2}px`,
  background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  animationDelay: `${(Math.random() * 0.9).toFixed(2)}s`,
  "--sw": `${Math.round(Math.random() * 60 - 30)}px`,
  "--rot": `${180 + Math.round(Math.random() * 540)}deg`,
})) as React.CSSProperties[];

interface StockModalProps {
  stock: Stock;
  /** The whole open list. Every row is a slide, so the track is continuous and the scroll
   *  position IS the index — nothing re-centres, so paging never waits on a mount. */
  list: Stock[];
  onIndex: (i: number) => void; // page to list[i]
  onClose: () => void;
  /* Several cards are mounted at once, so anything per-ticker arrives as a resolver. */
  isTracked: (t: string) => boolean;
  onToggleTrack: (t: string) => void;
  isCovered: (t: string) => boolean; // in the TipRanks ranked set? false => live data only
  /** Signed-in user (null when signed out) — drives the "Track this stock" state. */
  user: User | null;
  /** "Track this stock" pressed. Absent => sync off, button hidden. */
  onRequestTrack?: (t: string) => void;
  /** Ticker whose request was just made — its card shows the "We're on it" sheet. */
  confirmTicker?: string | null;
  onConfirmDone?: () => void;
  markOf: (t: string) => MarkEntry | undefined;
  onMark: (t: string, v: Mark) => void;
  highlightReviews?: string[] | null; // opened from a review notification: open forecasts + glow these rows
  bare?: boolean; // only the forecasts overlay is wanted: keep the card mounted (it owns the overlay) but hidden
  openView?: TickerView | null; // a shared link's view to open over the modal (#TSM/pe)
  onViewClosed?: () => void;
  onReviewsClosed?: () => void; // the notification-opened forecasts view was closed
  onReviewsUnavailable?: () => void; // …or can't open: this ticker has no forecasts file
}

interface StockCardProps {
  stock: Stock;
  onClose: () => void;
  tracked: boolean;
  onToggleTrack: () => void;
  covered?: boolean;
  user: User | null;
  onRequestTrack?: () => void;
  confirming?: boolean;
  onConfirmDone?: () => void;
  mark?: MarkEntry;
  onMark: (v: Mark) => void;
  onPrev?: () => void;
  onNext?: () => void;
  highlightReviews?: string[] | null;
  openView?: TickerView | null;
  onViewClosed?: () => void;
  onReviewsClosed?: () => void;
  onReviewsUnavailable?: () => void;
  /** The card the user is actually looking at. The off-screen two still fetch — that is the
   *  whole point of mounting them — but they take no keyboard and open no overlay. */
  active: boolean;
}

function StockCard({ stock, onClose, tracked, onToggleTrack, covered = true, user, onRequestTrack, confirming, onConfirmDone, mark, onMark, onPrev, onNext, highlightReviews, openView, onViewClosed, onReviewsClosed, onReviewsUnavailable, active }: StockCardProps) {
  const [range, setRange] = useState<RangeId>(DEFAULT_RANGE);
  // this ticker's "Track this stock" entry: changes when CI publishes it, re-running the loads below
  const trackedRev = useTrackedRev(stock.t);
  const [seed] = useState(() => instantQuoteMetric(stock.t)); // no wait when the page holds its quote
  const [quote, setQuote] = useState<Quote | null>(seed?.quote ?? null);
  const [metric, setMetric] = useState<Metric | null>(seed?.metric ?? null);
  const [profile, setProfile] = useState<Profile | null>(seed?.profile ?? null);
  const [ext, setExt] = useState<CnbcQuote["ext"]>(seed?.ext ?? null); // pre/after-hours trade, display only
  const [live, setLive] = useState<QuoteMetric["live"]>(seed?.live ?? null);
  const [nextReport, setNextReport] = useState<Earnings | null | undefined>(undefined); // undefined: earnings.json still loading
  useEffect(() => {
    let cancelled = false;
    setNextReport(undefined);
    loadEarnings().then((idx) => {
      if (!cancelled) setNextReport(idx ? fromEntry(idx[stock.t], todayYmd()) : undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [stock.t]);
  const [qmLoading, setQmLoading] = useState(true);
  // session when the quote/ext was fetched (null: not fetched / failed): the ghost pill describes that data
  const [qmSession, setQmSession] = useState<Session | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);
  // ticker|range the current `series` (or error) belongs to: right after a tab click `series` still
  // holds the old range's bars for one render, before the fetch effect flips seriesLoading
  const [seriesKey, setSeriesKey] = useState("");
  const [seriesError, setSeriesError] = useState(false);
  const [bb, setBb] = useState<BullBear | null>(null);
  const [bbTab, setBbTab] = useState<"bull" | "bear">("bull");
  const [descOpen, setDescOpen] = useState(false);
  const [bbOpen, setBbOpen] = useState<Set<number>>(() => new Set()); // per-topic expanded indices
  const [forecasts, setForecasts] = useState<Forecast[] | null>(null);
  const [fcOpen, setFcOpen] = useState(false);
  const [cardUp, setCardUp] = useState(false); // stock card raised over its open forecasts; closing it goes back to them
  const [peOpen, setPeOpen] = useState(false);
  // CI's verdict for this ticker: a chart file, still being prepared, or no P/E history at all
  const [peState, setPeState] = useState<"ok" | "pending" | "none" | null>(null);
  useEffect(() => {
    let live = true;
    // a tracked-only ticker has no index entry yet: its chart is there iff trackedRows carried one
    Promise.all([loadPeIndex(), trackedPayload(stock.t, "pe")]).then(([idx, pe]) => {
      const e = pe === undefined ? idx[stock.t] : { ok: pe != null };
      if (live) setPeState(e?.ok ? "ok" : !e || e.err || e.wait ? "pending" : "none");
    });
    return () => {
      live = false;
    };
  }, [stock.t, trackedRev]);
  const closePe = useCallback(() => {
    setPeOpen(false);
    onViewClosed?.();
  }, [onViewClosed]);
  const [hotKeys, setHotKeys] = useState<Set<string>>(() => new Set()); // review rows to glow, from a notification
  const highlightDone = useRef<string[] | null>(null);
  const fcFromHighlight = useRef(false);
  const [liveDesc, setLiveDesc] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // paging to another ticker starts that stock at the top, not wherever the last one was scrolled
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [stock.t]);

  // chart scrubber: hover (mouse) or drag (touch) snaps to the nearest plotted point
  const [scrub, setScrub] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  // range tabs slide horizontally (too many to fit); edge fades show there's more
  const rangesRef = useRef<HTMLDivElement>(null);
  const [rangeFade, setRangeFade] = useState({ l: false, r: false });
  const updateRangeFade = useCallback(() => {
    const el = rangesRef.current;
    if (!el) return;
    setRangeFade({ l: el.scrollLeft > 2, r: el.scrollLeft < el.scrollWidth - el.clientWidth - 2 });
  }, []);
  useEffect(() => {
    updateRangeFade();
    window.addEventListener("resize", updateRangeFade);
    return () => window.removeEventListener("resize", updateRangeFade);
  }, [updateRangeFade]);

  // close on Escape. Only the active card binds, or all three would answer one keypress.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (cardUp) setCardUp(false); // card raised from the forecasts header: back to them
        else if (fcOpen) setFcOpen(false); // close the forecasts modal first
        else if (peOpen) closePe();
        else onClose();
        return;
      }
      if (fcOpen || peOpen) return; // don't page the underlying stock while an overlay is up
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      else if (e.key === "ArrowRight" && onNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onClose, fcOpen, cardUp, peOpen, closePe, onPrev, onNext]);

  // fetch quote + metric on open (per ticker, cached). Gated on `active`: the neighbours
  // render immediately from the snapshot row and only reach for the network once you land
  // on them, so a swipe is never waiting on three stocks' worth of requests.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setQmLoading(true);
    setQmSession(null);
    fetchQuoteMetric(stock.t)
      .then((r) => {
        if (cancelled) return;
        setQmSession(sessionOf(etClock()));
        setQuote(r.quote);
        setMetric(r.metric);
        setProfile(r.profile);
        setExt(r.ext);
        setLive(r.live);
      })
      .catch(() => {
        /* keep snapshot values */
      })
      .finally(() => {
        if (!cancelled) setQmLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stock.t, active]);

  // fetch Bulls Say / Bears Say snapshot + reset the panel/description on ticker change
  useEffect(() => {
    let cancelled = false;
    setBb(null);
    setBbTab("bull");
    setBbOpen(new Set());
    setDescOpen(false);
    setForecasts(null);
    setFcOpen(false);
    setCardUp(false);
    setPeOpen(false);
    setLiveDesc(null);
    if (!active) return;
    fetchBullBear(stock.t).then((r) => {
      if (!cancelled) setBb(r);
    });
    fetchForecasts(stock.t).then((r) => {
      if (cancelled) return;
      setForecasts(r);
      // opened for its reviews but there are none: hand back, so the stock card shows instead
      if (!r && highlightReviews?.length) onReviewsUnavailable?.();
    });
    // hybrid description: DB desc wins; fetch live only when it's missing
    if (!stock.desc) {
      fetchDescription(stock.t).then((d) => {
        if (!cancelled) setLiveDesc(d);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [stock.t, stock.desc, active, trackedRev]);
  // a shared `#TSM/pe` link opens the chart straight over this card. Declared AFTER the
  // reset above, which closes every overlay on a ticker change and would otherwise win.
  useEffect(() => {
    if (active && openView === "pe") setPeOpen(true);
  }, [active, openView, stock.t]);

  // opened from a review notification: once forecasts load, open the forecast view and
  // glow the new rows for 2s, then let the CSS transition fade them out. Fires once per
  // notification-open (guarded on the array reference).
  useEffect(() => {
    if (!highlightReviews?.length || !forecasts) return;
    if (highlightDone.current === highlightReviews) return;
    highlightDone.current = highlightReviews;
    setFcOpen(true);
    fcFromHighlight.current = true;
    setHotKeys(new Set(highlightReviews));
    const id = window.setTimeout(() => setHotKeys(new Set()), 2000);
    return () => window.clearTimeout(id);
  }, [highlightReviews, forecasts]);

  // closing that notification-opened forecasts view hands control back to the opener
  useEffect(() => {
    if (fcOpen || !fcFromHighlight.current) return;
    fcFromHighlight.current = false;
    onReviewsClosed?.();
  }, [fcOpen, onReviewsClosed]);

  // fetch series for the active range (default 1D on open; others on tab click)
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setSeriesLoading(true);
    setSeriesError(false);
    fetchSeries(stock.t, range)
      .then((s) => {
        if (!cancelled) setSeries(s);
      })
      .catch(() => {
        if (!cancelled) {
          setSeries(null);
          setSeriesError(true);
        }
      })
      .finally(() => {
        if (cancelled) return;
        setSeriesKey(`${stock.t}|${range}`);
        setSeriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stock.t, range, active]);

  // Once the first chart AND the quote are in, warm this stock's other ranges in the background:
  // /bars costs no quota (Twelve Data's did), and a range click then answers from cache instead of
  // a cold CNBC call (~0.3-1 s). One request at a time, so the warm-up never queues ahead of the
  // modal's own requests. Once per stock per page; a failure just leaves that range to the click.
  const settled = active && !seriesLoading && !seriesError && !qmLoading;
  const warmGenRef = useRef(0);
  // Closing the modal or paging away stops this stock's warm-up (not on a range change: that
  // effect re-runs then, and `warmed` would block a restart).
  useEffect(() => {
    if (!active) return;
    return () => {
      if (warmGenRef.current === warmGen) warmGen++;
    };
  }, [active]);
  useEffect(() => {
    if (!settled || warmed.has(stock.t)) return;
    warmed.add(stock.t);
    const rest = RANGES.filter((r) => r !== range);
    const gen = ++warmGen;
    warmGenRef.current = gen;
    void (async () => {
      for (const r of rest) {
        if (gen !== warmGen) return; // the user moved on: only the current stock is worth warming
        await fetchSeries(stock.t, r, true).catch(() => {});
      }
    })();
  }, [settled, stock.t, range]);

  // The copy flow (clipboard, burst pick, failure state) is shared with every other
  // share button in the app — see useShare. `stock.t` is the reset key, so a burst still
  // running when the user pages ‹ › to another stock is cleared rather than finishing
  // over the new ticker, which would read as "this one was copied too".
  const share = useShare(tickerTarget(stock.t), stock.t);

  // `button` only when there are forecasts to show — an empty card must not be focusable
  // or announce itself as something you can activate.
  const CardTag = (forecasts ? "button" : "div") as "button";
  // In the ranked set, CI owns this: a file (it carries SEC report dates), or "updating" while it
  // is being prepared — never a live computation in every visitor's browser. Off-universe
  // tickers have no CI file, so they still compute live from Finnhub's series.
  const peLiveOk = (metric?.epsQ.length ?? 0) >= 4 || (metric?.peQ.length ?? 0) >= 4;
  const canPe = covered ? peState === "ok" || peState === "pending" : peLiveOk;
  const PeTag = (canPe ? "button" : "div") as "button";
  const loadPeSeries = useCallback(() => fetchSeries(stock.t, "PE"), [stock.t]);

  // ---- derived display values (live extras layered over the snapshot row) ----
  const price = quote?.c ?? stock.px;
  const extShown = extNow(ext, etClock()); // only today's, and only in its own session
  const dayPct = quote?.dp ?? stock.chg;
  // Apple Stocks shows a live trailing P/E = current price / trailing EPS. Recompute
  // it that way so it tracks the shown price; fall back to Finnhub's peTTM if no EPS.
  const peFromEps =
    metric?.epsTtm != null && metric.epsTtm > 0 && price != null ? price / metric.epsTtm : null;
  // Foreign filers report EPS in their home currency per ordinary share, so price/EPS is off by
  // FX x ADR ratio (TSM ~5x, EUR/CHF filers ~15-20%). US filers sit within ~5% of Finnhub's own
  // P/E, so beyond 7% it is a currency gap and Finnhub's (listing-currency) figure wins.
  const peRaw =
    peFromEps != null && (metric?.pe == null || Math.abs(peFromEps / metric.pe - 1) <= 0.07)
      ? peFromEps
      : metric?.pe ?? null;
  // A P/E under 1 is a broken EPS feed (ENLV: EPS 154 on a $0.20 stock), not a bargain.
  const peLive = peRaw != null && peRaw >= 1 ? peRaw : null;
  // Sector averages are keyed by the app's own sector vocab, so this looks up
  // stock.sec — NOT the `sector` below, which prefers Finnhub's finhubIndustry
  // (a different taxonomy). TipRanks' "General" catch-all has no entry: renders "—".
  const secAvg = (sectorPe.sectors as Record<string, { pe: number | null; fpe: number | null }>)[stock.sec] ?? null;
  // cheaper than the sector on forward earnings reads green, pricier reads red
  const fwdPeClass =
    metric?.fwdPe == null || metric.fwdPe <= 0 || secAvg?.fpe == null
      ? ""
      : metric.fwdPe < secAvg.fpe
        ? "up"
        : "dn";
  // prefer live profile (Finnhub) over the scraped DB row for these fields
  const name = profile?.name ?? stock.n;
  const sector = profile?.sector ?? stock.sec;
  const earnings = nextReport ? earningsParts(nextReport, todayYmd()) : null;
  const mktCap = profile?.mktCap ?? stock.mc;
  const desc = stock.desc || liveDesc; // scraped DB desc wins; live FMP fallback
  // the % beside the price tracks the selected chart range: 1D uses the true
  // day move (vs prev close); other ranges use the series' first→last change
  // CNBC's daily/weekly/monthly bars stop at yesterday: today's live price joins the series here.
  const view = useMemo(() => (series ? withLive(series, live, RANGE_CFG[range].kind) : null), [series, live, range]);
  const pctLoading =
    range === "1D" ? qmLoading && quote == null : seriesLoading || seriesKey !== `${stock.t}|${range}`;
  // While a new range loads, `series` still holds the previous range's bars, so its first→last
  // change is neither the old figure nor the new one. Keep showing the last settled figure.
  const lastPctRef = useRef<{ t: string; v: number | null } | null>(null);
  const settledPct =
    range === "1D"
      ? dayPct
      : view && view.closes.length > 1 && view.closes[0]
        ? ((view.closes[view.closes.length - 1] - view.closes[0]) / view.closes[0]) * 100
        : null;
  const held = pctLoading && lastPctRef.current?.t === stock.t ? lastPctRef.current : null;
  const rangePct = held ? held.v : settledPct;
  if (!pctLoading) lastPctRef.current = { t: stock.t, v: settledPct };
  const dir = rangePct == null ? "flat" : rangePct > 0 ? "up" : rangePct < 0 ? "dn" : "flat";
  const arrow = rangePct == null ? "" : rangePct > 0 ? "▴" : rangePct < 0 ? "▾" : "•";

  const upside =
    stock.up != null ? stock.up : price != null && stock.pt != null && price > 0
      ? ((stock.pt - price) / price) * 100
      : null;

  const totalAnalysts = stock.b + stock.h + stock.s;
  const rowPct = (v: number) => (totalAnalysts > 0 ? (v / totalAnalysts) * 100 : 0);

  // ---- analyst forecast helpers ----
  const fcUsd = (v: number): string =>
    "$" + (v >= 100 ? Math.round(v).toLocaleString() : pxDp(v));
  const posClass = (r: string | null): string =>
    r === "Buy" ? "buy" : r === "Sell" ? "sell" : "hold";
  const fmtFcDate = (d: string): string => {
    const [y, m, dd] = d.split("-").map(Number);
    return new Date(y, m - 1, dd).toLocaleDateString(DATE_LOCALE, { day: "2-digit", month: "2-digit", year: "2-digit" });
  };
  // Potential is against the LIVE price: until it arrives show a placeholder, not a snapshot
  // figure that visibly rewrites itself half a second later.
  const livePending = qmLoading && quote == null;
  const fcUpside = (pt: number): number | null =>
    price != null && price > 0 ? ((pt - price) / price) * 100 : null;
  const starRow = (v: number | null) => {
    const n = Math.round(v ?? 0);
    return (
      <span className="mkm-stars" title={v != null ? `${v.toFixed(1)}★` : undefined}>
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className={i < n ? "on" : ""}>★</span>
        ))}
      </span>
    );
  };

  const chart = useMemo(
    () =>
      view && view.closes.length
        ? buildChart(view.closes, view.stamps, RANGE_CFG[range].kind === "intraday", {
            is1D: range === "1D",
            quote: quote ? { day: live?.day ?? null, px: quote.c, pc: quote.pc } : null,
            now: easternNow(),
          })
        : null,
    [view, range, quote, live],
  );

  const chartAvailable = !seriesLoading && !seriesError && chart != null;
  // The session's total from the CNBC quote — never a bar's volume (5-minute bars don't sum to
  // the day, and the 16:00 closing-auction bar alone can be 3x it).
  const todayVol = quote?.v ?? null;

  // pointer x -> nearest plotted point. The SVG is a fixed 600-wide viewBox scaled to the
  // box width, so convert the client x into viewBox units before matching.
  const onScrub = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const box = plotRef.current;
      if (!box || !chart || chart.pts.length < 2) return;
      // a mouse hover scrubs; a finger must actually be down (so a tap doesn't stick)
      if (e.pointerType !== "mouse" && e.buttons === 0 && e.type === "pointermove") return;
      const r = box.getBoundingClientRect();
      const svg = box.querySelector("svg");
      const inset = svg ? svg.getBoundingClientRect() : r;
      const vbX = ((e.clientX - inset.left) / (inset.width || 1)) * CW;
      const i = nearestIndex(chart.pts.map((p) => p.x), vbX);
      if (i >= 0) setScrub(i);
    },
    [chart],
  );
  const clearScrub = useCallback(() => setScrub(null), []);
  useEffect(() => setScrub(null), [range, stock.t]); // a new range/ticker clears the readout
  const scrubPt = scrub != null && chart && scrub < chart.pts.length ? chart.pts[scrub] : null;

  // off-universe tickers have no scraped DB row, so while their live data is in
  // flight show a spinner (not the empty template); once settled, either the
  // full modal or, if nothing came back, a clear "not found" state.
  const loadingUncovered = !covered && (qmLoading || seriesLoading);
  const noData =
    !covered && !qmLoading && !seriesLoading && (price == null || price === 0) && !chartAvailable;
  const chromeOff = noData || loadingUncovered; // hide star/LIVE until we know
  // covered cards pass no user, so they attach no RTDB listener
  const trackReq = useTrackRequest(stock.t, covered ? null : user);

  return (
    <>
      <div
        className={`mkm-modal${cardUp ? " mkm-card-up" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mkm-sym"
        ref={dialogRef}
        data-burst={share.burst ?? undefined}
      >
        {/* title bar — one aligned row: ticker · star · thumbs · LIVE · close */}
        <div className="mkm-titlebar">
          <div className="mkm-tbtk" id="mkm-sym">{stock.t}</div>
          {!chromeOff && (
            <button
              type="button"
              className={`mkm-star ${tracked ? "on" : ""}`}
              title={tracked ? "Untrack" : "Track this stock"}
              aria-label={tracked ? "Untrack" : "Track this stock"}
              aria-pressed={tracked}
              onClick={onToggleTrack}
            >
              {tracked ? "★" : "☆"}
            </button>
          )}
          {!chromeOff && <ThumbMark mark={mark} onMark={onMark} both />}
          {!chromeOff && marketOpen() && <div className="mkm-live">LIVE</div>}
          {!chromeOff && <ShareButton what={stock.t} onShare={share.onShare} compact />}
        </div>

        {/* only the card in view: the neighbours' × sits outside their edge and peeked into view */}
        {active && <CloseButton what={stock.t} onClose={cardUp ? () => setCardUp(false) : onClose} />}

        {share.copyFailed && <ShareFail url={share.url} />}

        <div className="mkm-scroll" ref={scrollRef}>
          {loadingUncovered ? (
            <div className="mkm-loading" role="status" aria-label="Loading">
              <span className="mkm-spinner" />
            </div>
          ) : noData ? (
            <div className="mkm-empty">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.6-3.6" />
                <path d="M8.5 11h5" />
              </svg>
              <div className="mkm-empty-t">No data for “{stock.t}”</div>
              <div className="mkm-empty-s">We couldn’t find market data for this symbol.</div>
            </div>
          ) : (
          <>
          {!covered && (
            <div className="mkm-lim" role="status">
              {trackReq === "none" ? (
                <svg className="mkm-lim-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
                </svg>
              ) : trackReq === "pending" ? (
                <span className="mkm-lim-spin" aria-hidden="true" />
              ) : (
                <svg className="mkm-lim-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12l5 5L19 7" />
                </svg>
              )}
              <div className="mkm-lim-txt">
                <div className="mkm-lim-t">
                  {trackReq === "none" ? "Live price only" : trackReq === "pending" ? `Tracking ${stock.t}` : `${stock.t} is tracked`}
                </div>
                <div className="mkm-lim-s">
                  {trackReq === "none" ? "Analyst data isn’t tracked yet" : trackReq === "pending" ? "Full analyst data in a few minutes" : "Refresh to see the full data"}
                </div>
              </div>
              {onRequestTrack && trackReq === "none" && (
                <button type="button" className="mkm-trackreq" onClick={onRequestTrack}>
                  Track this stock
                </button>
              )}
            </div>
          )}
          {/* head line — ticker now lives in the title bar; company + price here */}
          <div className="mkm-head">
            <div className="mkm-cocol">
              <div className="mkm-co">
                {name}
                {sector ? " · " + consLabel(sector) : ""}
              </div>
              {earnings && (
                <div className="mkm-earn" title={`Next earnings report: ${nextReport?.date}`}>
                  <span className="mkm-earn-cal" aria-hidden="true">
                    <span>{earnings.mon}</span>
                    {earnings.day}
                  </span>
                  <b>Earnings</b> {earnings.text}
                </div>
              )}
              {/* no date: a dashed placeholder keeps row 2 balanced against the session pill */}
              {nextReport === null && (
                <div className="mkm-earn mkm-ghost">
                  <span className="mkm-earn-cal" aria-hidden="true">
                    <span>—</span>?
                  </span>
                  Earnings date not announced
                </div>
              )}
            </div>
            {/* price + % move as one unit: never split; on a phone a long company name wraps instead */}
            <div className="mkm-pxgrp">
            <div className="mkm-px">{usd(price)}</div>
            {/* While a range loads, the previous figure stays (dimmed) rather than "…": the two
                widths differ, and on a phone the % wraps under the price — swapping them made
                the whole card shrink and grow back on every range click. */}
            <div className={`mkm-chg ${dir}${pctLoading ? " skel" : ""}`}>
              {pctLoading && rangePct == null ? "…" : rangePct == null ? "—" : `${arrow}${pct(rangePct).replace(/^[+-]/, "")}`}
            </div>
            </div>
            {extShown && (
              <div className="mkm-ext">
                <span className="mkm-pill" title="Extended-hours trade (CNBC). Thin volume; rounded to cents.">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {extShown.type === "pre" ? (
                    <>
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                    </>
                  ) : (
                    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                  )}
                </svg>
                <span className="mkm-ext-k">{extShown.type === "pre" ? "PRE-MARKET" : "AFTER HOURS"}</span>
                <b>{usd(extShown.px)}</b>
                {extShown.pct != null && (
                  <span className={extShown.pct > 0 ? "up" : extShown.pct < 0 ? "dn" : "flat"}>{pct(extShown.pct)}</span>
                )}
                </span>
              </div>
            )}
            {/* no extended-hours trade: the session in a dashed placeholder, once the quote landed and only
                while the live session still matches the fetched one, so it never misdescribes old data */}
            {!extShown && qmSession && sessionOf(etClock()) === qmSession && (
              // mkm-ext-open: hidden on phones, where the top bar's LIVE says it (unless LIVE is hidden too)
              <div className={`mkm-ext${qmSession === "regular" && !chromeOff ? " mkm-ext-open" : ""}`}>
                <span className="mkm-pill mkm-ghost">
                  {qmSession === "regular" && <i className="mkm-dot" aria-hidden="true" />}
                  <span className="mkm-ext-k">{GHOST_LABEL[qmSession]}</span>
                </span>
              </div>
            )}
          </div>

          {/* CHART pane */}
          <div className="mkm-chartpane">
            <div className="mkm-cmdline">
              <div className={`mkm-rangewrap${rangeFade.l ? " fl" : ""}${rangeFade.r ? " fr" : ""}`}>
                <div className="mkm-ranges" ref={rangesRef} onScroll={updateRangeFade}>
                  {RANGES.map((r) => (
                    <button
                      key={r}
                      className={r === range ? "on" : ""}
                      onClick={() => setRange(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              {range === "1D" && chart?.nowLabel && (
                <span className={`mkm-sess ${chart.live ? "live" : "closed"}`}>
                  {chart.live ? (
                    <>
                      <i />
                      LIVE · {chart.nowLabel}
                    </>
                  ) : (
                    "CLOSED"
                  )}
                </span>
              )}
            </div>

            {/* scrub readout — height always reserved so the chart never jumps */}
            <div className={`mkm-scrub${scrubPt ? " on" : ""}`} aria-live="off">
              <span className="mkm-scrub-t">{scrubPt ? scrubPt.s : " "}</span>
              <span className="mkm-scrub-p">{scrubPt ? usd(scrubPt.v) : " "}</span>
            </div>

            <div
              /* The box claims horizontal drags so they scrub the chart instead of paging the
                 track — but only once there is a chart. While it is loading or absent, the
                 gesture belongs to the swipe. */
              className={`mkm-plotbox${chartAvailable ? "" : " idle"}`}
              ref={plotRef}
              onPointerDown={onScrub}
              onPointerMove={onScrub}
              onPointerUp={clearScrub}
              onPointerCancel={clearScrub}
              onPointerLeave={clearScrub}
            >
              {seriesLoading ? (
                <div className="mkm-plot-msg mkm-skel">loading…</div>
              ) : !chartAvailable ? (
                <div className="mkm-plot-msg">chart unavailable</div>
              ) : (
                <svg
                  viewBox="0 0 600 140"
                  preserveAspectRatio="none"
                  aria-label={`${stock.t} ${range} price chart`}
                >
                  <defs>
                    <linearGradient id="mkm-fill-up" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="rgba(50,215,75,.22)" />
                      <stop offset="1" stopColor="rgba(50,215,75,0)" />
                    </linearGradient>
                    <linearGradient id="mkm-fill-dn" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="rgba(255,69,58,.22)" />
                      <stop offset="1" stopColor="rgba(255,69,58,0)" />
                    </linearGradient>
                  </defs>
                  {/* gridlines: horizontal at price ticks, vertical at date ticks */}
                  {chart!.priceTicks.map((t, i) => (
                    <line key={`h${i}`} className="mkm-gridln" x1="0" y1={t.y} x2={CW - C_R} y2={t.y} />
                  ))}
                  {chart!.dateTicks.map((t, i) => (
                    <line key={`v${i}`} className="mkm-gridln" x1={t.x} y1={C_PAD} x2={t.x} y2={CH - C_B} />
                  ))}
                  {/* 1D live: shade the part of the session not yet traded */}
                  {chart!.remaining && (
                    <rect
                      className="mkm-remaining"
                      x={chart!.remaining.x}
                      y={C_PAD}
                      width={chart!.remaining.w}
                      height={CH - C_B - C_PAD}
                    />
                  )}
                  {/* dashed reference line — 1D: prev close; other ranges: opening price */}
                  <line className="mkm-baseln" x1="0" y1={chart!.baseY} x2={CW - C_R} y2={chart!.baseY} />
                  {range === "1D" && chart!.nowLabel && (
                    <text className="mkm-basetag" x="2" y={chart!.baseY - 3}>
                      prev close
                    </text>
                  )}
                  <path fill={chart!.up ? "url(#mkm-fill-up)" : "url(#mkm-fill-dn)"} d={chart!.area} />
                  <path className={`mkm-chartline ${chart!.up ? "up" : "dn"}`} d={chart!.line} />
                  {chart!.live && (
                    <circle
                      className="mkm-livering"
                      cx={chart!.lastX}
                      cy={chart!.lastY}
                      r="4"
                      fill="none"
                      stroke={chart!.up ? "#32d74b" : "#ff453a"}
                    />
                  )}
                  <circle
                    cx={chart!.lastX}
                    cy={chart!.lastY}
                    r={chart!.live ? 3.4 : 3}
                    fill={chart!.up ? "#32d74b" : "#ff453a"}
                  />
                  {/* scrubber crosshair — vertical line + dot snapped to the nearest point */}
                  {scrubPt && (
                    <g pointerEvents="none">
                      <line className="mkm-scrubln" x1={scrubPt.x} y1={C_PAD} x2={scrubPt.x} y2={CH - C_B} />
                      <circle className="mkm-scrubdot" cx={scrubPt.x} cy={scrubPt.y} r="4" />
                    </g>
                  )}
                  {/* price labels (right gutter) */}
                  {chart!.priceTicks.map((t, i) => (
                    <text key={`pt${i}`} className="mkm-axtx" x={CW - 3} y={t.y + 3} textAnchor="end">
                      {t.label}
                    </text>
                  ))}
                  {/* date labels (bottom strip) */}
                  {chart!.dateTicks.map((t, i) => (
                    <text
                      key={`dt${i}`}
                      className={`mkm-axtx ${t.future ? "future" : ""}`}
                      x={t.x}
                      y={CH - 4}
                      textAnchor={i === 0 ? "start" : i === chart!.dateTicks.length - 1 ? "end" : "middle"}
                    >
                      {t.label}
                    </text>
                  ))}
                </svg>
              )}
            </div>
          </div>

          {/* metric matrix */}
          <div className={`mkm-matrix ${covered ? "" : "uncovered"}`}>
            <div className="mkm-cell">
              <div className="k">Prc Target</div>
              <div className="v gold">{usd(stock.pt)}</div>
            </div>
            <div className="mkm-cell">
              <div className="k">Upside</div>
              <div className="v gold">{upside == null ? "—" : pct(upside)}</div>
            </div>
            <div className="mkm-cell">
              <div className="k">Smart Score</div>
              <div className="v green">
                {stock.ss == null ? "—" : stock.ss}
                {stock.ss != null && <small>/10</small>}
              </div>
            </div>
            <div className="mkm-cell">
              <div className="k">AI Score</div>
              <div className="v green">
                {stock.ai == null ? "—" : stock.ai}
                {stock.ai != null && <small>/100</small>}
              </div>
            </div>
            <div className="mkm-cell">
              <div className="k">Consensus</div>
              <div className={`v ${consClass(stock.con)}`} style={{ fontSize: 14 }}>
                {consLabel(stock.con).toUpperCase()}
              </div>
            </div>
            <div className="mkm-cell">
              <div className="k">AI Rating</div>
              <div className="v" style={{ fontSize: 14, color: "var(--t-teal)" }}>
                {(stock.air || "—").toUpperCase()}
              </div>
            </div>
            <div className="mkm-cell">
              <div className="k">AI Target</div>
              <div className="v">{usd(stock.aipt)}</div>
            </div>
            <div className="mkm-cell mkm-cell-live">
              <div className="k">Mkt Cap</div>
              <div className="v">{fmtMc(mktCap)}</div>
            </div>
          </div>

          {/* readout */}
          <div className="mkm-readout">
            <div className="mkm-rp">
              <div className="mkm-rphdr">Analyst Distribution · n={totalAnalysts}</div>
              <div className="mkm-bhs">
                <span className="b" style={{ flex: Math.max(stock.b, 0.001) }}>
                  {stock.b || ""}
                </span>
                <span className="h" style={{ flex: Math.max(stock.h, 0.001) }}>
                  {stock.h || ""}
                </span>
                <span className="s" style={{ flex: Math.max(stock.s, 0.001) }}>
                  {stock.s || ""}
                </span>
              </div>
              <div className="mkm-dchips">
                <span className="mkm-dchip b">Buy <b>{stock.b}</b> · {Math.round(rowPct(stock.b))}%</span>
                <span className="mkm-dchip h">Hold <b>{stock.h}</b> · {Math.round(rowPct(stock.h))}%</span>
                <span className="mkm-dchip s">Sell <b>{stock.s}</b> · {Math.round(rowPct(stock.s))}%</span>
              </div>
            </div>
            {/* The whole card is the control, not just the pill — a real <button> rather
                than a clickable div, so focus and Enter/Space come from the platform. The
                pill is a <span> inside it: a button within a button is invalid. */}
            <CardTag
              className={`mkm-rp${forecasts ? " mkm-rp-open" : ""}`}
              {...(forecasts
                ? {
                    type: "button" as const,
                    "aria-haspopup": "dialog" as const,
                    "aria-label": `See all ${forecasts.length} analyst forecasts`,
                    onClick: () => setFcOpen(true),
                  }
                : {})}
            >
              <div className="mkm-fchdr">
                <span className="mkm-rphdr" style={{ marginBottom: 0 }}>Analyst Forecasts</span>
                {forecasts && <span className="mkm-fcpill">See all {forecasts.length} →</span>}
              </div>
              {forecasts ? (
                <div className="mkm-fclist">
                  {forecasts.slice(0, 3).map((f, i) => {
                    const up = fcUpside(f.pt);
                    return (
                      <div className="mkm-fcrow" key={i}>
                        <span className={`mkm-fcpos ${posClass(f.r)}`}>{(f.r || "—").toUpperCase()}</span>
                        <span className="mkm-fctgt">
                          {f.opt != null ? (
                            <>{fcUsd(f.opt)}<span className="arw">→</span>{fcUsd(f.pt)}</>
                          ) : (
                            fcUsd(f.pt)
                          )}
                        </span>
                        <span className={`mkm-fcup ${livePending ? "skel" : up != null && up < 0 ? "dn" : ""}`}>
                          {livePending ? "—" : up == null ? "" : pct(up)}
                        </span>
                        <span className="mkm-fcdate">{fmtFcDate(f.d)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mkm-bbna">No analyst forecasts for this stock.</div>
              )}
            </CardTag>
          </div>

          {/* stats block */}
          <div className="mkm-statblock">
            <div className="mkm-rphdr">Session &amp; Fundamentals</div>
            <div className="mkm-kv">
              <div className="row">
                <div className="k">Open</div>
                <div className={`v ${qmLoading && quote?.o == null ? "skel" : ""}`}>{usd(quote?.o)}</div>
              </div>
              <div className="row">
                <div className="k">High</div>
                <div className={`v up ${qmLoading && quote?.h == null ? "skel" : ""}`}>{usd(quote?.h)}</div>
              </div>
              <div className="row">
                <div className="k">Low</div>
                <div className={`v dn ${qmLoading && quote?.l == null ? "skel" : ""}`}>{usd(quote?.l)}</div>
              </div>
              <div className="row">
                <div className="k">Prev Close</div>
                <div className={`v ${qmLoading && !quote ? "skel" : ""}`}>{usd(quote?.pc)}</div>
              </div>
              <div className="row">
                <div className="k">Volume</div>
                <div className={`v ${qmLoading && !quote ? "skel" : ""}`}>{fmtVol(todayVol)}</div>
              </div>
              {/* row 1 ends on Avg Vol 3M so it sits beside Volume, the number it's read against */}
              <div className="row">
                <div className="k">Avg Vol 3M</div>
                <div className={`v ${qmLoading && metric?.avgVol3M == null ? "skel" : ""}`}>
                  {fmtVol(metric?.avgVol3M != null ? metric.avgVol3M * 1e6 : null)}
                </div>
              </div>
              {/* row 2: range, risk, then the three valuation cells. Skeletons are per field: a
                  seeded CNBC quote fills most at once; a gap waits for Finnhub, not "—" first. */}
              <div className="row">
                <div className="k">52W High</div>
                <div className={`v ${qmLoading && metric?.hi52 == null ? "skel" : ""}`}>{usd(metric?.hi52)}</div>
              </div>
              <div className="row">
                <div className="k">52W Low</div>
                <div className={`v ${qmLoading && metric?.lo52 == null ? "skel" : ""}`}>{usd(metric?.lo52)}</div>
              </div>
              <div className="row">
                <div className="k">Beta</div>
                <div className={`v ${qmLoading && metric?.beta == null ? "skel" : ""}`}>
                  {metric?.beta == null ? "—" : metric.beta.toFixed(2)}
                </div>
              </div>
              {/* the three valuation cells are ONE button into the 5Y P/E history — a raised
                  card with a chevron, so it reads as something to press. Plain cells when there
                  are fewer than 4 quarters of EPS to build a history from. */}
              <PeTag
                className={`mkm-pe-open${canPe ? " on" : ""}`}
                {...(canPe ? { type: "button", onClick: () => setPeOpen(true), "aria-haspopup": "dialog", "aria-label": `P/E ${peLive == null || peLive <= 0 ? "not available" : peLive.toFixed(2)}. Open ${stock.t} 5-year P/E history` } : {})}
              >
                <div className="row">
                  <div className="k">P/E</div>
                  <div className={`v ${qmLoading && peLive == null ? "skel" : ""}`}>
                    {peLive == null || peLive <= 0 ? "—" : peLive.toFixed(2)}
                  </div>
                </div>
                <div className="row">
                  <div className="k">Fwd P/E</div>
                  {/* green/red vs the sector's FORWARD average — comparing it to the
                      trailing half would flatter every stock */}
                  <div
                    className={`v ${fwdPeClass} ${qmLoading && metric?.fwdPe == null ? "skel" : ""}`}
                  >
                    {metric?.fwdPe == null || metric.fwdPe <= 0 ? "—" : metric.fwdPe.toFixed(2)}
                  </div>
                </div>
                <div className="row">
                  <div className="k">Sector Avg P/E</div>
                  <div className="split">
                    <div>
                      <div className="n">{secAvg?.pe == null ? "—" : secAvg.pe.toFixed(2)}</div>
                      <div className="l">Today</div>
                    </div>
                    <div>
                      <div className="n">{secAvg?.fpe == null ? "—" : secAvg.fpe.toFixed(2)}</div>
                      <div className="l">Fwd</div>
                    </div>
                  </div>
                </div>
                {canPe && <span className="mkm-pe-chev" aria-hidden="true">›</span>}
              </PeTag>
            </div>
          </div>

          {/* company description — first line shown, rest collapsed */}
          {desc && (
            <div className="mkm-about">
              <div className="mkm-abouthdr">About {name}</div>
              <p
                className={`mkm-desc ${descOpen ? "" : "mkm-clamp2"}`}
                title={descOpen ? "Collapse" : "Expand"}
                onClick={() => setDescOpen((v) => !v)}
              >
                {desc}
              </p>
              <button
                type="button"
                className="mkm-more"
                aria-expanded={descOpen}
                onClick={() => setDescOpen((v) => !v)}
              >
                {descOpen ? "Show less" : "Show more"}
              </button>
            </div>
          )}

          {/* Bulls Say / Bears Say */}
          <div className="mkm-bb">
            <div className="mkm-bbhdr">
              Bulls Say, Bears Say
              {bb?.asOf && (
                <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, opacity: 0.7, marginLeft: 8 }}>
                  · updated {bb.asOf}
                </span>
              )}
            </div>
            {bb ? (
              <>
                <div className="mkm-bbtabs">
                  <button
                    type="button"
                    className={bbTab === "bull" ? "on bull" : ""}
                    onClick={() => { setBbTab("bull"); setBbOpen(new Set()); }}
                  >
                    ▲ Bulls Say
                  </button>
                  <button
                    type="button"
                    className={bbTab === "bear" ? "on bear" : ""}
                    onClick={() => { setBbTab("bear"); setBbOpen(new Set()); }}
                  >
                    ▼ Bears Say
                  </button>
                </div>
                <div className="mkm-bblist">
                  {(bbTab === "bull" ? bb.bull : bb.bear).map((p, i) => {
                    const open = bbOpen.has(i);
                    return (
                      <button
                        type="button"
                        className={`mkm-bbpt ${open ? "open" : ""}`}
                        key={i}
                        aria-expanded={open}
                        onClick={() =>
                          setBbOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          })
                        }
                      >
                        <span className={`t ${bbTab}`}>{p.t}</span>
                        <span className={`b ${open ? "" : "mkm-clamp2"}`}>{p.b}</span>
                        <span className="mkm-bbtog">{open ? "Show less" : "Show more"}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="mkm-bbna">Bull / bear analysis not available for this stock.</div>
            )}
          </div>

          {/* footer */}
          <div className="mkm-foot">
            <a
              className="mkm-yh"
              href={stocksUrl(stock.t)}
              target="_blank"
              rel="noopener noreferrer"
            >
              STOCKS ↗
            </a>
          </div>
          </>
          )}
        </div>

        {share.burst && <ShareBurst id={share.burst} onDone={share.onBurstDone} />}

        {confirming && (
          <div className="mkm-sheet-bg" onClick={onConfirmDone}>
            <div className="mkm-confetti" aria-hidden="true">
              {CONFETTI.map((c, i) => <span key={i} style={c} />)}
            </div>
            <div
              className="mkm-sheet"
              role="alertdialog"
              aria-labelledby="mkm-sheet-t"
              aria-describedby="mkm-sheet-s"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="mkm-sheet-ok" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </span>
              <div className="mkm-sheet-t" id="mkm-sheet-t">We’re on it</div>
              <div className="mkm-sheet-s" id="mkm-sheet-s">
                Full analyst data for {stock.t} usually arrives in 3–5 minutes. It’s on your watchlist, and we’ll notify you.
              </div>
              <button type="button" className="mkm-sheet-btn" autoFocus onClick={onConfirmDone}>
                Got it
              </button>
            </div>
          </div>
        )}
      </div>

    {/* Full analyst forecast list. Portalled to the body because the card now lives inside
        the snap track, and an overlay rendered in there would be clipped by it. */}
    {active && peOpen && (
      <PeHistory
        ticker={stock.t}
        eps={metric?.epsQ ?? NO_EPS}
        nowPe={peLive}
        peq={metric?.peQ ?? NO_EPS}
        sectorPe={secAvg?.pe ?? null}
        pending={covered && peState === "pending"}
        loadSeries={loadPeSeries}
        onClose={closePe}
      />
    )}
    {active && fcOpen && forecasts && createPortal(
      <div
        className={`mkm-scrim mkm-scrim-top${cardUp ? " mkm-under" : ""}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setFcOpen(false);
        }}
      >
        <div
          className="mkm-modal mkm-modal-fc"
          role="dialog"
          aria-modal="true"
          aria-label={`${stock.t} analyst forecasts`}
        >
          <div className="mkm-titlebar">
            {/* opened from a notification there is no stock card under the list (bare), so the
                header raises it; opened from the card itself it is plain text */}
            <button
              type="button"
              className="mkm-fctitle"
              disabled={!fcFromHighlight.current}
              onClick={() => setCardUp(true)}
              aria-label={fcFromHighlight.current ? `Open ${stock.t} stock details` : undefined}
            >
              <div className="mkm-path"><b>{stock.t}</b> · Analyst Forecasts</div>
              {(stock.n || name) && (
                <div className="mkm-fcsub">
                  {stock.n || name}
                  {(stock.sec || sector) ? " · " + consLabel(stock.sec || sector) : ""}
                </div>
              )}
              {fcFromHighlight.current && <span className="mkm-fcgo" aria-hidden="true">›</span>}
            </button>
          </div>
          <CloseButton what={`${stock.t} analyst forecasts`} onClose={() => setFcOpen(false)} />
          <div className="mkm-scroll">
            <div className="mkm-fcfull mkm-fcfull-modal">
              <div className="mkm-fctable">
                <div className="mkm-fchead">
                  <span title="TipRanks analyst star rating">Analyst Rank</span>
                  <span>Analyst · Firm</span>
                  <span className="ar">Recommendation</span>
                  <span className="ar">12-mo Target</span>
                  <span className="ar">Potential</span>
                  <span className="ar">Rating Date</span>
                </div>
                {forecasts.map((f, i) => {
                  const up = fcUpside(f.pt);
                  const hot = hotKeys.has(reviewKey(f));
                  return (
                    <div className={`mkm-fcfrow${hot ? " mkm-fchot" : ""}`} key={i}>
                      {starRow(f.st)}
                      <span className="mkm-fcan">
                        <b>{f.n || "—"}</b>
                        <small>{f.f || ""}</small>
                      </span>
                      <span className={`mkm-fcpos ${posClass(f.r)}`}>{(f.r || "—").toUpperCase()}</span>
                      <span className="mkm-fctgt">
                        {f.opt != null ? (
                          <>{fcUsd(f.opt)}<span className="arw">→</span>{fcUsd(f.pt)}</>
                        ) : (
                          fcUsd(f.pt)
                        )}
                      </span>
                      <span className={`mkm-fcup ${livePending ? "skel" : up != null && up < 0 ? "dn" : ""}`}>
                        {livePending ? "—" : up == null ? "" : pct(up)}
                      </span>
                      <span className="mkm-fcdate">{fmtFcDate(f.d)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>,
      document.body,
    )}
    </>
  );
}

/* The shell: scrim, the ‹ › buttons, and the scroll-snap track.

   The track holds one slide per stock in the open list, so scrolling never runs out of
   runway and the scroll offset alone says which stock you are on — there is no window to
   shift and no re-centring, which is what used to make you wait a beat between swipes.
   Only the slides within one of the live one render a card; the rest are empty boxes of the
   same width, so a hard fling flies past blanks and fills in the moment it slows down.

   Everything a card shows except the chart and the live quote is already bundled, so a
   neighbour costs a render and no network. The fetch happens when you land (see `active`
   in StockCard) and is cancelled when you leave. */
const MOUNT_RADIUS = 1;

/* First-open coachmark. Sign-in is optional in this app and a first-time visitor usually has
   no uid, so "once" can only mean once per browser — localStorage is the only store that
   reaches the people this hint is for. A blocked or cleared store reads as "already seen":
   showing the hint twice is a nuisance, nagging someone every visit is worse. */
const COACH_KEY = "mp-swipe-coach";
const COACH_MS = 2200; // keep in step with the mkm-coach-life keyframes
function coachSeen(): boolean {
  try {
    return localStorage.getItem(COACH_KEY) === "1";
  } catch {
    return true; // private window / blocked storage — stay quiet rather than ask every time
  }
}

/* The scrim takes no pointer events, so the gesture it is teaching works straight through it —
   you can follow the instruction without dismissing it first, and doing so dismisses it.

   A mouse cannot drag a scroll container, so "swipe" is a lie on a desktop with no trackpad.
   `pointer: coarse` is the closest the platform gets to "the primary pointer is a finger";
   everywhere else the hint names the controls that definitely work instead. */
function SwipeCoach({ onDismiss }: { onDismiss: () => void }) {
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const label = touch ? "Swipe for the next stock" : "Use the arrows for the next stock";
  return (
    <div className="mkm-coach" role="note" aria-label={label}>
      <div className="mkm-coach-in">
        {touch ? (
          <span className="mkm-coach-puck" />
        ) : (
          <span className="mkm-coach-keys" aria-hidden="true"><b>‹</b><b>›</b></span>
        )}
        <small>{touch ? "SWIPE FOR THE NEXT STOCK" : "ARROWS FOR THE NEXT STOCK"}</small>
        <button type="button" onClick={onDismiss}>Got it</button>
      </div>
    </div>
  );
}

export default function StockModal({
  stock, list, onIndex, onClose, isTracked, onToggleTrack, isCovered, user, onRequestTrack, confirmTicker, onConfirmDone, markOf, onMark, highlightReviews,
  openView, onViewClosed, onReviewsClosed, onReviewsUnavailable, bare,
}: StockModalProps) {
  const swipeRef = useRef<HTMLDivElement>(null);
  const idx = Math.max(0, list.findIndex((s) => s.t === stock.t));
  const idxRef = useRef(idx);
  idxRef.current = idx;

  // Place the track on the open stock once. After that the scroll belongs to the user.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const el = swipeRef.current;
    if (!el || placed.current) return;
    el.scrollLeft = idx * el.clientWidth;
    placed.current = true;
  }, [idx]);

  // Crossing a slide boundary is the page — no settle timer, so a continuous flick keeps up.
  const onSwipeScroll = useCallback(() => {
    const el = swipeRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / (el.clientWidth || 1));
    if (i !== idxRef.current && i >= 0 && i < list.length) onIndex(i);
  }, [list.length, onIndex]);

  /* The ‹ › buttons and the arrow keys scroll the same track a finger does, so every route
     between stocks animates identically. */
  const slideTo = useCallback((i: number) => {
    const el = swipeRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: i * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  }, []);
  const goPrev = idx > 0 ? () => slideTo(idx - 1) : undefined;
  const goNext = idx < list.length - 1 ? () => slideTo(idx + 1) : undefined;

  // lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Show the swipe hint on the very first modal ever opened, and only when there is somewhere
  // to swipe to. Performing the swipe counts as learning it, so a page dismisses it too.
  const [coach, setCoach] = useState(() => list.length > 1 && !coachSeen());
  const dismissCoach = useCallback(() => {
    setCoach(false);
    try {
      localStorage.setItem(COACH_KEY, "1");
    } catch {
      /* nothing to persist to; the hint simply returns next visit */
    }
  }, []);
  const openedOn = useRef(stock.t);
  useEffect(() => {
    if (stock.t !== openedOn.current) dismissCoach();
  }, [stock.t, dismissCoach]);

  // It bows out on its own after 1.5s, and any touch anywhere takes it away early. The tap
  // listener is capture-phase and passive: it dismisses without consuming the event, so the
  // press still lands on whatever was underneath — the hint never costs you a tap.
  useEffect(() => {
    if (!coach) return;
    const timer = window.setTimeout(dismissCoach, COACH_MS);
    const tap = () => dismissCoach();
    window.addEventListener("pointerdown", tap, { capture: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", tap, { capture: true });
    };
  }, [coach, dismissCoach]);

  const onBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div className={`mkm-scrim${bare ? " mkm-bare" : ""}`} onMouseDown={onBackdrop}>
      <div className="mkm-stage">
        {goPrev && (
          <button type="button" className="mkm-nav prev" aria-label="Previous stock" onClick={goPrev}>
            ‹
          </button>
        )}
        <div className="mkm-swipe" ref={swipeRef} onScroll={onSwipeScroll}>
          {list.map((s, i) => (
            <div className="mkm-slide" key={s.t}>
              {Math.abs(i - idx) <= MOUNT_RADIUS && (
                <StockCard
                  stock={s}
                  active={i === idx}
                  onClose={onClose}
                  tracked={isTracked(s.t)}
                  onToggleTrack={() => onToggleTrack(s.t)}
                  covered={isCovered(s.t)}
                  user={user}
                  onRequestTrack={onRequestTrack && (() => onRequestTrack(s.t))}
                  confirming={i === idx && confirmTicker === s.t}
                  onConfirmDone={onConfirmDone}
                  mark={markOf(s.t)}
                  onMark={(v) => onMark(s.t, v)}
                  onPrev={goPrev}
                  onNext={goNext}
                  highlightReviews={i === idx ? highlightReviews : null}
                  openView={i === idx ? openView : null}
                  onViewClosed={onViewClosed}
                  onReviewsClosed={i === idx ? onReviewsClosed : undefined}
                  onReviewsUnavailable={i === idx ? onReviewsUnavailable : undefined}
                />
              )}
              {coach && i === idx && <SwipeCoach onDismiss={dismissCoach} />}
            </div>
          ))}
        </div>
        {goNext && (
          <button type="button" className="mkm-nav next" aria-label="Next stock" onClick={goNext}>
            ›
          </button>
        )}
      </div>
    </div>
  );
}
