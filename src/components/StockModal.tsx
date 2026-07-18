import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { consClass, consLabel, fmtMc } from "../lib";
import type { Stock } from "../types";
import type { Mark, MarkEntry } from "../watchlist";
import ThumbMark from "./ThumbMark";

// Keys come from build-time env (same pattern App uses for Finnhub). Never hardcoded.
const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_KEY ?? "";
const TWELVEDATA_KEY = import.meta.env.VITE_TWELVEDATA_KEY ?? "";
// FMP powers the live company description ONLY for tickers missing from the
// scraped DB (hybrid: DB desc wins). Optional — absent key just skips it.
const FMP_KEY = import.meta.env.VITE_FMP_KEY ?? "";

// Apple Stocks universal link — opens the Stocks app on iOS/macOS, web elsewhere.
const stocksUrl = (ticker: string) =>
  `https://stocks.apple.com/symbol/${encodeURIComponent(ticker)}`;

type RangeId = "1D" | "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y";

const RANGES: RangeId[] = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"];
const DEFAULT_RANGE: RangeId = "1D";

// range -> Twelve Data interval + outputsize
const RANGE_CFG: Record<RangeId, { interval: string; outputsize: number }> = {
  "1D": { interval: "5min", outputsize: 78 },
  "1W": { interval: "30min", outputsize: 66 },
  "1M": { interval: "1day", outputsize: 22 },
  "3M": { interval: "1day", outputsize: 66 },
  "6M": { interval: "1day", outputsize: 130 },
  YTD: { interval: "1day", outputsize: 200 },
  "1Y": { interval: "1day", outputsize: 252 },
};

interface Quote {
  c: number | null; // current
  dp: number | null; // day %
  o: number | null; // open
  h: number | null; // high
  l: number | null; // low
  pc: number | null; // prev close
}

interface Metric {
  hi52: number | null;
  lo52: number | null;
  pe: number | null;
  beta: number | null;
  avgVol3M: number | null;
  avgVol10D: number | null;
}

// live company profile (name / industry / market cap) — replaces the scraped
// DB fields so these are current for any ticker, ranked or not
interface Profile {
  name: string | null;
  sector: string | null;
  mktCap: number | null; // $ millions (same unit as the DB `mc`)
}

interface Bar {
  t: string; // datetime
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface Series {
  closes: number[];
  stamps: string[]; // bar datetimes, parallel to closes (oldest-first)
  hi: number;
  lo: number;
  last: number;
  volume: number | null; // most-recent bar volume ("today")
}

// module-level caches so reopening / re-selecting ranges never refetches
const quoteMetricCache = new Map<string, { quote: Quote; metric: Metric; profile: Profile }>();
const seriesCache = new Map<string, Series>();

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
}
const bbCache = new Map<string, BullBear | null>();
async function fetchBullBear(ticker: string): Promise<BullBear | null> {
  if (bbCache.has(ticker)) return bbCache.get(ticker)!;
  let val: BullBear | null = null;
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}bullbear/${encodeURIComponent(ticker)}.json`);
    if (r.ok) {
      const j = await r.json();
      if (j && ((j.bull && j.bull.length) || (j.bear && j.bear.length)))
        val = { bull: j.bull || [], bear: j.bear || [] };
    }
  } catch {
    /* missing / offline -> not available */
  }
  bbCache.set(ticker, val);
  return val;
}

// Analyst forecasts — per-ticker snapshot pulled from TipRanks' free getData
// feed (name, firm, star rating, price target, prior target, position, date),
// baked into public/forecasts/. Lazy-fetched; absent/empty -> no coverage.
interface Forecast {
  n: string | null; // analyst name
  f: string | null; // firm
  st: number | null; // TipRanks star rating 0–5
  r: string | null; // position: Buy / Hold / Sell
  pt: number; // price target
  opt: number | null; // prior target (shows "old → new")
  d: string; // rating date "YYYY-MM-DD"
}
const fcCache = new Map<string, Forecast[] | null>();
async function fetchForecasts(ticker: string): Promise<Forecast[] | null> {
  if (fcCache.has(ticker)) return fcCache.get(ticker)!;
  let val: Forecast[] | null = null;
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}forecasts/${encodeURIComponent(ticker)}.json`);
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j.length) val = j;
    }
  } catch {
    /* missing / offline -> no coverage */
  }
  fcCache.set(ticker, val);
  return val;
}

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

