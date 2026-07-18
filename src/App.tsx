import { useCallback, useEffect, useMemo, useState } from "react";
import BestOfBest from "./components/BestOfBest";
import NewArrivals from "./components/NewArrivals";
import Masthead from "./components/Masthead";
import NavMenu, { type NavId } from "./components/NavMenu";
import Search from "./components/Search";
import SignInModal from "./components/SignInModal";
import StockModal from "./components/StockModal";
import StockTable from "./components/StockTable";
import Toolbar from "./components/Toolbar";
import Watchlist from "./components/Watchlist";
import stocksData from "./data/stocks.json";
import { passes, sortRows, VIEWS } from "./lib";
import type { Stock, ViewId } from "./types";
import { useLiveQuotes } from "./useLiveQuotes";
import { useWatchlist, type Mark } from "./watchlist";
import { useSavedFilters, type SavedFilters } from "./savedFilters";
import { initAnalytics, track, trackUser } from "./analytics";

export type MarkFilter = "all" | "up" | "down" | "reviewed" | "unseen";

const STOCKS = stocksData as Stock[];
// Baked-in Finnhub key (injected at build from the FINNHUB_KEY Actions secret),
// so live Day% works for everyone with no key entry. localStorage can override.
const BAKED_KEY = import.meta.env.VITE_FINNHUB_KEY ?? "";

// map a legacy single-select consensus bucket to the new discrete-rating list
function bucketToList(b: string | undefined): string[] {
  switch (b) {
    case "StrongBuy": return ["StrongBuy"];
    case "buyplus": return ["StrongBuy", "Buy"];
    case "Hold": return ["Neutral"];
    default: return []; // sellany / "" / undefined -> all
  }
}

