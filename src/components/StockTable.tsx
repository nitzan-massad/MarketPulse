import { useState } from "react";
import { COLS, consClass, consLabel, fmtMc, fmtPx, scoreColor } from "../lib";
import type { Stock } from "../types";

const yahooUrl = (ticker: string) =>
  `https://finance.yahoo.com/quote/${ticker.replace(/\./g, "-")}`;

// default column widths (px) — table-layout:fixed makes these authoritative so
// resizing can both grow AND shrink a column. User overrides live in `widths`.
const DEFAULT_W: Record<string, number> = {
  _rank: 50, _tk: 210, sec: 115, px: 85, chg: 92, con: 158,
  pt: 140, up: 150, ss: 132, ai: 124, mc: 122,
};

interface StockTableProps {
  rows: Stock[];
  sort: string;
  dir: number;
  hl: string;
  onSort: (k: string) => void;
  live?: Record<string, number>;
}

function Chip({ v, max }: { v: number | null; max: number }) {
  if (v == null) return <span className="dash">—</span>;
  const c = scoreColor(v, max)!;
  const text = v % 1 ? v : v | 0;
  return (
    <span className="chip" style={{ color: c, borderColor: c + "44", background: c + "14" }}>
      {text}
    </span>
  );
}

function UpBar({ up }: { up: number | null }) {
  if (up == null) return <span className="dash">—</span>;
  const neg = up < 0;
  const w =
    up <= 0
      ? Math.min(100, (Math.abs(up) / 40) * 100)
      : Math.min(100, (Math.log10(up + 1) / Math.log10(3500)) * 100);
  const val = (up > 0 ? "+" : "") + up.toFixed(up >= 100 ? 0 : 1) + "%";
  return (
    <div className="up-cell">
      <span className="up-bar">
        <i className={neg ? "neg" : ""} style={{ width: `${Math.max(3, w)}%` }} />
      </span>
      <span className={`up-val ${neg ? "neg" : "pos"}`}>{val}</span>
    </div>
  );
}

export default function StockTable({ rows, sort, dir, hl, onSort, live = {} }: StockTableProps) {
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

  return (
    <div className="tablewrap">
      <table>
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
                  <span className="ar">{sorted ? (dir < 0 ? "▼" : "▲") : "▾"}</span>
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
                  className={isHl ? "hl" : ""}
                  style={{ animationDelay: `${Math.min(i, 40) * 14}ms` }}
                >
                  <td className="rank" data-label="Rank">{i + 1}</td>
                  <td className="tk">
                    <a className="sym" href={yahooUrl(s.t)} target="_blank" rel="noopener noreferrer">
                      {s.t}
                    </a>
                    <div className="co">{s.n || ""}</div>
                  </td>
                  <td className="sec" data-label="Sector">{s.sec || "—"}</td>
                  <td className="num" data-label="Price">{fmtPx(s.px)}</td>
                  <td data-label="Day %">
                    {(() => {
                      const isLive = live[s.t] != null;
                      const chg = isLive ? live[s.t] : s.chg;
                      if (chg == null) return <span className="dash">—</span>;
                      return (
                        <span
                          className={`chg ${chg > 0 ? "up" : chg < 0 ? "dn" : "flat"}${isLive ? " is-live" : ""}`}
                        >
                          {chg > 0 ? "+" : ""}
                          {chg.toFixed(2)}%
                        </span>
                      );
                    })()}
                  </td>
                  <td data-label="Consensus">
                    <span className={`pill ${consClass(s.con)}`}>{consLabel(s.con)}</span>
                    <div className="dist">{s.b}·{s.h}·{s.s}</div>
                  </td>
                  <td className="pt" data-label="Price Target">
                    {s.pt == null ? <span className="dash">—</span> : "$" + s.pt.toFixed(2)}
                  </td>
                  <td data-label="Upside">
                    <UpBar up={s.up} />
                  </td>
                  <td data-label="Smart Score">
                    <Chip v={s.ss} max={10} />
                  </td>
                  <td data-label="AI Score">
                    <div className="ai-cell">
                      {s.ai == null ? (
                        <span className="dash">—</span>
                      ) : (
                        <>
                          <span
                            style={{
                              color: scoreColor(s.ai, 100)!,
                              fontFamily: "'JetBrains Mono',monospace",
                              fontWeight: 700,
                            }}
                          >
                            {s.ai}
                          </span>
                          <span className="ai-rating">{s.air || ""}</span>
                        </>
                      )}
                    </div>
                  </td>
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
