import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DATE_LOCALE } from "../lib";
import { hasPeHistory, lastYears, niceTicks, peSeries, peStats, type EpsPoint, type PePoint } from "../peHistory";
import { tickerTarget } from "../share";
import { useShare } from "../useShare";
import CloseButton from "./CloseButton";
import ShareBurst from "./ShareBurst";
import ShareButton, { ShareFail } from "./ShareButton";

// "P/E history" overlay: the stock's trailing P/E over 1Y/2Y/5Y with its own median and the
// sector average. Same portalled shell as the analyst-forecasts overlay (StockModal.tsx).

const RANGES = [["1Y", 1], ["2Y", 2], ["5Y", 5]] as const;
type RangeKey = (typeof RANGES)[number][0];

// fixed geometry, like the price chart: scales via height:auto, text undistorted
const W = 600, H = 190, T = 10, B = 166, L = 4, R = 552;

interface Props {
  ticker: string;
  eps: EpsPoint[];
  nowPe: number | null;
  /** Finnhub's quarterly peTTM — the listing-currency anchor for foreign filers and banks. */
  peq: EpsPoint[];
  sectorPe: number | null;
  /** The 5Y weekly price series — the price chart's own, so it is usually cached already. */
  loadSeries: () => Promise<{ stamps: string[]; closes: number[] }>;
  onClose: () => void;
}