export default function App() {
  const [nav, setNav] = useState<NavId>("table");
  const [view, setView] = useState<ViewId>("analyst");
  const [sort, setSort] = useState<keyof Stock>("up");
  const [dir, setDir] = useState<number>(-1);
  const [q, setQ] = useState("");
  const [sectors, setSectors] = useState<string[]>([]);
  const [sectorNot, setSectorNot] = useState(false);
  // analyst tab defaults to Strong Buy to match the real page
  const [consensuses, setConsensuses] = useState<string[]>(["StrongBuy"]);
  const [cap, setCap] = useState(0);
  const [openStock, setOpenStock] = useState<Stock | null>(null);
  // the list the modal was opened from, so ‹ › can page prev/next in place
  const [openList, setOpenList] = useState<Stock[]>([]);
  const { list: watchlist, toggle: toggleTrack, marks, toggleMark, user, authReady, signIn, signOut, ready: syncReady } = useWatchlist();
  const [signInOpen, setSignInOpen] = useState(false);
  const [pendingTrack, setPendingTrack] = useState<string | null>(null);
  const [pendingMark, setPendingMark] = useState<{ ticker: string; v: Mark } | null>(null);
  const [markFilter, setMarkFilter] = useState<MarkFilter>("all");

  // usage analytics (Firebase/GA4): init once, then attribute events to the
  // signed-in user when available
  useEffect(() => {
    if (import.meta.env.PROD) void initAnalytics(); // don't pollute GA with local dev
  }, []);
  useEffect(() => {
    trackUser(user?.uid ?? null);
  }, [user]);

  function handleOpen(s: Stock, list: Stock[] = []) {
    track("open_stock", { ticker: s.t, section: nav });
    setOpenStock(s);
    setOpenList(list);
  }
  function handleNav(id: NavId) {
    track("select_section", { section: id });
    setNav(id);
  }
  // off-universe ticker from search -> synthetic stock; the modal shows live
  // price/chart and marks the TipRanks metrics as unavailable
  function handleOpenTicker(ticker: string) {
    track("search_open_ticker", { ticker });
    setOpenList([]); // off-universe search result has no sibling list to page
    setOpenStock({
      t: ticker, n: "", sec: "", px: null, chg: null, pt: null, up: null, con: "",
      b: 0, h: 0, s: 0, ss: null, ai: null, air: null, aipt: null, mc: null, desc: null,
    });
  }

  // Tracking requires an account (when sync is configured): a signed-out ★
  // opens the sign-in modal and remembers the ticker to add on sign-in.
  function requestToggle(ticker: string) {
    if (syncReady && user) {
      track(watchlist.includes(ticker) ? "untrack_ticker" : "track_ticker", { ticker });
    }
    if (syncReady && !user) {
      setPendingTrack(ticker);
      setSignInOpen(true);
      return;
    }
    toggleTrack(ticker);
  }

  // Thumbs also require an account: a signed-out press opens sign-in and
  // remembers the mark to apply once authenticated.
  function requestMark(ticker: string, v: Mark) {
    if (syncReady && !user) {
      setPendingMark({ ticker, v });
      setSignInOpen(true);
      return;
    }
    track(marks[ticker]?.v === v ? "unmark" : "mark", { ticker, v });
    toggleMark(ticker, v);
  }

  // marks are cleared on sign-out, so drop any mark-based filter too
  useEffect(() => {
    if (!user) setMarkFilter("all");
  }, [user]);
  const [liveKey, setLiveKey] = useState<string | null>(
    () => localStorage.getItem("mp_finnhub") || BAKED_KEY || null,
  );
  const [liveOn, setLiveOn] = useState<boolean>(
    () => Boolean(localStorage.getItem("mp_finnhub") || BAKED_KEY) && localStorage.getItem("mp_live") !== "0",
  );

  const sectorOptions = useMemo(
    () => [...new Set(STOCKS.map((s) => s.sec).filter(Boolean))].sort(),
    [],
  );
  // distinct consensus ratings present in the data, ranked buy→sell
  const consensusOptions = useMemo(() => {
    const order = ["StrongBuy", "Buy", "ModerateBuy", "Neutral", "Hold", "ModerateSell", "Sell", "StrongSell"];
    const rank = (c: string) => (order.indexOf(c) < 0 ? 99 : order.indexOf(c));
    return [...new Set(STOCKS.map((s) => s.con).filter(Boolean) as string[])].sort((a, b) => rank(a) - rank(b));
  }, []);

  const rows = useMemo(() => {
    let filtered = STOCKS.filter((s) => passes(s, { q, sectors, sectorNot, consensuses, cap }));
    if (markFilter !== "all") {
      filtered = filtered.filter((s) => {
        const m = marks[s.t]?.v;
        if (markFilter === "up") return m === "up";
        if (markFilter === "down") return m === "down";
        if (markFilter === "reviewed") return !!m;
        return !m; // "unseen"
      });
    }
    return sortRows(filtered, sort, dir);
  }, [q, sectors, sectorNot, consensuses, cap, sort, dir, markFilter, marks]);

  // "clean" filter state = the view's own default (analyst view starts on Strong Buy)
  const consensusDefault = useMemo(() => (view === "analyst" ? ["StrongBuy"] : []), [view]);
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
  const activeCount =
    (q !== "" ? 1 : 0) +
    (sectors.length ? 1 : 0) +
    (sameSet(consensuses, consensusDefault) ? 0 : 1) +
    (cap !== 0 ? 1 : 0);
  const filtersActive = activeCount > 0;
  function resetFilters() {
    setQ("");
    setSectors([]);
    setSectorNot(false);
    setCap(0);
    setConsensuses(consensusDefault);
  }

  // filters follow the user across sessions/devices (DB when signed in, else
  // localStorage). Restored on load; written on every change.
  const filters = useMemo<SavedFilters>(
    () => ({ q, sectors, sectorNot, consensuses, cap }),
    [q, sectors, sectorNot, consensuses, cap],
  );
  const applyFilters = useCallback((f: SavedFilters) => {
    setQ(f.q ?? "");
    // migrate the older single-select shape (sector / consensus strings)
    setSectors(f.sectors ?? (f.sector ? [f.sector] : []));
    setSectorNot(!!f.sectorNot);
    setConsensuses(f.consensuses ?? bucketToList(f.consensus));
    setCap(f.cap ?? 0);
  }, []);
  useSavedFilters(user, filters, applyFilters);

  const tickers = useMemo(() => rows.map((r) => r.t), [rows]);
  const { live, status: liveStatus } = useLiveQuotes(tickers, liveKey, liveOn);

  function selectView(id: ViewId) {
    const v = VIEWS[id];
    setView(id);
    setSort(v.sort);
    setDir(v.dir);
    setConsensuses(id === "analyst" ? ["StrongBuy"] : []);
  }

  function handleSort(k: string) {
    if (sort === k) {
      setDir((d) => d * -1);
    } else {
      setSort(k as keyof Stock);
      setDir(k === "sec" || k === "con" ? 1 : -1);
    }
  }

  function toggleLive() {
    if (!liveKey || liveStatus === "error") {
      const k = window.prompt("Paste your free Finnhub API key (get one free at finnhub.io):", liveKey ?? "");
      if (k && k.trim()) {
        const key = k.trim();
        localStorage.setItem("mp_finnhub", key);
        localStorage.setItem("mp_live", "1");
        setLiveKey(key);
        setLiveOn(true);
      }
      return;
    }
    const next = !liveOn;
    localStorage.setItem("mp_live", next ? "1" : "0");
    setLiveOn(next);
  }

  return (
    <div className="wrap">
      <header className="sitehead">
        <h1 id="title">Market <span className="em">Pulse</span></h1>
        <div className="site-right">
          <Search onOpen={handleOpen} onOpenTicker={handleOpenTicker} />
          {syncReady && (
            // fixed-width slot reserved up-front so the account control fades in
            // without reflowing the header once auth resolves (~1–2s)
            <div className="acctslot">
              {!authReady && <span className="acct-spin" aria-label="Loading account" role="status" />}
              {authReady &&
                (user ? (
                  <button
                    className="acctchip"
                    type="button"
                    title="Account"
                    aria-label="Account"
                    onClick={() => setSignInOpen(true)}
                  >
                    {user.photoURL ? (
                      <img src={user.photoURL} alt="" referrerPolicy="no-referrer" />
                    ) : (
                      <span className="acctini">
                        {(user.email || user.displayName || "?").slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </button>
                ) : (
                  <button className="acctbtn" type="button" onClick={() => setSignInOpen(true)}>
                    Sign in
                  </button>
                ))}
            </div>
          )}
        </div>
      </header>

      {nav === "table" ? (
        <>
          <Masthead
            poolN={STOCKS.length}
            liveStatus={liveStatus}
            hasKey={!!liveKey}
            onLive={toggleLive}
          />

          <div className="tabs" id="tabs">
            {(Object.entries(VIEWS) as [ViewId, (typeof VIEWS)[ViewId]][]).map(([id, v]) => (
              <button
                key={id}
                className={`tab ${id === view ? "on" : ""}`}
                data-v={id}
                onClick={() => selectView(id)}
              >
                <span>{v.tab}</span>
                <small>{v.sub}</small>
              </button>
            ))}
          </div>

          <Toolbar
            q={q}
            sectors={sectors}
            sectorOptions={sectorOptions}
            sectorNot={sectorNot}
            consensuses={consensuses}
            consensusOptions={consensusOptions}
            cap={cap}
            count={rows.length}
            activeCount={activeCount}
            canReset={filtersActive}
            onReset={resetFilters}
            onQ={setQ}
            onSectors={setSectors}
            onSectorNot={setSectorNot}
            onConsensuses={setConsensuses}
            onCap={setCap}
            markFilter={markFilter}
            onMarkFilter={setMarkFilter}
            showMarkFilter={!!user}
          />

          <StockTable
            rows={rows}
            sort={sort}
            dir={dir}
            hl={VIEWS[view].hl}
            onSort={handleSort}
            live={live}
            onOpen={(s) => handleOpen(s, rows)}
            watchlist={watchlist}
            onToggleTrack={requestToggle}
            marks={marks}
            onMark={requestMark}
          />
        </>
      ) : nav === "best" ? (
        <BestOfBest onOpen={handleOpen} marks={marks} onMark={requestMark} />
      ) : nav === "new" ? (
        <NewArrivals onOpen={handleOpen} marks={marks} onMark={requestMark} />
      ) : (
        <Watchlist
          watchlist={watchlist}
          onToggle={requestToggle}
          onOpen={handleOpen}
          user={user}
          syncReady={syncReady}
          onSignInClick={() => setSignInOpen(true)}
          marks={marks}
          onMark={requestMark}
        />
      )}

      {openStock && (() => {
        const i = openList.findIndex((x) => x.t === openStock.t);
        return (
          <StockModal
            stock={openStock}
            onClose={() => setOpenStock(null)}
            tracked={watchlist.includes(openStock.t)}
            onToggleTrack={() => requestToggle(openStock.t)}
            covered={STOCKS.some((s) => s.t === openStock.t)}
            mark={marks[openStock.t]}
            onMark={(v) => requestMark(openStock.t, v)}
            onPrev={i > 0 ? () => setOpenStock(openList[i - 1]) : undefined}
            onNext={i >= 0 && i < openList.length - 1 ? () => setOpenStock(openList[i + 1]) : undefined}
          />
        );
      })()}

      {signInOpen && syncReady && (
        <SignInModal
          user={user}
          signIn={(id) =>
            signIn(id, pendingTrack ? [pendingTrack] : [], pendingMark ?? undefined).then(() =>
              track("sign_in", { provider: id }),
            )
          }
          signOut={signOut}
          onClose={() => {
            setSignInOpen(false);
            setPendingTrack(null);
            setPendingMark(null);
          }}
        />
      )}

      <NavMenu nav={nav} onNav={handleNav} />
    </div>
  );
}
