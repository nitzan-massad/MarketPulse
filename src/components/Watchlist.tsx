import type { User } from "firebase/auth";
import { useRef, useState } from "react";
import stocksData from "../data/stocks.json";
import type { Stock } from "../types";
import { fmtMc, fmtPx, scoreColor } from "../lib";
import { Chip, ConsPill, UpBar } from "./StockTable";
import type { Mark, MarkEntry } from "../watchlist";
import ThumbMark from "./ThumbMark";

const STOCKS = stocksData as Stock[];
const BY_SYMBOL = new Map(STOCKS.map((s) => [s.t, s]));

interface WatchlistProps {
  watchlist: string[];
  onToggle: (t: string) => void;
  onOpen: (s: Stock, list?: Stock[]) => void;
  user: User | null;
  syncReady: boolean;
  onSignInClick: () => void;
  marks: Record<string, MarkEntry>;
  onMark: (t: string, v: Mark) => void;
  onReorder: (from: number, to: number) => void;
}

// Drag-to-reorder on the grip handle.
//
// Pointer Events, not HTML5 drag-and-drop: `draggable` produces no dragstart on iOS or
// Android, and this app is used from a phone (PWA manifest, apple-touch-icon, the whole
// point of the cross-device sync). Pointer Events cover mouse, touch and pen from one
// code path, and cost ~30 lines against a dependency.
//
// ponytail: no auto-scroll while dragging near the viewport edge — the watchlist is a
// handful of rows and fits on screen. Add an edge-scroll timer here if long lists appear.
interface DragState {
  from: number;
  to: number;
  dy: number;
}

function useRowDrag(count: number, onReorder: (from: number, to: number) => void) {
  const rows = useRef<(HTMLTableRowElement | null)[]>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const startY = useRef(0);
  // The live drag, mirrored outside state. The handlers below must read the CURRENT drag
  // synchronously without a setState updater: React runs updater functions during render,
  // so calling onReorder (which setStates in App) from inside one is a
  // "Cannot update a component while rendering a different component" violation.
  const dragRef = useRef<DragState | null>(null);
  const put = (d: DragState | null): void => {
    dragRef.current = d;
    setDrag(d);
  };

  // Where the pointer currently sits, as an index in the list WITHOUT the dragged row —
  // which is exactly the destination index planMove/moveItem expect.
  const targetFor = (from: number, y: number): number => {
    let ins = 0;
    rows.current.forEach((el, i) => {
      if (!el || i === from) return;
      const r = el.getBoundingClientRect();
      if (r.top + r.height / 2 < y) ins++;
    });
    return ins;
  };

  const onPointerDown = (from: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation(); // the row itself opens the stock modal on click
    // Capture, so a fast drag that outruns the pointer keeps sending us the moves.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable — the drag still works, it just ends if the pointer leaves */
    }
    startY.current = e.clientY;
    put({ from, to: from, dy: 0 });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    if (!d) return;
    put({ ...d, dy: e.clientY - startY.current, to: targetFor(d.from, e.clientY) });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    put(null);
    if (d && d.to !== d.from) onReorder(d.from, d.to);
  };
  // Arrow keys on the grip do the same job for anyone not using a pointer. Rows are keyed
  // by ticker, so the DOM node — and the focus on this grip — travels with the row.
  const onKeyDown = (from: number) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const to = e.key === "ArrowUp" ? from - 1 : e.key === "ArrowDown" ? from + 1 : null;
    if (to == null) return;
    e.preventDefault();
    e.stopPropagation();
    if (to >= 0 && to < count) onReorder(from, to);
  };

  return { rows, drag, onPointerDown, onPointerMove, onPointerUp, onKeyDown };
}

const GripIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
    <circle cx="6" cy="3" r="1.4" /><circle cx="10" cy="3" r="1.4" />
    <circle cx="6" cy="8" r="1.4" /><circle cx="10" cy="8" r="1.4" />
    <circle cx="6" cy="13" r="1.4" /><circle cx="10" cy="13" r="1.4" />
  </svg>
);

export default function Watchlist({
  watchlist,
  onToggle,
  onOpen,
  user,
  syncReady,
  onSignInClick,
  marks,
  onMark,
  onReorder,
}: WatchlistProps) {
  // Follow the WATCHLIST's order, not the snapshot's. Filtering STOCKS inherited its row
  // order — upside rank, then smart-score rank, then market-cap rank — so the list silently
  // reshuffled every 5h when CI rewrote stocks.json. Order now means: oldest star first,
  // newest last, and whatever dragging says. See watchlistOrder.ts.
  const rows = watchlist.map((t) => BY_SYMBOL.get(t)).filter((s): s is Stock => s != null);
  // tracked tickers that have dropped out of the ranked universe
  const missing = watchlist.filter((t) => !BY_SYMBOL.has(t));
  const { rows: rowEls, drag, onPointerDown, onPointerMove, onPointerUp, onKeyDown } =
    useRowDrag(rows.length, onReorder);

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
              <col style={{ width: "30px" }} />
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
                <th aria-label="Reorder" />
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
              {rows.map((s, i) => (
                <tr
                  key={s.t}
                  ref={(el) => { rowEls.current[i] = el; }}
                  className={
                    "row-open" +
                    (drag?.from === i ? " wl-dragging" : "") +
                    (drag && drag.from !== i && drag.to === i ? (drag.to < drag.from ? " wl-dropabove" : " wl-dropbelow") : "")
                  }
                  style={drag?.from === i ? { transform: `translateY(${drag.dy}px)` } : undefined}
                  onClick={() => onOpen(s, rows)}
                >
                  <td className="wl-gripcell">
                    <button
                      type="button"
                      className="wl-grip"
                      aria-label={`Reorder ${s.t} — position ${i + 1} of ${rows.length}. Arrow keys move it.`}
                      onPointerDown={onPointerDown(i)}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={onPointerUp}
                      onKeyDown={onKeyDown(i)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <GripIcon />
                    </button>
                  </td>
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
                    <div className="tk-inner">
                      <div className="tk-main">
                        <span className="tk-top">
                          <button className={`sym ${marks[s.t]?.v === "up" ? "mk-up" : marks[s.t]?.v === "down" ? "mk-down" : ""}`} type="button">{s.t}</button>
                        </span>
                        <div className="co">{s.n || ""}</div>
                      </div>
                      <ThumbMark mark={marks[s.t]} onMark={(v) => onMark(s.t, v)} />
                    </div>
                  </td>
                  <td className="num">{fmtPx(s.px)}</td>
                  <td className="num">
                    <UpBar up={s.up} />
                  </td>
                  <td className="l">
                    <ConsPill con={s.con} />
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
          <p className="wl-hint">
            Newest star sits at the bottom. Drag <span aria-hidden="true">⠿</span> to reorder —
            the order syncs to your other devices.
          </p>
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
