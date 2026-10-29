import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import BestOfBest from "./components/BestOfBest";
import NewArrivals from "./components/NewArrivals";
import Masthead from "./components/Masthead";
import NavMenu, { type NavId } from "./components/NavMenu";
import FearGreedGauge from "./components/FearGreedGauge";
import NotificationBell from "./components/NotificationBell";
import Search from "./components/Search";
import StockTable from "./components/StockTable";
import Toolbar from "./components/Toolbar";
import Watchlist from "./components/Watchlist";
import { flagOn } from "./featureFlags";
import { passes, sortRows, stubStock, themeNames, VIEWS } from "./lib";
import { currentStocks, stocksLoaded, stocksReady, useStocks } from "./stocks";
import { parseShareHash, type PanelId, type TickerView } from "./share";
import type { Stock, ViewId } from "./types";
import { useLiveQuotes } from "./useLiveQuotes";
import { WORKER_URL } from "./workerUrl";
import { LiveCtx } from "./LivePx";
import { useNotifications, type Notification } from "./useNotifications";
import { useReviewAlerts } from "./useReviewAlerts";
import { loadFirebase, noteView, requestTracking, useWatchlist, type Mark } from "./watchlist";
import { useSavedFilters, type SavedFilters } from "./savedFilters";
import { initAnalytics, track, trackUser } from "./analytics";

export type MarkFilter = "all" | "up" | "down" | "reviewed" | "unseen";
/** Whitelist for the persisted value — a stale or hand-edited record must not set a
 *  filter the toolbar has no button for, which would hide rows with no way to clear it. */
const MARK_FILTERS: MarkFilter[] = ["all", "up", "down", "reviewed", "unseen"];

// Baked-in Finnhub key (injected at build from the FINNHUB_KEY Actions secret) — only the
// FALLBACK live source now (CNBC is primary and keyless).
const LIVE_KEY = import.meta.env.VITE_FINNHUB_KEY || null;
// Belt-and-braces: the NavMenu item is already gated behind the same flag, but this keeps
// the feed unreachable even if something else ever sets `nav` to "feed" directly.
const FEED_ON = flagOn("feed");

