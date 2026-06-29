import { COLS, consClass, consLabel, fmtMc, fmtPx, scoreColor } from "../lib";
import type { Stock } from "../types";

interface StockTableProps {
  rows: Stock[];
  sort: string;
  dir: number;
  hl: string;
  onSort: (k: string) => void;
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

export default function StockTable({ rows, sort, dir, hl, onSort }: StockTableProps) {
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
                  onClick={c.sortable ? () => onSort(c.k) : undefined}
                >
                  {c.l}
                  <span className="ar">{sorted ? (dir < 0 ? "▼" : "▲") : "▾"}</span>
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
                    <div className="sym">{s.t}</div>
                    <div className="co">{s.n || ""}</div>
                  </td>
                  <td className="sec" data-label="Sector">{s.sec || "—"}</td>
                  <td className="num" data-label="Price">{fmtPx(s.px)}</td>
                  <td data-label="Day %">
                    {s.chg == null ? (
                      <span className="dash">—</span>
                    ) : (
                      <span className={`chg ${s.chg > 0 ? "up" : s.chg < 0 ? "dn" : "flat"}`}>
                        {s.chg > 0 ? "+" : ""}
                        {s.chg.toFixed(2)}%
                      </span>
                    )}
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
