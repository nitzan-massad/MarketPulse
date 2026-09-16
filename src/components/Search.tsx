import { useEffect, useId, useMemo, useRef, useState } from "react";
import stocksData from "../data/stocks.json";
import type { Stock } from "../types";
import { consClass, consLabel, fmtPx } from "../lib";
import { buildOptions, nextIndex, type SearchOption } from "../searchNav";

const STOCKS = stocksData as Stock[];

interface SearchProps {
  onOpen: (s: Stock, list?: Stock[]) => void;
  onOpenTicker: (ticker: string) => void; // off-universe ticker -> partial modal
  /** Changing this clears the query — the app uses the current view, so moving page
   *  discards the search while merely dismissing it does not. */
  resetKey?: unknown;
}

export default function Search({ onOpen, onOpenTicker, resetKey }: SearchProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<{ t: string; n: string }[]>([]); // Finnhub name/ticker lookups off the ranked set
  const [active, setActive] = useState(-1); // -1 = nothing highlighted
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Dismissing keeps the query, so reopening resumes where you left off. Only acting on a
  // result, changing view, or a reload discards it.
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const clear = () => {
    setQ("");
    setActive(-1);
    inputRef.current?.focus();
  };

  // moving page throws the search away
  useEffect(() => {
    setQ("");
    setActive(-1);
    setOpen(false);
  }, [resetKey]);

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

  // the three result sources as ONE list, in render order, so the arrow keys address the
  // row the user is actually looking at
  const options = useMemo(
    () => buildOptions(results, remote, offUniverse ? upper : null),
    [results, remote, offUniverse, upper],
  );

  // A new query invalidates the highlight — otherwise Enter would open whatever happened
  // to sit at that index in the previous result set.
  useEffect(() => setActive(-1), [query]);

  // keep the highlighted row on screen when arrowing past the visible edge
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelectorAll<HTMLElement>(".search-res")[active]
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (o: SearchOption) => {
    if (o.kind === "stock") onOpen(o.stock, results);
    else onOpenTicker(o.ticker);
    setQ(""); // acting on a result is not a dismissal — start clean next time
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!options.length) return;
      e.preventDefault(); // stop the caret jumping to either end of the input
      setActive((i) => nextIndex(i, options.length, e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Enter") {
      // Enter with nothing highlighted takes the first row, which is what it did before
      // arrow keys existed — typing and hitting Enter still opens the best match.
      const o = active >= 0 ? options[active] : options[0];
      if (o) choose(o);
    }
  };
  const optionId = (i: number) => `${listId}-opt-${i}`;

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
              role="combobox"
              aria-expanded={!!query}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            />
            <button
              className="search-x"
              type="button"
              aria-label={q ? "Clear search" : "Close search"}
              onClick={q ? clear : close}
            >
              &times;
            </button>
          </div>

          {query && (
            <div className="search-results" role="listbox" id={listId} ref={listRef}>
              {/* Rendered straight from `options`, so a row's position here IS the index
                  the arrow keys produce — the two cannot drift apart. */}
              {options.map((o, i) => {
                const on = i === active;
                const cls = `search-res${o.kind === "ticker" ? " off" : ""}${on ? " on" : ""}`;
                const common = {
                  key: o.key,
                  id: optionId(i),
                  type: "button" as const,
                  className: cls,
                  role: "option",
                  "aria-selected": on,
                  // hovering moves the highlight so mouse and keyboard never disagree
                  onMouseEnter: () => setActive(i),
                  onClick: () => choose(o),
                };
                if (o.kind === "stock") {
                  const s2 = o.stock;
                  return (
                    <button {...common}>
                      <span className="search-tk">{s2.t}</span>
                      <span className="search-co">{s2.n}</span>
                      <span className={`search-con ${consClass(s2.con)}`}>{consLabel(s2.con)}</span>
                      <span className="search-px">{fmtPx(s2.px)}</span>
                    </button>
                  );
                }
                const hit = remote.find((r) => r.t === o.ticker);
                return (
                  <button {...common}>
                    <span className="search-tk">{o.ticker}</span>
                    <span className="search-co">
                      {hit
                        ? hit.n
                          ? `${hit.n} · not in the ranked set`
                          : "not in the ranked set"
                        : "Open — limited data (not in the ranked set)"}
                    </span>
                  </button>
                );
              })}
              {options.length === 0 && (
                <div className="search-empty">No matches. Try a ticker (NVDA) or company name (Apple).</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
