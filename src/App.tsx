import { useCallback, useEffect, useMemo, useState } from "react";
import BestOfBest from "./components/BestOfBest";
import NewArrivals from "./components/NewArrivals";
import Masthead from "./components/Masthead";
import NavMenu, { type NavId } from "./components/NavMenu";
import FearGreedGauge from "./components/FearGreedGauge";
import NotificationBell from "./components/NotificationBell";
import { PostFeed } from "./components/PostFeed";
import Search from "./components/Search";
import SignInModal from "./components/SignInModal";
import StockModal from "./components/StockModal";
import StockTable from "./components/StockTable";
import Toolbar from "./components/Toolbar";
import Watchlist from "./components/Watchlist";
import stocksData from "./data/stocks.json";
import { flagOn } from "./featureFlags";
import { passes, sortRows, VIEWS } from "./lib";
import { parseShareHash, type PanelId } from "./share";
import type { Stock, ViewId } from "./types";
import { useLiveQuotes } from "./useLiveQuotes";
import { useNotifications, type Notification } from "./useNotifications";
import { useReviewAlerts } from "./useReviewAlerts";
import { useWatchlist, type Mark } from "./watchlist";
import { useSavedFilters, type SavedFilters } from "./savedFilters";
import { initAnalytics, track, trackUser } from "./analytics";

export type MarkFilter = "all" | "up" | "down" | "reviewed" | "unseen";
/** Whitelist for the persisted value — a stale or hand-edited record must not set a
 *  filter the toolbar has no button for, which would hide rows with no way to clear it. */
const MARK_FILTERS: MarkFilter[] = ["all", "up", "down", "reviewed", "unseen"];

const STOCKS = stocksData as Stock[];
// Baked-in Finnhub key (injected at build from the FINNHUB_KEY Actions secret),
// so live Day% works for everyone with no key entry. localStorage can override.
const BAKED_KEY = import.meta.env.VITE_FINNHUB_KEY ?? "";
// Belt-and-braces: the NavMenu item is already gated behind the same flag, but this keeps
// the feed unreachable even if something else ever sets `nav` to "feed" directly.
const FEED_ON = flagOn("feed");

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
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [openStock, setOpenStock] = useState<Stock | null>(null);
  const [fcHighlight, setFcHighlight] = useState<string[] | null>(null); // review keys to glow when opened from a notification
  // the list the modal was opened from, so ‹ › can page prev/next in place
  const [openList, setOpenList] = useState<Stock[]>([]);
  const { list: watchlist, toggle: toggleTrack, reorder: reorderWatchlist, marks, toggleMark, user, authReady, signIn, signOut, ready: syncReady } = useWatchlist();
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
    setFcHighlight(null);
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
    setFcHighlight(null);
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

  // Marks are cleared on sign-out, so drop any mark-based filter too — but only once
  // auth has actually resolved. `user` is null for a moment on every load while it does,
  // and firing then reset the filter the saved record had just restored, which the save
  // effect then wrote back as "all". That is why this filter never survived a reload.
  useEffect(() => {
    if (authReady && !user) setMarkFilter("all");
  }, [authReady, user]);
  const [liveKey, setLiveKey] = useState<string | null>(
    () => localStorage.getItem("mp_finnhub") || BAKED_KEY || null,
  );
  const [liveOn, setLiveOn] = useState<boolean>(
    () => Boolean(localStorage.getItem("mp_finnhub") || BAKED_KEY) && localStorage.getItem("mp_live") !== "0",
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
    const hit = STOCKS.find((s) => s.t === target.id);
    if (hit) handleOpen(hit, STOCKS);
    else handleOpenTicker(target.id); // off-universe symbol: live price + chart, metrics N/A
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
  }, [q, sectors, sectorNot, consensuses, cap, sort, dir, markFilter, marks, user]);

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

  // Watchlist is subscribed ALWAYS (even off-screen / other views) so watched
  // tickers always get a live price and their alerts can fire; visible table rows
  // are subscribed on demand via `observe` (an IntersectionObserver ref-callback).
  const { live, price: livePrice, status: liveStatus, observe } = useLiveQuotes(
    watchlist,
    liveKey,
    liveOn,
  );

  // best-known price per watched ticker: live Finnhub when polled, else the
  // bundled snapshot — feeds the notification alert engine.
  const pxByTicker = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of STOCKS) if (typeof s.px === "number") m[s.t] = s.px;
    return m;
  }, []);
  const watchPrices = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of watchlist) {
      const p = livePrice[t] ?? pxByTicker[t];
      if (typeof p === "number") m[t] = p;
    }
    return m;
  }, [watchlist, livePrice, pxByTicker]);
  const notif = useNotifications(user, watchlist, watchPrices);
  useReviewAlerts(user, watchlist, notif.pushReview);

  // clicking a notification: jump to the watchlist view and open that stock's modal.
  // A review notification also opens the forecast view with its new rows highlighted.
  function openFromNotification(n: Notification) {
    setNav("watch");
    const s = STOCKS.find((x) => x.t === n.ticker);
    if (s) handleOpen(s, STOCKS.filter((x) => watchlist.includes(x.t)));
    else handleOpenTicker(n.ticker);
    if (n.type === "review") setFcHighlight(n.keys ?? []);
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
          <FearGreedGauge open={panel === "feargreed"} onOpenChange={setPanelOpen} />
          <Search onOpen={handleOpen} onOpenTicker={handleOpenTicker} resetKey={nav} />
          {authReady && user && (
            <NotificationBell
              notifications={notif.notifications}
              unreadCount={notif.unreadCount}
              onMarkAllRead={notif.markAllRead}
              onClearAll={notif.clearAll}
              onOpen={openFromNotification}
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
        FEED_ON ? <PostFeed base={import.meta.env.BASE_URL} /> : null
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

      {openStock && (
          <StockModal
            stock={openStock}
            onClose={closeStock}
            isTracked={(t) => watchlist.includes(t)}
            onToggleTrack={requestToggle}
            isCovered={(t) => STOCKS.some((s) => s.t === t)}
            markOf={(t) => marks[t]}
            onMark={requestMark}
            highlightReviews={fcHighlight}
            list={openList}
            onIndex={(n) => setOpenStock(openList[n])}
          />
      )}

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
