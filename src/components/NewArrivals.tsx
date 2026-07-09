import { useMemo } from "react";
import stocksData from "../data/stocks.json";
import type { Stock } from "../types";
import { addedInfo, agoLabel, consClass, consLabel, fmtMc, fmtPx, NEW_WINDOW_DAYS, scoreColor } from "../lib";
import { Chip, UpBar } from "./StockTable";

const STOCKS = stocksData as Stock[];

const fmtDate = (iso: string): string =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

// AI "top 10%" = 90th percentile of AI scores across the universe (same cut the
// Best of the Best view uses).
const AI_TOP = (() => {
  const ai = STOCKS.map((r) => r.ai).filter((x): x is number => x != null).sort((a, b) => a - b);
  return ai.length ? ai[Math.ceil(0.9 * ai.length) - 1] : Infinity;
})();

// which curated buckets a name currently qualifies for (falls back to the base
// Analyst universe it entered).
function bucketsFor(s: Stock): { label: string; cls: string }[] {
  const out: { label: string; cls: string }[] = [];
  if ((s.con || "").toLowerCase() === "strongbuy") out.push({ label: "Strong Buy", cls: "sb" });
  if (s.ss === 10) out.push({ label: "SS 10", cls: "ss10" });
  if (s.ai != null && s.ai >= AI_TOP) out.push({ label: "AI top", cls: "aitop" });
  if (out.length === 0) out.push({ label: "Analyst", cls: "base" });
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
          newest first.
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
                <th className="l">Ticker / Company</th>
                <th className="l">Lists</th>
                <th>Price</th>
                <th className="l">Consensus</th>
                <th>Upside</th>
                <th>Smart Score</th>
                <th>AI Score</th>
                <th>Mkt Cap</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ s, info }) => (
                <tr key={s.t}>
                  <td className="na-added">
                    <span className="na-ago">{agoLabel(info.daysAgo)}</span>
                    <span className="na-date">{fmtDate(info.date)}</span>
                  </td>
                  <td className="tk">
                    <button className="sym" type="button" onClick={() => onOpen(s)}>
                      {s.t}
                    </button>
                    <div className="co">{s.n || ""}</div>
                  </td>
                  <td className="l">
                    <div className="na-tags">
                      {bucketsFor(s).map((b) => (
                        <span key={b.label} className={`na-tag ${b.cls}`}>{b.label}</span>
                      ))}
                    </div>
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
