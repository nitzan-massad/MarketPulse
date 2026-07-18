import type { User } from "firebase/auth";
import stocksData from "../data/stocks.json";
import type { Stock } from "../types";
import { consClass, consLabel, fmtMc, fmtPx, scoreColor } from "../lib";
import { Chip, UpBar } from "./StockTable";
import type { Mark, MarkEntry } from "../watchlist";
import ThumbMark from "./ThumbMark";

const STOCKS = stocksData as Stock[];

interface WatchlistProps {
  watchlist: string[];
  onToggle: (t: string) => void;
  onOpen: (s: Stock, list?: Stock[]) => void;
  user: User | null;
  syncReady: boolean;
  onSignInClick: () => void;
  marks: Record<string, MarkEntry>;
  onMark: (t: string, v: Mark) => void;
}

export default function Watchlist({
  watchlist,
  onToggle,
  onOpen,
  user,
  syncReady,
  onSignInClick,
  marks,
  onMark,
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
          No tracked stocks yet. Tap the ☆ on any stock — in the table or its detail view — to track it.
        </div>
      ) : (
        <div className="wl-wrap">
          <table className="wl-table">
            <colgroup>
              <col style={{ width: "42px" }} />
              <col style={{ width: "150px" }} />
              <col style={{ width: "96px" }} />
              <col style={{ width: "92px" }} />
              <col style={{ width: "136px" }} />
              <col style={{ width: "104px" }} />
              <col style={{ width: "100px" }} />
              <col style={{ width: "104px" }} />
            </colgroup>
            <thead>
              <tr>
                <th aria-label="Tracked" />
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
                <tr key={s.t} className="row-open" onClick={() => onOpen(s, rows)}>
                  <td className="wl-st">
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
                    <span className="tk-top">
                      <button className={`sym ${marks[s.t]?.v === "up" ? "mk-up" : marks[s.t]?.v === "down" ? "mk-down" : ""}`} type="button">{s.t}</button>
                      <ThumbMark mark={marks[s.t]} onMark={(v) => onMark(s.t, v)} />
                    </span>
                    <div className="co">{s.n || ""}</div>
                  </td>
                  <td className="num">{fmtPx(s.px)}</td>
                  <td className="num">
                    <UpBar up={s.up} />
                  </td>
                  <td className="l">
                    <span className={`pill ${consClass(s.con)}`}>{consLabel(s.con)}</span>
                  </td>
                  <td className="ctr">
                    <Chip v={s.ss} max={10} />
                  </td>
                  <td className="num">
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
          {missing.length > 0 && (
            <div className="wl-missing">
              <span>Also tracking (not in the current ranked list):</span>
              {missing.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="wl-misschip"
                  title={`Untrack ${t}`}
                  onClick={() => onToggle(t)}
                >
                  {t} ✕
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