const fmtDate = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString(DATE_LOCALE, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const x1 = (v: number) => v.toFixed(1) + "×";

/** `{ asOf, pts: [[date, pe|null, loss?], ...] }` written by ci/scrape-pe.mjs. */
async function loadStatic(t: string): Promise<PePoint[]> {
  const r = await fetch(`${import.meta.env.BASE_URL}pe/${encodeURIComponent(t)}.json`);
  if (!r.ok) throw new Error("no file");
  const j = (await r.json()) as { pts?: [string, number | null, 1?][] };
  if (!Array.isArray(j.pts) || j.pts.length < 2) throw new Error("empty");
  return j.pts.map(([d, v, loss]) => (loss ? { d, v, loss: true as const } : { d, v }));
}

export default function PeHistory({ ticker, eps, nowPe, peq, sectorPe, loadSeries, onClose }: Props) {
  const [all, setAll] = useState<PePoint[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState<RangeKey>("5Y");
  const [hover, setHover] = useState<number | null>(null);
  // `#TSM/pe`: the link opens the stock modal with this chart on top
  const share = useShare(tickerTarget(ticker, "pe"), ticker);

  useEffect(() => {
    let cancelled = false;
    // CI's precomputed file first (public/pe/<T>.json, ci/scrape-pe.mjs): no API call and no
    // shared rate limit. Off-universe tickers have no file, so fall back to computing it live.
    loadStatic(ticker)
      .catch(() =>
        loadSeries().then((s) => {
          const pts = peSeries(s.stamps, s.closes, eps, peq);
          if (!hasPeHistory(pts)) throw new Error("no history");
          return pts;
        }),
      )
      .then((p) => !cancelled && setAll(p))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [ticker, loadSeries, eps, peq]);

  const pts = useMemo(() => (all ? lastYears(all, RANGES.find((r) => r[0] === range)![1]) : []), [all, range]);
  const stats = peStats(pts);

  const chart = useMemo(() => {
    if (!stats || pts.length < 2) return null;
    const ticks = niceTicks(Math.min(stats.lo, sectorPe ?? stats.lo), Math.max(stats.hi, sectorPe ?? stats.hi));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const X = (i: number) => L + ((R - L) * i) / (pts.length - 1);
    const Y = (v: number) => B - ((B - T) * (v - lo)) / (hi - lo);
    // a loss stretch breaks the line rather than diving to zero
    let line = "", area = "", run: string[] = [];
    const flush = (endX: number, startX: number) => {
      if (run.length > 1) {
        line += "M" + run.join("L");
        area += `M${run.join("L")}L${endX.toFixed(1)} ${B}L${startX.toFixed(1)} ${B}Z`;
      }
      run = [];
    };
    let start = 0;
    pts.forEach((p, i) => {
      if (p.v == null) return flush(X(i - 1), X(start));
      if (!run.length) start = i;
      run.push(`${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`);
    });
    flush(X(pts.length - 1), X(start));
    const years: { x: number; label: string }[] = [];
    pts.forEach((p, i) => {
      if (i > 0 && p.d.slice(0, 4) !== pts[i - 1].d.slice(0, 4)) years.push({ x: X(i), label: "’" + p.d.slice(2, 4) });
    });
    const lastI = pts.map((p) => p.v != null).lastIndexOf(true);
    // runs of loss weeks -> "Unprofitable" strips along the bottom (half a week of bleed each side)
    const half = (R - L) / (pts.length - 1) / 2;
    const losses: { x: number; w: number }[] = [];
    pts.forEach((p, i) => {
      if (!p.loss) return;
      const prev = losses[losses.length - 1];
      if (prev && pts[i - 1]?.loss) prev.w = X(i) + half - prev.x;
      else losses.push({ x: Math.max(L, X(i) - half), w: half * 2 });
    });
    return { X, Y, line, area, ticks, years, lastI, losses };
  }, [pts, stats, sectorPe]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!chart) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((x - L) / (R - L)) * (pts.length - 1));
    setHover(Math.max(0, Math.min(pts.length - 1, i)));
  };
  const hp = hover != null ? pts[hover] : null;

  return createPortal(
    <div className="mkm-scrim mkm-scrim-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mkm-modal mkm-modal-fc" data-burst={share.burst ?? undefined} role="dialog" aria-modal="true" aria-label={`${ticker} P/E history`}>
        <div className="mkm-titlebar">
          <div className="mkm-path"><b>{ticker}</b> · P/E History</div>
          <ShareButton what={`${ticker} P/E history`} onShare={share.onShare} compact />
        </div>
        {share.copyFailed && <ShareFail url={share.url} />}
        <CloseButton what={`${ticker} P/E history`} onClose={onClose} />
        <div className="mkm-scroll">
          <div className="mkm-pe">
            <div className="mkm-pe-cmd">
              <div className="mkm-ranges" role="group" aria-label="P/E range">
                {RANGES.map(([k]) => (
                  <button key={k} type="button" className={k === range ? "on" : ""} aria-pressed={k === range} onClick={() => setRange(k)}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="mkm-pe-legend" aria-hidden="true">
                <span><i className="ln" />{ticker}</span>
                <span><i className="md" />Median</span>
                {sectorPe != null && <span><i className="sc" />Sector</span>}
                {chart && chart.losses.length > 0 && <span><i className="ls" />Unprofitable</span>}
              </div>
            </div>

            <div className={`mkm-scrub${hp?.v != null ? " on" : ""}`} aria-hidden="true">
              <span className="mkm-scrub-t">{hp ? fmtDate(hp.d) : ""}</span>
              <span className="mkm-scrub-p">{hp?.v != null ? x1(hp.v) : ""}</span>
            </div>

            <div className="mkm-plotbox mkm-pe-plot">
              {!all && !failed && <div className="mkm-plot-msg mkm-skel">Loading…</div>}
              {(failed || (all && !chart)) && <div className="mkm-plot-msg">No P/E history for {ticker}.</div>}
              {chart && stats && (
                <svg
                  viewBox={`0 0 ${W} ${H}`}
                  role="img"
                  aria-label={`${ticker} P/E over ${range}: median ${x1(stats.med)}, range ${x1(stats.lo)} to ${x1(stats.hi)}`}
                  onPointerMove={onMove}
                  onPointerDown={onMove}
                  onPointerLeave={() => setHover(null)}
                >
                  {chart.ticks.map((v) => (
                    <g key={v}>
                      <line className="mkm-gridln" x1={L} x2={R} y1={chart.Y(v)} y2={chart.Y(v)} />
                      <text className="mkm-pe-ax" x={R + 8} y={chart.Y(v) + 4}>{v}</text>
                    </g>
                  ))}
                  {chart.losses.map((b) => (
                    <g key={b.x}>
                      <rect className="mkm-pe-loss" x={b.x} y={B - 18} width={Math.min(b.w, R - b.x)} height="18" rx="3" />
                      {b.w > 90 && <text className="mkm-pe-losst" x={b.x + Math.min(b.w, R - b.x) / 2} y={B - 5}>Unprofitable</text>}
                    </g>
                  ))}
                  <path d={chart.area} fill="var(--t-gold)" fillOpacity=".08" />
                  <line x1={L} x2={R} y1={chart.Y(stats.med)} y2={chart.Y(stats.med)} stroke="var(--t-faint)" strokeWidth="1.2" strokeDasharray="5 4" />
                  {sectorPe != null && (
                    <line x1={L} x2={R} y1={chart.Y(sectorPe)} y2={chart.Y(sectorPe)} stroke="var(--t-teal)" strokeWidth="1.5" strokeDasharray="2 4" />
                  )}
                  <path d={chart.line} fill="none" stroke="var(--t-gold)" strokeWidth="2" strokeLinejoin="round" />
                  {/* the "now" dot only on the newest week; a gap at the end means no current P/E */}
                  {chart.lastI === pts.length - 1 && (
                    <circle cx={chart.X(chart.lastI)} cy={chart.Y(pts[chart.lastI].v!)} r="4" fill="var(--t-red)" />
                  )}
                  {chart.years.map((y) => (
                    <text key={y.label} className="mkm-pe-yr" x={y.x} y={H - 6}>{y.label}</text>
                  ))}
                  {hp?.v != null && hover != null && (
                    <g>
                      <line x1={chart.X(hover)} x2={chart.X(hover)} y1={T} y2={B} stroke="var(--t-faint)" strokeWidth="1" />
                      <circle cx={chart.X(hover)} cy={chart.Y(hp.v)} r="4.5" fill="var(--t-gold)" stroke="#fff" strokeWidth="1.5" />
                    </g>
                  )}
                </svg>
              )}
            </div>

            <div className="mkm-kv mkm-pe-kv">
              <div className="row">
                <div className="k">Now</div>
                <div className="v gold">{nowPe != null && nowPe > 0 ? x1(nowPe) : "—"}</div>
              </div>
              <div className="row">
                <div className="k">{range} median</div>
                <div className="v">{stats ? x1(stats.med) : "—"}</div>
              </div>
              <div className="row">
                <div className="k">{range} range</div>
                <div className="v">{stats ? `${stats.lo.toFixed(0)}–${stats.hi.toFixed(0)}×` : "—"}</div>
              </div>
              <div className="row">
                <div className="k">Sector avg</div>
                <div className="v teal">{sectorPe != null ? x1(sectorPe) : "—"}</div>
              </div>
            </div>
          </div>
        </div>
        {share.burst && <ShareBurst id={share.burst} onDone={share.onBurstDone} />}
      </div>
    </div>,
    document.body,
  );
}
