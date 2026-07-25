import { useEffect, useMemo, useRef, useState } from "react";
import stocksData from "../data/stocks.json";
import type { Stock } from "../types";
import { consClass, consLabel, fmtPx } from "../lib";

const STOCKS = stocksData as Stock[];

interface SearchProps {
  onOpen: (s: Stock, list?: Stock[]) => void;
  onOpenTicker: (ticker: string) => void; // off-universe ticker -> partial modal
}

export default function Search({ onOpen, onOpenTicker }: SearchProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<{ t: string; n: string }[]>([]); // Finnhub name/ticker lookups off the ranked set
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setQ("");
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const query = q.trim();
  const results = useMemo(() => {
    if (!query) return [];
    const lc = query.toLowerCase();
    return STOCKS.filter((s) => s.t.toLowerCase().includes(lc) || (s.n || "").toLowerCase().includes(lc))
      .sort((a, b) => {
        // exact/prefix ticker matches first
        const ap = a.t.toLowerCase().startsWith(lc) ? 0 : 1;
        const bp = b.t.toLowerCase().startsWith(lc) ? 0 : 1;
        return ap - bp;
      })
      .slice(0, 7);
  }, [query]);

  const upper = query.toUpperCase();
  const exact = STOCKS.some((s) => s.t === upper);
  const offUniverse = query.length > 0 && /^[A-Za-z.]{1,6}$/.test(query) && !exact;

  // Resolve company names / off-set tickers via Finnhub symbol lookup (same key +
  // CORS-enabled host we already use for quotes). Lets "apple" -> AAPL even when the
  // stock isn't in the ranked set. Debounced; skipped without a key (offline falls
  // back to the raw-ticker guess below).
  useEffect(() => {
    const key = localStorage.getItem("mp_finnhub") || import.meta.env.VITE_FINNHUB_KEY || "";
    if (!open || query.length < 2 || !key) {
      setRemote([]);
      return;
    }
    const ctrl = new AbortController();
    const id = window.setTimeout(async () => {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${key}`,
          { signal: ctrl.signal },
        );
        if (!r.ok) return;
        const j = await r.json();
        const inSet = new Set(STOCKS.map((s) => s.t));
        const rows = (j.result || [])
          .filter((x: { symbol?: string }) => x.symbol && !x.symbol.includes(".") && !inSet.has(x.symbol))
          .slice(0, 5)
          .map((x: { symbol: string; description?: string }) => ({ t: x.symbol, n: x.description || "" }));
        setRemote(rows);
      } catch {
        /* aborted / offline -> no remote matches */
      }
    }, 250);
    return () => {
      window.clearTimeout(id);
      ctrl.abort();
    };
  }, [query, open]);

  const pick = (s: Stock) => {
    onOpen(s, results);
    close();
  };
  const pickTicker = (t: string) => {
    onOpenTicker(t);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (results[0]) pick(results[0]);
    else if (remote[0]) pickTicker(remote[0].t);
    else if (offUniverse) pickTicker(upper);
  };

  return (
    <div className="hdr-search" ref={rootRef}>
      {!open ? (
        <button className="search-ico" type="button" aria-label="Search stocks" onClick={() => setOpen(true)}>
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.6-3.6" />
          </svg>
        </button>
      ) : (
        <div className="search-open">
          <div className="search-field">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.6-3.6" />
            </svg>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search ticker or company…"
              aria-label="Search ticker or company"
            />
            <button className="search-x" type="button" aria-label="Close search" onClick={close}>
              &times;
            </button>
          </div>

          {query && (
            <div className="search-results" role="listbox">
              {results.map((s) => (
                <button key={s.t} type="button" className="search-res" role="option" onClick={() => pick(s)}>
                  <span className="search-tk">{s.t}</span>
                  <span className="search-co">{s.n}</span>
                  <span className={`search-con ${consClass(s.con)}`}>{consLabel(s.con)}</span>
                  <span className="search-px">{fmtPx(s.px)}</span>
                </button>
              ))}
              {remote.map((s) => (
                <button key={s.t} type="button" className="search-res off" role="option" onClick={() => pickTicker(s.t)}>
                  <span className="search-tk">{s.t}</span>
                  <span className="search-co">{s.n ? `${s.n} · not in the ranked set` : "not in the ranked set"}</span>
                </button>
              ))}
              {offUniverse && !remote.length && (
                <button type="button" className="search-res off" role="option" onClick={() => pickTicker(upper)}>
                  <span className="search-tk">{upper}</span>
                  <span className="search-co">Open — limited data (not in the ranked set)</span>
                </button>
              )}
              {results.length === 0 && remote.length === 0 && !offUniverse && (
                <div className="search-empty">No matches. Try a ticker (NVDA) or company name (Apple).</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