const usd = (v: number | null | undefined, dp = 2): string =>
  v == null ? "—" : "$" + v.toFixed(dp);

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

async function fetchQuoteMetric(ticker: string): Promise<{ quote: Quote; metric: Metric; profile: Profile }> {
  const cached = quoteMetricCache.get(ticker);
  if (cached) return cached;

  const enc = encodeURIComponent(ticker);
  const [qRes, mRes, pRes] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/quote?symbol=${enc}&token=${FINNHUB_KEY}`).then((r) => r.json()),
    fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${enc}&metric=all&token=${FINNHUB_KEY}`).then((r) => r.json()),
    fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${enc}&token=${FINNHUB_KEY}`).then((r) => r.json()),
  ]);

  const m = (mRes && mRes.metric) || {};
  const result = {
    quote: {
      c: num(qRes?.c),
      dp: num(qRes?.dp),
      o: num(qRes?.o),
      h: num(qRes?.h),
      l: num(qRes?.l),
      pc: num(qRes?.pc),
    },
    metric: {
      hi52: num(m["52WeekHigh"]),
      lo52: num(m["52WeekLow"]),
      pe: num(m.peTTM) ?? num(m.peBasicExclExtraTTM),
      beta: num(m.beta),
      avgVol3M: num(m["3MonthAverageTradingVolume"]),
      avgVol10D: num(m["10DayAverageTradingVolume"]),
    },
    profile: {
      name: typeof pRes?.name === "string" && pRes.name ? pRes.name : null,
      sector: typeof pRes?.finnhubIndustry === "string" && pRes.finnhubIndustry ? pRes.finnhubIndustry : null,
      mktCap: num(pRes?.marketCapitalization),
    },
  };
  quoteMetricCache.set(ticker, result);
  return result;
}

async function fetchSeries(ticker: string, range: RangeId): Promise<Series> {
  const key = `${ticker}|${range}`;
  const cached = seriesCache.get(key);
  if (cached) return cached;
  if (!TWELVEDATA_KEY) throw new Error("no twelvedata key");

  const { interval, outputsize } = RANGE_CFG[range];
  const res = await fetch(
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVEDATA_KEY}`,
  ).then((r) => r.json());

  // TD returns newest-first values[]; error responses have status:"error"
  const raw: unknown[] = Array.isArray(res?.values) ? res.values : [];
  if (res?.status === "error" || raw.length === 0) throw new Error("no series");

  const bars: Bar[] = raw
    .map((v) => {
      const b = v as Record<string, string>;
      return {
        t: b.datetime,
        o: parseFloat(b.open),
        h: parseFloat(b.high),
        l: parseFloat(b.low),
        c: parseFloat(b.close),
        v: parseFloat(b.volume),
      };
    })
    .reverse(); // -> oldest-first for plotting

  const clean = bars.filter((b) => isFinite(b.c));
  if (clean.length === 0) throw new Error("no closes");
  const closes = clean.map((b) => b.c);
  const stamps = clean.map((b) => b.t);

  const last = clean[clean.length - 1];
  const series: Series = {
    closes,
    stamps,
    hi: Math.max(...closes),
    lo: Math.min(...closes),
    last: closes[closes.length - 1],
    volume: isFinite(last.v) ? last.v : null,
  };
  seriesCache.set(key, series);
  return series;
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
  baseY: number; // dashed reference line (range's opening price)
  priceTicks: { y: number; label: string }[];
  dateTicks: { x: number; label: string }[];
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

// "YYYY-MM-DD" -> "M/D"; "YYYY-MM-DD HH:MM:SS" -> "HH:MM" (intraday). No Date() (tz-safe).
function fmtStamp(s: string, intraday: boolean): string {
  const [d, t] = s.split(" ");
  if (intraday && t) return t.slice(0, 5);
  const p = d.split("-");
  return `${+p[1]}/${+p[2]}`;
}

