import { useState } from "react";
import { COLS, consClass, consLabel, fmtMc, fmtPx, isNew } from "../lib";
import type { Stock } from "../types";
import type { Mark, MarkEntry } from "../watchlist";
import ThumbMark from "./ThumbMark";
import { LivePx } from "../LivePx";
import { warmChart } from "../warmChart";

// default column widths (px) — table-layout:fixed makes these authoritative so
// resizing can both grow AND shrink a column. User overrides live in `widths`.
const DEFAULT_W: Record<string, number> = {
  _rank: 50, _tk: 236, sec: 126, px: 80, chg: 128, con: 116,
  pt: 90, up: 92, ss: 84, ai: 150, mc: 94,
};

interface StockTableProps {
  rows: Stock[];
  sort: string;
  dir: number;
  hl: string;
  onSort: (k: string) => void;
  live?: Record<string, number>;
  // true while Day% is actually moving (regular session); off-hours `live` still carries
  // the fresher last-session Day%, just without the live styling.
  ticking?: boolean;
  // ref-callback from useLiveQuotes: rows report visibility so they get
  // live-quoted only while on-screen.
  observe?: (ticker: string) => (el: HTMLElement | null) => void;
  onOpen: (s: Stock) => void;
  watchlist: string[];
  onToggleTrack: (t: string) => void;
  marks: Record<string, MarkEntry>;
  onMark: (t: string, v: Mark) => void;
}

export function Chip({ v }: { v: number | null }) {
  if (v == null) return <span className="dash">—</span>;
  const text = v % 1 ? v : v | 0;
  return <span className="chip">{text}</span>;
}

// No consensus from the feed → the same neutral "—" the other missing values use
// (see Chip above), NOT a pill: an unrated row must not look like a real Hold.
export function ConsPill({ con }: { con: string | null }) {
  if (con == null || con === "") return <span className="dash">—</span>;
  return <span className={`pill ${consClass(con)}`}>{consLabel(con)}</span>;
}

/** Buy/hold/sell split as a thin bar (counts stay in the tooltip). */
export function MiniSplit({ b, h, s }: { b: number; h: number; s: number }) {
  return (
    <div className="mini-split" role="img" aria-label={`${b} buy, ${h} hold, ${s} sell`} title={`${b} buy · ${h} hold · ${s} sell`}>
      {b > 0 && <i className="b" style={{ flex: b }} />}
      {h > 0 && <i className="h" style={{ flex: h }} />}
      {s > 0 && <i className="s" style={{ flex: s }} />}
    </div>
  );
}

/** AI rating text -> tag tone (Outperform pos, Underperform neg, else mid). */
export function aiTone(air: string | null | undefined): string {
  const a = (air || "").toLowerCase();
  if (/under|bear|sell/.test(a)) return "neg";
  if (/out|bull|buy/.test(a)) return "pos";
  return "mid";
}

/** 0–100 progress ring with the number in the middle (mockup ring()). */
export function AiRing({ n, size = 32 }: { n: number; size?: number }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const m = size / 2;
  return (
    <svg className="ai-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={m} cy={m} r={r} fill="none" stroke="var(--panel-2)" strokeWidth="4" />
      <circle cx={m} cy={m} r={r} fill="none" stroke="var(--teal)" strokeWidth="4" strokeLinecap="round"
        strokeDasharray={`${(c * Math.max(0, Math.min(100, n))) / 100} ${c}`} transform={`rotate(-90 ${m} ${m})`} />
      <text x="50%" y="50%" dy=".35em" textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--ink)" fontFamily="var(--f-num)">{n}</text>
    </svg>
  );
}

/** AI score as ring + rating tag; "—" when unrated. */
export function AiScore({ ai, air }: { ai: number | null; air?: string | null }) {
  if (ai == null) return <span className="dash">—</span>;
  return (
    <div className="ai-cell">
      <AiRing n={ai} />
      {air ? <span className={`tag ${aiTone(air)}`}>{air}</span> : null}
    </div>
  );
}

export function UpBar({ up }: { up: number | null }) {
  if (up == null) return <span className="dash">—</span>;
  const neg = up < 0;
  const val = (up > 0 ? "+" : "") + up.toLocaleString("en-US", { maximumFractionDigits: Math.abs(up) >= 100 ? 0 : 1, minimumFractionDigits: Math.abs(up) >= 100 ? 0 : 1 }) + "%";
  return <span className={`up-val ${neg ? "neg" : "pos"}`}>{val}</span>;
}