// Opened on demand, so kept out of the main chunk: the modal (chart, forecasts, P/E), the feed
// (posts.json) and sign-in. Each fetches its chunk on first open; fallback={null} because the
// overlay simply appears a beat later — nothing is underneath to hold a spinner.
const StockModal = lazy(() => import("./components/StockModal"));
const PostFeed = lazy(() => import("./components/PostFeed").then((m) => ({ default: m.PostFeed })));
const SignInModal = lazy(() => import("./components/SignInModal"));

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
  // bundled stocks.json + not-yet-bundled tracked rows (pop in after the RTDB read, see stocks.ts)
  const STOCKS = useStocks();
  // The section survives a refresh (per tab, like the browser's own scroll restore); a new tab
  // or a shared link still starts on the table.
  const [nav, setNav] = useState<NavId>(() => {
    try {
      const v = sessionStorage.getItem("mp_nav");
      return v === "best" || v === "new" || v === "watch" || v === "feed" ? v : "table";
    } catch {
      return "table";
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem("mp_nav", nav);
    } catch {
      /* ignore */
    }
  }, [nav]);
  const [view, setView] = useState<ViewId>("analyst");
  const [sort, setSort] = useState<keyof Stock>("up");
  const [dir, setDir] = useState<number>(-1);
  const [q, setQ] = useState("");
  const [sectors, setSectors] = useState<string[]>([]);
  const [sectorNot, setSectorNot] = useState(false);
  // analyst tab defaults to Strong Buy to match the real page
  const [consensuses, setConsensuses] = useState<string[]>(["StrongBuy"]);
  const [cap, setCap] = useState(0);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [openStock, setOpenStock] = useState<Stock | null>(null);
  const [fcHighlight, setFcHighlight] = useState<string[] | null>(null);
  const [bellReturn, setBellReturn] = useState(false); // stock opened from the bell → closing it goes back there
  const [bellReopen, setBellReopen] = useState(0);
  const [openView, setOpenView] = useState<TickerView | null>(null); // a view a link opens over the modal (#TSM/pe) // review keys to glow when opened from a notification
  // the list the modal was opened from, so ‹ › can page prev/next in place
  const [openList, setOpenList] = useState<Stock[]>([]);
  const { list: watchlist, toggle: toggleTrack, reorder: reorderWatchlist, marks, toggleMark, user, authReady, signIn, signOut, ready: syncReady } = useWatchlist();
  const [signInOpen, setSignInOpen] = useState(false);
  const [pendingTrack, setPendingTrack] = useState<string | null>(null);
  const [pendingMark, setPendingMark] = useState<{ ticker: string; v: Mark } | null>(null);
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  const [confirmTicker, setConfirmTicker] = useState<string | null>(null); // "We're on it" sheet
  const [markFilter, setMarkFilter] = useState<MarkFilter>("all");

  // usage analytics (Firebase/GA4): init once, then attribute events to the
  // signed-in user when available
  useEffect(() => {
    loadFirebase(); // first effect = after the first render: only now fetch the Firebase SDK
    if (import.meta.env.PROD) void initAnalytics(); // don't pollute GA with local dev
  }, []);
  useEffect(() => {
    trackUser(user?.uid ?? null);
  }, [user]);

  // every stock view: GA4 event + the RTDB "last viewed" stamp that keeps the stock from expiring
  function logOpen(ticker: string, extra?: Record<string, unknown>) {
    track("open_stock", { ticker, section: nav, ...extra });
    noteView(ticker);
  }
  // An off-universe ticker opened as a stub (handleOpenTicker) becomes its real row the moment
  // "Track this stock" publishes it, so the open window fills in without a reload.
  useEffect(() => {
    if (!openStock || openStock.n !== "") return; // stubs only: stubStock's n is ""
    const real = STOCKS.find((s) => s.t === openStock.t);
    if (!real) return;
    setOpenStock(real);
    setOpenList((l) => l.map((s) => (s.t === real.t ? real : s)));
  }, [STOCKS, openStock]);

  function handleOpen(s: Stock, list: Stock[] = []) {
    logOpen(s.t);
    setOpenStock(s);
    // StockModal draws one slide per list entry, so [] opens it blank (see openPostTicker)
    setOpenList(list.length ? list : [s]);
    setFcHighlight(null);
  }
  /* Feed -> stock modal. A post can outlive its row: posts.json keeps 200 entries while the
     screener universe turns over, so a ticker may no longer be in STOCKS. Fall back to the
     same synthetic-row path search uses for an off-universe ticker rather than doing nothing. */
  function openPostTicker(ticker: string) {
    // A ONE-ITEM list, not an empty one. StockModal renders a swipe track with one slide per
    // entry (see its `list` prop), so [] gives it nothing to draw and the modal opens blank —
    // which is exactly the bug this line used to have. [hit] gives it the one slide it needs
    // while leaving nowhere to page to, which is the "no swiping between stocks from a post"
    // behaviour we actually want: from the table you are browsing a ranked set and paging makes
    // sense; from a post you came for THAT company.
    const hit = STOCKS.find((s) => s.t === ticker);
    if (hit) handleOpen(hit, [hit]);
    else handleOpenTicker(ticker);
  }
  function handleNav(id: NavId) {
    track("select_section", { section: id });
    setNav(id);
  }
  // off-universe ticker from search -> synthetic stock; the modal shows live
  // price/chart and marks the TipRanks metrics as unavailable
  function handleOpenTicker(ticker: string) {
    logOpen(ticker, { off_universe: true });
    const s = stubStock(ticker);
    // ONE-ITEM list, not [] — StockModal draws one slide per list entry, so [] opened it blank
    // (same trap as openPostTicker above). [s] gives it its slide and nowhere to page to.
    setOpenList([s]);
    setFcHighlight(null);
    setOpenStock(s);
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

  // "Track this stock": request + star. Signed out => sign in first, then both happen on
  // their own (the star via signIn's pending list, the request in the effect below).
  function requestTrackStock(ticker: string) {
    if (!user) {
      setPendingTrack(ticker);
      setPendingRequest(ticker);
      setSignInOpen(true);
      return;
    }
    track("request_track", { ticker });
    requestTracking(ticker, user);
    setConfirmTicker(ticker);
    // star after the sheet has slid in: the watchlist re-render is what made it stutter
    if (!watchlist.includes(ticker)) setTimeout(() => toggleTrack(ticker), 550);
  }
  useEffect(() => {
    if (!user || !pendingRequest) return;
    track("request_track", { ticker: pendingRequest });
    requestTracking(pendingRequest, user);
    setConfirmTicker(pendingRequest);
    setPendingRequest(null);
  }, [user, pendingRequest]);

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

  // Marks are cleared on sign-out, so drop any mark-based filter too — but only once
  // auth has actually resolved. `user` is null for a moment on every load while it does,
  // and firing then reset the filter the saved record had just restored, which the save
  // effect then wrote back as "all". That is why this filter never survived a reload.
  useEffect(() => {
    if (authReady && !user) setMarkFilter("all");
  }, [authReady, user]);
  const [liveOn, setLiveOn] = useState<boolean>(
    () => localStorage.getItem("mp_live") !== "0", // CNBC needs no key, so live is on by default
  );

  // ---- deep link: /#AAPL opens that stock's modal ------------------------
  // Shared links land here. A hash is used (not a path) because GitHub Pages has no
  // server to rewrite /MarketPulse/AAPL, and it's one character cheaper than "?t=".
  // parseShareHash whitelists symbol-shaped hashes, so an unrelated "#section-2" or a
  // leftover OAuth fragment can't open a "No data" modal over the whole page on load.
  // Two kinds of target share this hash now (a symbol, and `#!<panel>`), so this can no
  // longer treat "not a ticker" as "close everything" — that blanket rule was only safe
  // while a symbol was the sole thing a hash could mean. Each branch closes the OTHER
  // kind, so switching between a stock link and a panel link never leaves both up.
  const syncFromHash = useCallback(() => {
    const target = parseShareHash(location.hash);

    if (target?.kind === "panel") {
      setOpenStock(null);
      setFcHighlight(null);
      setPanel(target.id);
      return;
    }
    setPanel(null);

    if (!target) {
      // The hash stopped naming anything — Back out of a shared link, or a hand-edited
      // URL. Close, because the modal that is open is the one the hash put there and
      // leaving it up makes Back look broken.
      setOpenStock(null);
      setFcHighlight(null);
      return;
    }
    setOpenView(target.view ?? null);
    // stocks.json is fetched, so a link opened on load waits for it (instant after that)
    void stocksLoaded.then(() => {
      if (parseShareHash(location.hash)?.id !== target.id) return; // the hash moved on meanwhile
      const all = currentStocks(); // not STOCKS: this callback is created once
      const hit = all.find((s) => s.t === target.id);
      if (hit) handleOpen(hit, all);
      // not bundled: maybe a tracked row still in flight (the "now tracked" reload lands here)
      else void stocksReady.then((list) => {
        const h = list.find((s) => s.t === target.id);
        if (parseShareHash(location.hash)?.id !== target.id) return; // the hash moved on meanwhile
        if (h) handleOpen(h, list);
        else handleOpenTicker(target.id); // off-universe symbol: live price + chart, metrics N/A
      });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    syncFromHash();
    // Back/forward between two shared links only changes the hash — no remount, so the
    // mount-time read alone would leave the first stock's modal open.
    addEventListener("hashchange", syncFromHash);
    return () => removeEventListener("hashchange", syncFromHash);
  }, [syncFromHash]);

  // Closing a deep-linked modal drops the hash, so a reload doesn't reopen a modal the
  // user just dismissed. replaceState (not pushState, not location.hash = "") keeps it out
  // of history and fires no hashchange, which would otherwise reopen it immediately.
  const dropHash = useCallback(() => {
    // Only strip a hash this close actually owns — a blanket strip would wipe the other
    // kind's link while it is still on screen.
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }, []);

  const closeStock = useCallback(() => {
    setOpenStock(null);
    setFcHighlight(null);
    setBellReturn(false);
    if (parseShareHash(location.hash)?.kind === "ticker") dropHash();
  }, [dropHash]);

  // The gauge owns its own open state until a link puts it there; from then on the hash
  // is the source of truth, the same way it is for a deep-linked stock modal.
  const setPanelOpen = useCallback(
    (open: boolean) => {
      setPanel(open ? "feargreed" : null);
      if (!open && parseShareHash(location.hash)?.kind === "panel") dropHash();
    },
    [dropHash],
  );

  const sectorOptions = useMemo(
    () => [...new Set([...STOCKS.map((s) => s.sec).filter(Boolean), ...themeNames])].sort(),
    [STOCKS],
  );
  // distinct consensus ratings present in the data, ranked buy→sell
  const consensusOptions = useMemo(() => {
    const order = ["StrongBuy", "Buy", "ModerateBuy", "Neutral", "Hold", "ModerateSell", "Sell", "StrongSell"];
    const rank = (c: string) => (order.indexOf(c) < 0 ? 99 : order.indexOf(c));
    return [...new Set(STOCKS.map((s) => s.con).filter(Boolean) as string[])].sort((a, b) => rank(a) - rank(b));
  }, [STOCKS]);

  const rows = useMemo(() => {
    let filtered = STOCKS.filter((s) => passes(s, { q, sectors, sectorNot, consensuses, cap }));
    // Gated on `user` because the toolbar only shows this control when signed in. Now
    // that the value persists, a restored "Liked" would otherwise hide every row for a
    // signed-out visitor — who has no marks and no button to clear it with.
    if (user && markFilter !== "all") {
      filtered = filtered.filter((s) => {
        const m = marks[s.t]?.v;
        if (markFilter === "up") return m === "up";
        if (markFilter === "down") return m === "down";
        if (markFilter === "reviewed") return !!m;
        return !m; // "unseen"
      });
    }
    return sortRows(filtered, sort, dir);
  }, [STOCKS, q, sectors, sectorNot, consensuses, cap, sort, dir, markFilter, marks, user]);

  // "clean" filter state = the view's own default (analyst view starts on Strong Buy)
  const consensusDefault = useMemo(() => (view === "analyst" ? ["StrongBuy"] : []), [view]);
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
  const activeCount =
    (q !== "" ? 1 : 0) +
    (sectors.length ? 1 : 0) +
    (sameSet(consensuses, consensusDefault) ? 0 : 1) +
    (cap !== 0 ? 1 : 0) +
    (user && markFilter !== "all" ? 1 : 0);
  const filtersActive = activeCount > 0;
  function resetFilters() {
    setQ("");
    setSectors([]);
    setSectorNot(false);
    setCap(0);
    setConsensuses(consensusDefault);
    setMarkFilter("all");
  }

  // filters follow the user across sessions/devices (DB when signed in, else
  // localStorage). Restored on load; written on every change.
  const filters = useMemo<SavedFilters>(
    () => ({ q, sectors, sectorNot, consensuses, cap, markFilter }),
    [q, sectors, sectorNot, consensuses, cap, markFilter],
  );
  const applyFilters = useCallback((f: SavedFilters) => {
    setQ(f.q ?? "");
    // migrate the older single-select shape (sector / consensus strings)
    setSectors(f.sectors ?? (f.sector ? [f.sector] : []));
    setSectorNot(!!f.sectorNot);
    setConsensuses(f.consensuses ?? bucketToList(f.consensus));
    setCap(f.cap ?? 0);
    // absent in records written before this filter was saved — fall back to "all"
    setMarkFilter(MARK_FILTERS.includes(f.markFilter as MarkFilter) ? (f.markFilter as MarkFilter) : "all");
  }, []);
  useSavedFilters(user, filters, applyFilters);

  // Watchlist is quoted ALWAYS (even off-screen / other views) so watched
  // tickers always get a live price and their alerts can fire; visible rows
  // are quoted on demand via `observe` (an IntersectionObserver ref-callback).
  const { live, price: livePrice, status: liveStatus, ticking, observe } = useLiveQuotes(
    watchlist,
    LIVE_KEY,
    liveOn,
    WORKER_URL,
  );

  // live price per watched ticker (CNBC, else Finnhub) — feeds the notification alert engine.
  // Regular-session prices only: the pre/after-hours trade is display-only (see quotes.ts).
  // No snapshot fallback: a scrape that ran pre-market can carry a pre-market px, and painting
  // it before the live quote landed fired ±5% alerts against the prior close on every load.
  const watchPrices = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of watchlist) {
      const p = livePrice[t];
      if (typeof p === "number") m[t] = p;
    }
    return m;
  }, [watchlist, livePrice]);
  const notif = useNotifications(user, watchlist, watchPrices);
  // "(3) Market Pulse": an alert landing is visible from another tab
  useEffect(() => {
    document.title = notif.unreadCount ? `(${notif.unreadCount}) Market Pulse` : "Market Pulse";
  }, [notif.unreadCount]);
  const liveCtx = useMemo(() => ({ price: livePrice, observe }), [livePrice, observe]);
  useReviewAlerts(user, watchlist, notif.pushReview);

  // clicking a notification: jump to the watchlist view and open that stock's modal.
  // A review notification also opens the forecast view with its new rows highlighted.
  function openFromNotification(n: Notification) {
    const s = STOCKS.find((x) => x.t === n.ticker);
    // the data landed after this tab loaded its bundle: reload onto the stock to get it
    if (n.type === "tracked" && !s) {
      location.hash = n.ticker;
      location.reload();
      return;
    }
    setNav("watch");
    const watched = STOCKS.filter((x) => watchlist.includes(x.t));
    // a ticker since removed from the watchlist still opens on itself, not on the list's first row
    if (s) handleOpen(s, watched.includes(s) ? watched : [s]);
    else handleOpenTicker(n.ticker);
    if (n.type === "review") setFcHighlight(n.keys ?? []);
    setBellReturn(true);
  }

  // stock (or its reviews) opened from the bell: closing it goes back to the bell panel
  function closeToBell() {
    closeStock();
    setBellReopen((k) => k + 1);
  }

  // New Arrivals review row: open the stock + its forecast view with that review glowing
  function openReview(s: Stock, list: Stock[], key: string) {
    handleOpen(s, list);
    setFcHighlight([key]);
  }

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
    const next = !liveOn;
    localStorage.setItem("mp_live", next ? "1" : "0");
    setLiveOn(next);
  }

  return (
    <div className="wrap">
      <header className={`sitehead${nav === "feed" ? " sitehead--stuck" : ""}`}>
        <h1 id="title">Market <span className="em">Pulse</span></h1>
        <div className="site-right">
          <FearGreedGauge open={panel === "feargreed"} onOpenChange={setPanelOpen} />
          <Search onOpen={handleOpen} onOpenTicker={handleOpenTicker} resetKey={nav} user={user} />
          {authReady && user && (
            <NotificationBell
              notifications={notif.notifications}
              unreadCount={notif.unreadCount}
              onMarkAllRead={notif.markAllRead}
              onClearAll={notif.clearAll}
              onOpen={openFromNotification}
              reopenKey={bellReopen}
            />
          )}
          {syncReady && (
            // fixed-width slot reserved up-front so the account control fades in
            // without reflowing the header once auth resolves (~1–2s)
            <div className="acctslot">
              {!authReady && <span className="acct-loading" aria-label="Loading account" role="status" />}
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

      <LiveCtx.Provider value={liveCtx}>
      {!STOCKS.length ? (
        <p className="empty" role="status">Loading stocks…</p>
      ) : nav === "table" ? (
        <>
          <Masthead
            poolN={STOCKS.length}
            liveStatus={liveStatus}
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
            ticking={ticking}
            observe={observe}
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
        <NewArrivals onOpen={handleOpen} onOpenReview={openReview} marks={marks} onMark={requestMark} />
      ) : nav === "feed" ? (
        FEED_ON ? (
          <Suspense fallback={null}>
            <PostFeed base={import.meta.env.BASE_URL} onOpenTicker={openPostTicker} />
          </Suspense>
        ) : null
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
          onReorder={(from, to) => {
            track("reorder_watchlist", { from, to });
            reorderWatchlist(from, to);
          }}
        />
      )}
      </LiveCtx.Provider>

      <Suspense fallback={null}>
      {openStock && (
          <StockModal
            stock={openStock}
            onClose={bellReturn ? closeToBell : closeStock}
            isTracked={(t) => watchlist.includes(t)}
            onToggleTrack={requestToggle}
            isCovered={(t) => STOCKS.some((s) => s.t === t)}
            user={user}
            onRequestTrack={syncReady ? requestTrackStock : undefined}
            confirmTicker={confirmTicker}
            onConfirmDone={() => setConfirmTicker(null)}
            markOf={(t) => marks[t]}
            onMark={requestMark}
            highlightReviews={fcHighlight}
            onReviewsClosed={bellReturn ? closeToBell : undefined}
            onReviewsUnavailable={() => setFcHighlight(null)}
            bare={bellReturn && fcHighlight != null}
            openView={openView}
            onViewClosed={() => {
              setOpenView(null);
              // `#TSM/pe` -> `#TSM`: closing the chart keeps the stock's own link
              const t = parseShareHash(location.hash);
              if (t?.kind === "ticker" && t.view) history.replaceState(null, "", location.pathname + location.search + "#" + t.id);
            }}
            list={openList}
            onIndex={(n) => {
              logOpen(openList[n].t, { via: "swipe" });
              setOpenStock(openList[n]);
            }}
          />
      )}
      </Suspense>

      <Suspense fallback={null}>
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
            // pendingRequest deliberately survives a close: the effect fires it once a user exists
          }}
        />
      )}
      </Suspense>

      <NavMenu nav={nav} onNav={handleNav} />
    </div>
  );
}