function buildChart(closes: number[], stamps: string[], intraday: boolean): ChartModel {
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

  const dp = hi >= 100 ? 0 : hi >= 10 ? 1 : 2;
  const priceTicks = niceTicks(lo, hi, 4)
    .filter((v) => v >= lo && v <= hi)
    .map((v) => ({ y: y(v), label: v.toFixed(dp) }));

  const nLbl = Math.min(6, n);
  const denom = Math.max(1, nLbl - 1);
  const dateTicks = Array.from({ length: nLbl }, (_, k) => {
    const i = Math.round((k / denom) * (n - 1));
    return { x: x(i), label: fmtStamp(stamps[i] || "", intraday) };
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
  };
}

interface StockModalProps {
  stock: Stock;
  onClose: () => void;
  tracked: boolean;
  onToggleTrack: () => void;
  covered?: boolean; // in the TipRanks ranked set? false => live data only
  mark?: MarkEntry;
  onMark: (v: Mark) => void;
  onPrev?: () => void; // page to previous stock in the list (undefined = none)
  onNext?: () => void; // page to next stock
}

export default function StockModal({ stock, onClose, tracked, onToggleTrack, covered = true, mark, onMark, onPrev, onNext }: StockModalProps) {
  const [range, setRange] = useState<RangeId>(DEFAULT_RANGE);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [metric, setMetric] = useState<Metric | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [qmLoading, setQmLoading] = useState(true);
  const [series, setSeries] = useState<Series | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [seriesError, setSeriesError] = useState(false);
  const [bb, setBb] = useState<BullBear | null>(null);
  const [bbTab, setBbTab] = useState<"bull" | "bear">("bull");
  const [descOpen, setDescOpen] = useState(false);
  const [bbOpen, setBbOpen] = useState<Set<number>>(() => new Set()); // per-topic expanded indices
  const [forecasts, setForecasts] = useState<Forecast[] | null>(null);
  const [fcOpen, setFcOpen] = useState(false);
  const [liveDesc, setLiveDesc] = useState<string | null>(null);
  const [burst, setBurst] = useState<{ dir: Mark; k: number } | null>(null); // big thumb press animation
  const dialogRef = useRef<HTMLDivElement>(null);

  // persist the thumb (via onMark) and fire the big bounce+ring+fade — only when
  // setting a mark, not when clearing it
  const react = useCallback(
    (v: Mark) => {
      const setting = mark?.v !== v;
      onMark(v);
      if (setting) setBurst((b) => ({ dir: v, k: (b?.k ?? 0) + 1 }));
    },
    [mark, onMark],
  );

  // close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (fcOpen) setFcOpen(false); // close the forecasts modal first
        else onClose();
        return;
      }
      if (fcOpen) return; // don't page the underlying stock while forecasts is up
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      else if (e.key === "ArrowRight" && onNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, fcOpen, onPrev, onNext]);

  // lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // fetch quote + metric on open (per ticker, cached)
  useEffect(() => {
    let cancelled = false;
    setQmLoading(true);
    fetchQuoteMetric(stock.t)
      .then((r) => {
        if (cancelled) return;
        setQuote(r.quote);
        setMetric(r.metric);
        setProfile(r.profile);
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
  }, [stock.t]);

  // fetch Bulls Say / Bears Say snapshot + reset the panel/description on ticker change
  useEffect(() => {
    let cancelled = false;
    setBb(null);
    setBbTab("bull");
    setBbOpen(new Set());
    setDescOpen(false);
    setForecasts(null);
    setFcOpen(false);
    setLiveDesc(null);
    setBurst(null);
    fetchBullBear(stock.t).then((r) => {
      if (!cancelled) setBb(r);
    });
    fetchForecasts(stock.t).then((r) => {
      if (!cancelled) setForecasts(r);
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
  }, [stock.t, stock.desc]);

  // fetch series for the active range (default 1M on open; others on tab click)
  useEffect(() => {
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
        if (!cancelled) setSeriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stock.t, range]);

  const onBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // ---- derived display values (live extras layered over the snapshot row) ----
  const price = quote?.c ?? stock.px;
  const dayPct = quote?.dp ?? stock.chg;
  // prefer live profile (Finnhub) over the scraped DB row for these fields
  const name = profile?.name ?? stock.n;
  const sector = profile?.sector ?? stock.sec;
  const mktCap = profile?.mktCap ?? stock.mc;
  const desc = stock.desc || liveDesc; // scraped DB desc wins; live FMP fallback
  // the % beside the price tracks the selected chart range: 1D uses the true
  // day move (vs prev close); other ranges use the series' first→last change
  const rangePct =
    range === "1D"
      ? dayPct
      : series && series.closes.length > 1 && series.closes[0]
        ? ((series.last - series.closes[0]) / series.closes[0]) * 100
        : null;
  const pctLoading = range === "1D" ? qmLoading && quote == null : seriesLoading;
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
    "$" + (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
  const posClass = (r: string | null): string =>
    r === "Buy" ? "buy" : r === "Sell" ? "sell" : "hold";
  const fmtFcDate = (d: string): string => {
    const [y, m, dd] = d.split("-");
    return `${m}/${dd}/${y.slice(2)}`;
  };
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
      series && series.closes.length
        ? buildChart(series.closes, series.stamps, RANGE_CFG[range].interval.includes("min"))
        : null,
    [series, range],
  );

  const chartAvailable = !seriesLoading && !seriesError && chart != null;
  const todayVol = series?.volume ?? null;

  // off-universe tickers have no scraped DB row, so while their live data is in
  // flight show a spinner (not the empty template); once settled, either the
  // full modal or, if nothing came back, a clear "not found" state.
  const loadingUncovered = !covered && (qmLoading || seriesLoading);
  const noData =
    !covered && !qmLoading && !seriesLoading && (price == null || price === 0) && !chartAvailable;
  const chromeOff = noData || loadingUncovered; // hide star/LIVE until we know

  return (
    <>
    <div className="mkm-scrim" onMouseDown={onBackdrop}>
      <div className="mkm-stage">
        {onPrev && (
          <button type="button" className="mkm-nav prev" aria-label="Previous stock" onClick={onPrev}>
            ‹
          </button>
        )}
      <div
        className="mkm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mkm-sym"
        ref={dialogRef}
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
          {!chromeOff && <ThumbMark mark={mark} onMark={react} both />}
          {!chromeOff && <div className="mkm-live">LIVE</div>}
          <button className="mkm-close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>

        {/* big thumb press animation (bounce + ring + fade) */}
        {burst && (
          <div className="mkm-burst" aria-hidden="true">
            <span key={burst.k} className={`mkm-burst-ring ${burst.dir}`} />
            <span
              key={`t${burst.k}`}
              className="mkm-burst-thumb"
              onAnimationEnd={() => setBurst(null)}
            >
              {burst.dir === "up" ? "👍" : "👎"}
            </span>
          </div>
        )}

        <div className="mkm-scroll">
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
          {!covered && <div className="mkm-lim">Limited data — not in the ranked set</div>}
          {/* head line — ticker now lives in the title bar; company + price here */}
          <div className="mkm-head">
            <div className="mkm-co">
              {name}
              {sector ? " · " + consLabel(sector) : ""}
            </div>
            <div className="mkm-px">{usd(price)}</div>
            <div className={`mkm-chg ${dir}`}>
              {pctLoading ? "…" : rangePct == null ? "—" : `${arrow}${pct(rangePct).replace(/^[+-]/, "")}`}
            </div>
          </div>

          {/* CHART pane */}
          <div className="mkm-chartpane">
            <div className="mkm-cmdline">
              <span className="mkm-ranges">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    className={r === range ? "on" : ""}
                    onClick={() => setRange(r)}
                  >
                    {r}
                  </button>
                ))}
              </span>
            </div>

            <div className="mkm-plotbox">
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
                  {/* dashed reference line at the range's opening price */}
                  <line className="mkm-baseln" x1="0" y1={chart!.baseY} x2={CW - C_R} y2={chart!.baseY} />
                  <path fill={chart!.up ? "url(#mkm-fill-up)" : "url(#mkm-fill-dn)"} d={chart!.area} />
                  <path className={`mkm-chartline ${chart!.up ? "up" : "dn"}`} d={chart!.line} />
                  <circle
                    cx={chart!.lastX}
                    cy={chart!.lastY}
                    r="3"
                    fill={chart!.up ? "#32d74b" : "#ff453a"}
                  />
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
                      className="mkm-axtx"
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
            <div className="mkm-rp">
              <div className="mkm-fchdr">
                <span className="mkm-rphdr" style={{ marginBottom: 0 }}>Analyst Forecasts</span>
                {forecasts && (
                  <button
                    type="button"
                    className="mkm-fcpill"
                    aria-haspopup="dialog"
                    onClick={() => setFcOpen(true)}
                  >
                    See all {forecasts.length} →
                  </button>
                )}
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
                        <span className={`mkm-fcup ${up != null && up < 0 ? "dn" : ""}`}>
                          {up == null ? "" : pct(up)}
                        </span>
                        <span className="mkm-fcdate">{fmtFcDate(f.d)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mkm-bbna">No analyst forecasts for this stock.</div>
              )}
            </div>
          </div>

          {/* stats block */}
          <div className="mkm-statblock">
            <div className="mkm-rphdr">Session &amp; Fundamentals</div>
            <div className="mkm-kv">
              <div className="row">
                <div className="k">Open</div>
                <div className={`v ${qmLoading && !quote ? "skel" : ""}`}>{usd(quote?.o)}</div>
              </div>
              <div className="row">
                <div className="k">High</div>
                <div className={`v up ${qmLoading && !quote ? "skel" : ""}`}>{usd(quote?.h)}</div>
              </div>
              <div className="row">
                <div className="k">Low</div>
                <div className={`v dn ${qmLoading && !quote ? "skel" : ""}`}>{usd(quote?.l)}</div>
              </div>
              <div className="row">
                <div className="k">Prev Close</div>
                <div className={`v ${qmLoading && !quote ? "skel" : ""}`}>{usd(quote?.pc)}</div>
              </div>
              <div className="row">
                <div className="k">Volume</div>
                <div className={`v ${seriesLoading ? "skel" : ""}`}>{fmtVol(todayVol)}</div>
              </div>
              <div className="row">
                <div className="k">52W High</div>
                <div className={`v ${qmLoading && !metric ? "skel" : ""}`}>{usd(metric?.hi52)}</div>
              </div>
              <div className="row">
                <div className="k">52W Low</div>
                <div className={`v ${qmLoading && !metric ? "skel" : ""}`}>{usd(metric?.lo52)}</div>
              </div>
              <div className="row">
                <div className="k">Avg Vol 3M</div>
                <div className={`v ${qmLoading && !metric ? "skel" : ""}`}>
                  {fmtVol(metric?.avgVol3M != null ? metric.avgVol3M * 1e6 : null)}
                </div>
              </div>
              <div className="row">
                <div className="k">P/E TTM</div>
                <div className={`v ${qmLoading && !metric ? "skel" : ""}`}>
                  {metric?.pe == null ? "—" : metric.pe.toFixed(2)}
                </div>
              </div>
              <div className="row">
                <div className="k">Beta</div>
                <div className={`v ${qmLoading && !metric ? "skel" : ""}`}>
                  {metric?.beta == null ? "—" : metric.beta.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* company description — first line shown, rest collapsed */}
          {desc && (
            <div className="mkm-about">
              <div className="mkm-abouthdr">About {name}</div>
              <p className={`mkm-desc ${descOpen ? "" : "mkm-clamp1"}`}>{desc}</p>
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
            <div className="mkm-bbhdr">Bulls Say, Bears Say</div>
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
      </div>
        {onNext && (
          <button type="button" className="mkm-nav next" aria-label="Next stock" onClick={onNext}>
            ›
          </button>
        )}
      </div>
    </div>

    {/* full analyst forecast list — opens as a separate modal on top */}
    {fcOpen && forecasts && (
      <div
        className="mkm-scrim mkm-scrim-top"
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
            <div className="mkm-path"><b>{stock.t}</b> · Analyst Forecasts</div>
            <button className="mkm-close" aria-label="Close" onClick={() => setFcOpen(false)}>
              &times;
            </button>
          </div>
          <div className="mkm-scroll">
            <div className="mkm-fcfull mkm-fcfull-modal">
              <div className="mkm-fctable">
                <div className="mkm-fchead">
                  <span className="ctr" title="TipRanks analyst star rating">★</span>
                  <span>Analyst / Firm</span>
                  <span className="ar">Rating</span>
                  <span className="ar">Price Target</span>
                  <span className="ar">Upside</span>
                  <span className="ar">Date</span>
                </div>
                {forecasts.map((f, i) => {
                  const up = fcUpside(f.pt);
                  return (
                    <div className="mkm-fcfrow" key={i}>
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
                      <span className={`mkm-fcup ${up != null && up < 0 ? "dn" : ""}`}>
                        {up == null ? "" : pct(up)}
                      </span>
                      <span className="mkm-fcdate">{fmtFcDate(f.d)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
