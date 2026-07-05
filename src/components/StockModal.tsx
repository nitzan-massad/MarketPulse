import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { consClass, consLabel, fmtMc } from "../lib";
import type { Stock } from "../types";

// Keys come from build-time env (same pattern App uses for Finnhub). Never hardcoded.
const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_KEY ?? "";
const TWELVEDATA_KEY = import.meta.env.VITE_TWELVEDATA_KEY ?? "";

const yahooUrl = (ticker: string) =>
  `https://finance.yahoo.com/quote/${ticker.replace(/\./g, "-")}`;

type RangeId = "1D" | "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y";

const RANGES: RangeId[] = ["1D", "1W", "1M", "3M", "6M", "YTD", "1Y"];
const DEFAULT_RANGE: RangeId = "1M";

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
  hi: number;
  lo: number;
  last: number;
  volume: number | null; // most-recent bar volume ("today")
}

// module-level caches so reopening / re-selecting ranges never refetches
const quoteMetricCache = new Map<string, { quote: Quote; metric: Metric }>();
const seriesCache = new Map<string, Series>();

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

async function fetchQuoteMetric(ticker: string): Promise<{ quote: Quote; metric: Metric }> {
  const cached = quoteMetricCache.get(ticker);
  if (cached) return cached;

  const [qRes, mRes] = await Promise.all([
    fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`,
    ).then((r) => r.json()),
    fetch(
      `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${FINNHUB_KEY}`,
    ).then((r) => r.json()),
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

  const closes = bars.map((b) => b.c).filter((n) => isFinite(n));
  if (closes.length === 0) throw new Error("no closes");

  const last = bars[bars.length - 1];
  const series: Series = {
    closes,
    hi: Math.max(...closes),
    lo: Math.min(...closes),
    last: closes[closes.length - 1],
    volume: isFinite(last.v) ? last.v : null,
  };
  seriesCache.set(key, series);
  return series;
}

// build the SVG path (line) + area path from closes, mapped into the 600x140 box
function buildPaths(closes: number[]): { line: string; area: string; lastX: number; lastY: number } {
  const W = 600;
  const H = 140;
  const padY = 12;
  const n = closes.length;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const x = (i: number) => (n === 1 ? W : (i / (n - 1)) * (W - 12) + 6);
  const y = (v: number) => H - padY - ((v - min) / span) * (H - padY * 2);

  const pts = closes.map((v, i) => `${x(i).toFixed(2)} ${y(v).toFixed(2)}`);
  const line = "M" + pts.join(" L");
  const lastX = x(n - 1);
  const lastY = y(closes[n - 1]);
  const area = `${line} L${lastX.toFixed(2)} ${H} L${x(0).toFixed(2)} ${H} Z`;
  return { line, area, lastX, lastY };
}

interface StockModalProps {
  stock: Stock;
  onClose: () => void;
}

export default function StockModal({ stock, onClose }: StockModalProps) {
  const [range, setRange] = useState<RangeId>(DEFAULT_RANGE);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [metric, setMetric] = useState<Metric | null>(null);
  const [qmLoading, setQmLoading] = useState(true);
  const [series, setSeries] = useState<Series | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(true);
  const [seriesError, setSeriesError] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  const dir = dayPct == null ? "flat" : dayPct > 0 ? "up" : dayPct < 0 ? "dn" : "flat";
  const arrow = dayPct == null ? "" : dayPct > 0 ? "▴" : dayPct < 0 ? "▾" : "•";

  const upside =
    stock.up != null ? stock.up : price != null && stock.pt != null && price > 0
      ? ((stock.pt - price) / price) * 100
      : null;

  const totalAnalysts = stock.b + stock.h + stock.s;
  const rowPct = (v: number) => (totalAnalysts > 0 ? (v / totalAnalysts) * 100 : 0);

  // target ladder widths — normalize now / AI target / street target to the max
  const ladderMax = Math.max(price ?? 0, stock.aipt ?? 0, stock.pt ?? 0, 1);
  const nowW = ((price ?? 0) / ladderMax) * 100;
  const aiW = ((stock.aipt ?? 0) / ladderMax) * 100;
  const ptW = ((stock.pt ?? 0) / ladderMax) * 100;

  const paths = useMemo(
    () => (series && series.closes.length ? buildPaths(series.closes) : null),
    [series],
  );

  const chartAvailable = !seriesLoading && !seriesError && paths != null;
  const todayVol = series?.volume ?? null;

  return (
    <div className="mkm-scrim" onMouseDown={onBackdrop}>
      <div
        className="mkm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mkm-sym"
        ref={dialogRef}
      >
        {/* title bar */}
        <div className="mkm-titlebar">
          <div className="mkm-dots">
            <i />
            <i />
            <i />
          </div>
          <div className="mkm-path">
            mktpulse:// quote / <b>{stock.t}</b>
          </div>
          <div className="mkm-live">LIVE</div>
          <button className="mkm-close" aria-label="Close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="mkm-scroll">
          {/* head line */}
          <div className="mkm-head">
            <div className="mkm-headsym" id="mkm-sym">
              {stock.t}
            </div>
            <div className="mkm-co">
              {stock.n}
              {stock.sec ? " · " + consLabel(stock.sec) : ""}
            </div>
            <div className="mkm-px">{usd(price)}</div>
            <div className={`mkm-chg ${dir}`}>
              {qmLoading && quote == null ? "…" : `${arrow}${pct(dayPct).replace(/^[+-]/, "")}`}
            </div>
          </div>

          {/* CHART pane */}
          <div className="mkm-chartpane">
            <div className="mkm-cmdline">
              <span className="mkm-prompt">&gt;</span>
              <span className="mkm-cmd">plot {stock.t} --range</span>
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
                    <linearGradient id="mkm-grad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0" stopColor="#e8c15b" />
                      <stop offset="1" stopColor="#f0cf72" />
                    </linearGradient>
                    <linearGradient id="mkm-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="rgba(232,193,91,.16)" />
                      <stop offset="1" stopColor="rgba(232,193,91,0)" />
                    </linearGradient>
                  </defs>
                  <line className="mkm-gridln" x1="0" y1="35" x2="600" y2="35" />
                  <line className="mkm-gridln" x1="0" y1="70" x2="600" y2="70" />
                  <line className="mkm-gridln" x1="0" y1="105" x2="600" y2="105" />
                  <path fill="url(#mkm-fill)" d={paths!.area} />
                  <path className="mkm-chartline" d={paths!.line} />
                  <circle cx={paths!.lastX} cy={paths!.lastY} r="3" fill="#f0cf72" />
                </svg>
              )}
            </div>

            <div className="mkm-chart-log">
              <span>
                hi <b className="g">{chartAvailable ? usd(series!.hi) : "—"}</b> · lo{" "}
                <b>{chartAvailable ? usd(series!.lo) : "—"}</b> · n={range}
              </span>
              <span>
                last <b className="g">{chartAvailable ? usd(series!.last) : usd(price)}</b> ·{" "}
                Δ {pct(dayPct)}
              </span>
            </div>
          </div>

          {/* metric matrix */}
          <div className="mkm-matrix">
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
            <div className="mkm-cell">
              <div className="k">Mkt Cap</div>
              <div className="v">{fmtMc(stock.mc)}</div>
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
              <div className="mkm-klist">
                <div className="kr">
                  <span>Buy</span>
                  <b className="g">
                    {stock.b} &nbsp;{rowPct(stock.b).toFixed(1)}%
                  </b>
                </div>
                <div className="kr">
                  <span>Hold</span>
                  <b>
                    {stock.h} &nbsp;{rowPct(stock.h).toFixed(1)}%
                  </b>
                </div>
                <div className="kr">
                  <span>Sell</span>
                  <b>
                    {stock.s} &nbsp;{rowPct(stock.s).toFixed(1)}%
                  </b>
                </div>
              </div>
            </div>
            <div className="mkm-rp">
              <div className="mkm-rphdr">Target Ladder</div>
              <div className="mkm-ladder">
                <div className="lr">
                  <span className="lab">Now</span>
                  <span className="track">
                    <i className="now" style={{ width: `${nowW}%` }} />
                  </span>
                  <span className="n">{usd(price)}</span>
                </div>
                <div className="lr">
                  <span className="lab">AI tgt</span>
                  <span className="track">
                    <i className="aipt" style={{ width: `${aiW}%` }} />
                  </span>
                  <span className="n" style={{ color: "var(--t-teal)" }}>
                    {usd(stock.aipt)}
                  </span>
                </div>
                <div className="lr">
                  <span className="lab">St tgt</span>
                  <span className="track">
                    <i className="pt" style={{ width: `${ptW}%` }} />
                  </span>
                  <span className="n gold">{usd(stock.pt)}</span>
                </div>
              </div>
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

          {/* footer */}
          <div className="mkm-foot">
            <div className="mkm-flog">
              <span className="c">&gt;</span> <b>{stock.t}</b> resolved · {totalAnalysts} analysts ·
              SS {stock.ss ?? "—"} · AI {stock.ai ?? "—"}{" "}
              <span className="c">{stock.air || ""}</span>
            </div>
            <a
              className="mkm-yh"
              href={yahooUrl(stock.t)}
              target="_blank"
              rel="noopener noreferrer"
            >
              YAHOO ↗
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