export default function StockTable({ rows, sort, dir, hl, onSort, live = {}, ticking = false, observe, onOpen, watchlist, onToggleTrack, marks, onMark }: StockTableProps) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("mp_colw") || "{}");
    } catch {
      return {};
    }
  });

  function startResize(key: string, e: React.PointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.parentElement as HTMLElement;
    const startX = e.clientX;
    const startW = th.offsetWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.max(56, startW + (ev.clientX - startX));
      setWidths((prev) => ({ ...prev, [key]: w }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setWidths((prev) => {
        try {
          localStorage.setItem("mp_colw", JSON.stringify(prev));
        } catch {
          /* ignore */
        }
        return prev;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // total = sum of column widths → table sizes to its content, no stretch, and
  // table-layout:fixed honors the per-column widths (so resize works).
  const totalW = COLS.reduce((s, c) => s + (widths[c.k] ?? DEFAULT_W[c.k]), 0);

  return (
    <div className="tablewrap">
      <table style={{ width: totalW }}>
        <thead>
          <tr id="head">
            {COLS.map((c) => {
              const sorted = c.sortable && c.k === sort;
              return (
                <th
                  key={c.k}
                  className={`${c.cls || ""} ${sorted ? "sorted" : ""}`}
                  data-k={c.k}
                  style={{ width: widths[c.k] ?? DEFAULT_W[c.k] }}
                  onClick={c.sortable ? () => onSort(c.k) : undefined}
                >
                  {c.l}
                  {c.sortable && (
                    <span className="ar">{sorted ? (dir < 0 ? "↓" : "↑") : "▾"}</span>
                  )}
                  <span
                    className="col-resize"
                    onPointerDown={(e) => startResize(c.k, e)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody id="body">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={11}>
                <div className="empty">No stocks match these filters.</div>
              </td>
            </tr>
          ) : (
            rows.map((s, i) => {
              const isHl = hl === sort;
              return (
                <tr
                  key={s.t}
                  ref={observe?.(s.t)}
                  className={`row-open ${isHl ? "hl" : ""}`}
                  style={{ animationDelay: `${Math.min(i, 40) * 14}ms` }}
                  {...warmChart(s.t)}
                  onClick={() => onOpen(s)}
                >
                  <td className="rank" data-label="Rank"><span className="rank-n">{i + 1}</span></td>
                  <td className="tk">
                    <div className="tk-inner">
                      <div className="tk-main">
                        <span className="tk-top">
                          <button
                            className={`wl-star ${watchlist.includes(s.t) ? "on" : ""}`}
                            type="button"
                            title={watchlist.includes(s.t) ? "Remove from watchlist" : "Add to watchlist"}
                            aria-label={watchlist.includes(s.t) ? `Remove ${s.t} from watchlist` : `Add ${s.t} to watchlist`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleTrack(s.t);
                            }}
                          >
                            {watchlist.includes(s.t) ? "★" : "☆"}
                          </button>
                          <button
                            className={`sym ${marks[s.t]?.v === "up" ? "mk-up" : marks[s.t]?.v === "down" ? "mk-down" : ""}`}
                            type="button"
                          >
                            {s.t}
                          </button>
                          {isNew(s.t) && (
                            <span className="newtag" title="Recently added to the lists">NEW</span>
                          )}
                        </span>
                        <div className="co" title={s.n || undefined}>{s.n || ""}</div>
                      </div>
                      <ThumbMark mark={marks[s.t]} onMark={(v) => onMark(s.t, v)} />
                    </div>
                  </td>
                  <td className="num" data-label="Price">
                    <LivePx t={s.t} px={s.px} />
                  </td>
                  <td data-label="Day %">
                    {(() => {
                      const chg = live[s.t] ?? s.chg;
                      const isLive = ticking && live[s.t] != null;
                      if (chg == null) return <span className="dash">—</span>;
                      return (
                        <span
                          className={`chg ${chg > 0 ? "up" : chg < 0 ? "dn" : "flat"}${isLive ? " is-live" : ""}`}
                        >
                          <span aria-hidden="true">{chg > 0 ? "▲ " : chg < 0 ? "▼ " : ""}</span>
                          <span className="sr-only">{chg < 0 ? "−" : chg > 0 ? "+" : ""}</span>
                          {Math.abs(chg).toFixed(2)}%
                        </span>
                      );
                    })()}
                  </td>
                  <td className="con-cell" data-label="Consensus">
                    <ConsPill con={s.con} />
                    <MiniSplit b={s.b} h={s.h} s={s.s} />
                  </td>
                  <td className="pt" data-label="Predicted Price">
                    {s.pt == null ? <span className="dash">—</span> : fmtPx(s.pt)}
                  </td>
                  <td data-label="Upside">
                    <UpBar up={s.up} />
                  </td>
                  <td data-label="Smart Score">
                    <Chip v={s.ss} />
                  </td>
                  <td data-label="AI Score">
                    <AiScore ai={s.ai} air={s.air} />
                  </td>
                  <td className="sec" data-label="Sector">{s.sec || "—"}</td>
                  <td className="num" data-label="Market Cap">{fmtMc(s.mc)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
