import { useMemo } from "react";
import stocksData from "../data/stocks.json";
import type { Stock } from "../types";
import { addedInfo, agoLabel, consClass, consLabel, firstSeen, fmtMc, fmtPx, LIST_LABEL, NEW_WINDOW_DAYS, scoreColor } from "../lib";
import { Chip, UpBar } from "./StockTable";

const STOCKS = stocksData as Stock[];

const fmtDate = (iso: string): string =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

const CONS_RANK: Record<string, number> = { StrongSell: 1, Sell: 2, Hold: 3, Buy: 4, StrongBuy: 5 };

interface Change {
  k: string;
  o: string;
  n: string;
  dir: "up" | "down";
}

// what moved for this ticker since it was first tracked (baseline in seen.json → current)
function changesFor(s: Stock): Change[] {
  const fs = firstSeen(s.t);
  if (!fs) return [];
  const out: Change[] = [];
  if (fs.ss != null && s.ss != null && fs.ss !== s.ss)
    out.push({ k: "Smart Score", o: String(fs.ss), n: String(s.ss), dir: s.ss > fs.ss ? "up" : "down" });
  if (fs.ai != null && s.ai != null && fs.ai !== s.ai)
    out.push({ k: "AI Score", o: String(fs.ai), n: String(s.ai), dir: s.ai > fs.ai ? "up" : "down" });
  if (fs.con && s.con && fs.con !== s.con)
    out.push({
      k: "Consensus",
      o: consLabel(fs.con),
      n: consLabel(s.con),
      dir: (CONS_RANK[s.con] ?? 0) >= (CONS_RANK[fs.con] ?? 0) ? "up" : "down",
    });
  return out;
}

interface NewArrivalsProps {
  onOpen: (s: Stock) => void;
}

export default function NewArrivals({ onOpen }: NewArrivalsProps) {
  const items = useMemo(() => {
    return STOCKS.map((s) => ({ s, info: addedInfo(s.t) }))
      .filter((x): x is { s: Stock; info: { date: string; daysAgo: number } } => x.info != null)
      .sort(
        (a, b) =>
          a.info.daysAgo - b.info.daysAgo ||
          (b.s.up ?? -Infinity) - (a.s.up ?? -Infinity),
      );
  }, []);

  return (
    <div className="bob">
      <header className="bob-masthead">
        <div className="bob-eyebrow">New · last {NEW_WINDOW_DAYS} days</div>
        <h1 className="bob-title">
          New <span className="em">Arrivals</span>
        </h1>
        <p className="bob-dek">
          Tickers that entered the TipRanks lists recently — freshly added to the ranked universe,
          newest first. The Changes column shows what's moved since each name was first tracked.
        </p>
        <div className="bob-counts">
          <span>
            <b>{items.length}</b> added in the last {NEW_WINDOW_DAYS} days
          </span>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="bob-empty">No new names this month.</div>
      ) : (
        <div className="na-wrap">
          <table className="na-table">
            <thead>
              <tr>
                <th className="l">Added</th>
                <th className="l">Changes</th>
                <th className="l">Ticker / Company</th>
                <th>Price</th>
                <th className="l">Consensus</th>
                <th>Upside</th>
                <th>Smart Score</th>
                <th>AI Score</th>
                <th>Mkt Cap</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ s, info }) => {
                const chg = changesFor(s);
                const lists = firstSeen(s.t)?.l ?? [];
                return (
                  <tr key={s.t}>
                    <td className="na-added">
                      <span className={`na-pill ${info.daysAgo <= 2 ? "" : "old"}`}>
                        <span className="na-pd" aria-hidden="true" />
                        <span className="na-pt">{agoLabel(info.daysAgo)}</span>
                      </span>
                      <span className="na-date">{fmtDate(info.date)}</span>
                    </td>
                    <td className="na-chg l">
                      {(lists.length > 0 || chg.length === 0) && (
                        <div className="na-chgline">
                          {lists.map((k) => (
                            <span key={k} className={`na-list ${k}`}>{LIST_LABEL[k] ?? k}</span>
                          ))}
                          {chg.length === 0 && (
                            <span className="na-new">
                              <span className="na-newdot" aria-hidden="true" />New
                            </span>
                          )}
                        </div>
                      )}
                      {chg.map((c, i) => (
                        <div className="na-chgrow" key={i}>
                          <span className="na-chgk">{c.k}</span>
                          <span className="na-chip">{c.o}</span>
                          <span className="na-arr">→</span>
                          <span className={`na-chip n ${c.dir}`}>{c.n}</span>
                        </div>
                      ))}
                    </td>
                    <td className="tk">
                      <button className="sym" type="button" onClick={() => onOpen(s)}>
                        {s.t}
                      </button>
                      <div className="co">{s.n || ""}</div>
                    </td>
                    <td className="num">{fmtPx(s.px)}</td>
                    <td className="l">
                      <span className={`pill ${consClass(s.con)}`}>{consLabel(s.con)}</span>
                      <div className="dist">{s.b}·{s.h}·{s.s}</div>
                    </td>
                    <td>
                      <UpBar up={s.up} />
                    </td>
                    <td>
                      <Chip v={s.ss} max={10} />
                    </td>
                    <td>
                      {s.ai == null ? (
                        <span className="dash">—</span>
                      ) : (
                        <span className="na-ai" style={{ color: scoreColor(s.ai, 100)! }}>
                          {s.ai}
                          {s.air ? <small>{s.air}</small> : null}
                        </span>
                      )}
                    </td>
                    <td className="num">{fmtMc(s.mc)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
