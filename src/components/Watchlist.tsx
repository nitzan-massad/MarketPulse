import type { User } from "firebase/auth";
import stocksData from "../data/stocks.json";
import type { Stock } from "../types";
import { consClass, consLabel, fmtMc, fmtPx, scoreColor } from "../lib";
import { Chip, UpBar } from "./StockTable";

const STOCKS = stocksData as Stock[];

interface WatchlistProps {
  watchlist: string[];
  onToggle: (t: string) => void;
  onOpen: (s: Stock) => void;
  user: User | null;
  syncReady: boolean;
  onSignInClick: () => void;
}

export default function Watchlist({
  watchlist,
  onToggle,
  onOpen,
  user,
  syncReady,
  onSignInClick,
}: WatchlistProps) {
  const rows = STOCKS.filter((s) => watchlist.includes(s.t));
  // tracked tickers that have dropped out of the ranked universe
  const missing = watchlist.filter((t) => !STOCKS.some((s) => s.t === t));

  return (
    <div className="bob">
      <header className="bob-masthead">
        <div className="bob-eyebrow">Tracking · {watchlist.length}</div>
        <h2 className="bob-title">
          Watch<span className="em">list</span>
        </h2>
        <div className="wl-sync">
          {!syncReady ? (
            <span className="wl-syncnote">This device only — cloud sync isn't set up yet.</span>
          ) : user ? (
            <span className="wl-syncnote">
              <span className="wl-dot" aria-hidden="true" /> Synced as{" "}
              <b>{user.email ?? user.displayName ?? "your account"}</b>
            </span>
          ) : (
            <span className="wl-syncnote">
              Track stocks across your devices —
              <button type="button" className="wl-authbtn primary" onClick={onSignInClick}>
                Sign in to sync
              </button>
            </span>
          )}
        </div>
      </header>

      {watchlist.length === 0 ? (
        <div className="bob-empty">
          No tracked stocks yet. Tap the ☆ on any row — or in a stock's detail view — to track it.
        </div>
      ) : (
        <div className="na-wrap">
          <table className="na-table">
            <thead>
              <tr>
                <th className="l" aria-label="Tracked" />
                <th className="l">Ticker / Company</th>
                <th>Price</th>
                <th>Upside</th>
                <th className="l">Consensus</th>
                <th>Smart Score</th>
                <th>AI Score</th>
                <th>Mkt Cap</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.t} className="row-open" onClick={() => onOpen(s)}>
                  <td className="wl-starcell">
                    <button
                      className="wl-star on"
                      type="button"
                      title="Untrack"
                      aria-label={`Untrack ${s.t}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(s.t);
                      }}
                    >
                      ★
                    </button>
                  </td>
                  <td className="tk">
                    <button className="sym" type="button">{s.t}</button>
                    <div className="co">{s.n || ""}</div>
                  </td>
                  <td className="num">{fmtPx(s.px)}</td>
                  <td>
                    <UpBar up={s.up} />
                  </td>
                  <td className="l">
                    <span className={`pill ${consClass(s.con)}`}>{consLabel(s.con)}</span>
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
              {missing.map((t) => (
                <tr key={t}>
                  <td className="wl-starcell">
                    <button
                      className="wl-star on"
                      type="button"
                      title="Untrack"
                      aria-label={`Untrack ${t}`}
                      onClick={() => onToggle(t)}
                    >
                      ★
                    </button>
                  </td>
                  <td className="tk">
                    <span className="sym">{t}</span>
                    <div className="co" style={{ color: "var(--faint)" }}>
                      not in the current ranked universe
                    </div>
                  </td>
                  <td className="num">—</td>
                  <td>—</td>
                  <td className="l">—</td>
                  <td>—</td>
                  <td>—</td>
                  <td className="num">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
