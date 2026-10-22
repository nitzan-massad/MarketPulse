import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CNBC_MAX,
  cnbcRequest,
  earlyPollOk,
  etClock,
  finnhubSymbols,
  INITIAL_SOURCE,
  mergeQuotes,
  nextPollMs,
  nextSource,
  normSym,
  readQuotes,
  sameQuotes,
  sessionOf,
  type CnbcMap,
  type Session,
  type SourceState,
} from "./quotes";

// live/pre/post: CNBC is answering (regular session / around it). backup: CNBC is down and
// Finnhub carries the session. error: CNBC is down and Finnhub can't carry the session —
// no key, or the key was rejected.
export type LiveStatus = "off" | "closed" | "connecting" | "live" | "pre" | "post" | "backup" | "error";

// The one session clock (quotes.ts) — Finnhub runs only in the regular session.
const marketOpen = (): boolean => sessionOf(etClock()) === "regular";

// Finnhub free tier: 50 concurrent symbols on one WS connection.
export const WS_SYMBOL_CAP = 50;
// 1.2s between REST seeds => <=50 req/min, comfortably under Finnhub's free-tier
// 60/min. Seeds fire whenever a symbol (re-)enters the Finnhub set — only symbols CNBC
// lacks, or everything while CNBC is down — bounded by WS_SYMBOL_CAP.
const SEED_STAGGER_MS = 1_200;
// 429 (rate-limit) recovery on a seed: honor Retry-After when present, else this
// fixed pause; give up on a symbol after MAX_429_STRIKES consecutive 429s.
const BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15_000; // clamp so a hostile/huge Retry-After can't freeze the loop
const MAX_429_STRIKES = 3;
const MARKET_CHECK_MS = 30_000; // re-check market hours to open/close the socket
const NEW_SYMBOL_DEBOUNCE_MS = 400;
const POLL_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ---- pure helpers (unit-checked in useLiveQuotes.check.ts) --------------------

// Retry-After -> milliseconds to wait. Finnhub sends integer seconds. ponytail:
// HTTP-date form of Retry-After is unsupported (Finnhub never sends it) and falls
// back to the fixed backoff.
export function backoffMsFromHeader(retryAfter: string | null): number {
  const secs = retryAfter ? parseInt(retryAfter, 10) : NaN;
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  return BACKOFF_MS;
}

// Day-% from the latest trade price and the session's prior close. Returns null
// when prevClose is unusable (missing / non-positive), mirroring alertEngine's
// guard style — the row then falls back to its snapshot Day%.
export function dayPct(price: number, prevClose: number): number | null {
  if (!(prevClose > 0) || !Number.isFinite(price)) return null;
  return ((price - prevClose) / prevClose) * 100;
}

// Live subscription set: the always-on watchlist first, then visible rows not
// already watched, deduped and capped at `max`. Watchlist wins the ceiling
// because the alert engine depends on it; visible rows are best-effort.
// Used twice: the CNBC request (max CNBC_MAX) and the Finnhub fallback socket (max 50).
// ponytail: at the Finnhub cap (only reached while CNBC is down) we keep the whole
// watchlist + as much of the visible tail as fits and drop the overflow.
export function liveSymbols(watchlist: string[], visible: string[], max = WS_SYMBOL_CAP): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (seen.has(t) || out.length >= max) return;
    seen.add(t);
    out.push(t);
  };
  for (const t of watchlist) push(t);
  for (const t of visible) push(t);
  return out;
}

// Subscription delta: given what the socket is currently subscribed to and what
// it should be, return the symbols to subscribe (add) and unsubscribe (remove)
// so we only send the change, never churn the whole set.
export function diffSubs(
  current: Iterable<string>,
  desired: Iterable<string>,
): { add: string[]; remove: string[] } {
  const cur = new Set(current);
  const des = new Set(desired);
  const add: string[] = [];
  const remove: string[] = [];
  for (const s of des) if (!cur.has(s)) add.push(s);
  for (const s of cur) if (!des.has(s)) remove.push(s);
  return { add, remove };
}

// ---- hook --------------------------------------------------------------------

// Live quotes for the watchlist (always — alerts depend on it) plus whatever rows report
// themselves visible via the returned `observe` ref-callback.
//
// Primary: CNBC via the Worker's /quotes (worker/cnbc.js), polled every 20s in the session,
// 60s around it, rarely when closed. Fallback: Finnhub — the shared relay socket for trades
// plus one REST /quote per symbol for prevClose — but only for symbols CNBC lacks, or for
// everything once CNBC fails FAILS_TO_SWITCH polls in a row (re-probed every PROBE_MS).
// Finnhub still runs only during the regular session, as it always did.
export function useLiveQuotes(
  watchlist: string[],
  apiKey: string | null,
  enabled: boolean,
  workerUrl: string,
) {
  const [cnbc, setCnbc] = useState<CnbcMap>({});
  const [cnbcLast, setCnbcLast] = useState<CnbcMap>({}); // last non-null quote per symbol
  const [cnbcReady, setCnbcReady] = useState(false);
  const [src, setSrc] = useState<SourceState>(INITIAL_SOURCE);
  const [fhPct, setFhPct] = useState<Record<string, number>>({}); // Finnhub-computed Day%
  const [fhPrice, setFhPrice] = useState<Record<string, number>>({}); // Finnhub trade price (or seed `c`)
  const [fhStatus, setFhStatus] = useState<LiveStatus>("off");
  const [session, setSession] = useState<Session>(() => sessionOf(etClock()));

  // Latest props/state read from inside stable callbacks without re-subscribing.
  const watchlistRef = useRef<string[]>(watchlist);
  const enabledRef = useRef<boolean>(enabled);
  const apiKeyRef = useRef<string | null>(apiKey);
  const cnbcRef = useRef<CnbcMap>(cnbc);
  const cnbcAtRef = useRef<Record<string, number>>({}); // when CNBC last answered for a symbol
  const fhPriceRef = useRef<Record<string, number>>(fhPrice);
  fhPriceRef.current = fhPrice;
  const srcRef = useRef<SourceState>(src);
  watchlistRef.current = watchlist;
  enabledRef.current = enabled;
  apiKeyRef.current = apiKey;
  cnbcRef.current = cnbc;
  srcRef.current = src;
  const watchKey = watchlist.join(",");

  const wsRef = useRef<WebSocket | null>(null);
  const socketCtlRef = useRef<{ open: () => void; close: () => void } | null>(null);
  const stoppedRef = useRef(false); // set during effect cleanup (StrictMode-safe)
  const statusRef = useRef<LiveStatus>("off"); // Finnhub socket status
  const subscribedRef = useRef<Set<string>>(new Set()); // what the socket currently holds
  const prevCloseRef = useRef<Record<string, number>>({}); // session cache of prevClose per symbol
  const seededRef = useRef<Set<string>>(new Set()); // symbols seeded (or in-flight/queued)
  const seedQueueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  const seedStrikesRef = useRef(0); // consecutive 429s (rate limit is global, not per-symbol)
  const pollNowRef = useRef<(() => void) | null>(null);

  // visibility tracking (fed by the IntersectionObserver below)
  const visibleRef = useRef<Set<string>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elTickerRef = useRef<WeakMap<Element, string>>(new WeakMap());
  const tickerElRef = useRef<Map<string, Element>>(new Map());
  const refCbRef = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map());

  const applyStatus = useCallback((s: LiveStatus) => {
    statusRef.current = s;
    setFhStatus(s);
  }, []);

  // Everything we want a quote for: watchlist first, then visible rows.
  const wanted = useCallback(
    (max: number) => liveSymbols(watchlistRef.current, [...visibleRef.current], max),
    [],
  );

  // ---- Finnhub fallback ------------------------------------------------------

  // One REST /quote per newly-subscribed symbol: seeds prevClose (baseline for
  // Day%) and `c` (so the row shows a price immediately, before any trade tick),
  // and doubles as the key-validity probe. Staggered + 429 backoff so a burst of
  // newly-visible rows can't exceed 60 REST/min.
  const dequeue = (sym: string) => {
    seedQueueRef.current = seedQueueRef.current.filter((s) => s !== sym);
  };
  const drainSeeds = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (seedQueueRef.current.length) {
        if (stoppedRef.current || statusRef.current === "error") break;
        const key = apiKeyRef.current;
        if (!key || !marketOpen()) break; // never REST off-hours or without a key
        const sym = seedQueueRef.current[0];
        try {
          const r = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`,
          );
          if (r.status === 401 || r.status === 403) {
            applyStatus("error"); // bad key: stop the socket loop too (see tick)
            seedQueueRef.current = [];
            seededRef.current.clear(); // a fresh key must re-seed them all
            break;
          }
          if (r.status === 429) {
            if (++seedStrikesRef.current >= MAX_429_STRIKES) {
              // give up on this symbol for now; unmark so a later reconcile retries
              dequeue(sym);
              seededRef.current.delete(sym);
              seedStrikesRef.current = 0;
              continue;
            }
            await sleep(backoffMsFromHeader(r.headers.get("Retry-After")));
            continue; // retry the SAME symbol
          }
          seedStrikesRef.current = 0;
          const j = await r.json();
          if (!seededRef.current.has(sym)) {
            // forgotten while in flight (left the Finnhub set): its price must not come back
            dequeue(sym);
            continue;
          }
          const pc = typeof j?.pc === "number" ? j.pc : NaN;
          const c = typeof j?.c === "number" ? j.c : NaN;
          if (pc > 0) prevCloseRef.current[sym] = pc;
          if (Number.isFinite(c) && c > 0) {
            setFhPrice((prev) => ({ ...prev, [sym]: c }));
            const dp = dayPct(c, prevCloseRef.current[sym]);
            if (dp != null) setFhPct((prev) => ({ ...prev, [sym]: dp }));
          }
        } catch {
          // transient network — unmark so a later reconcile re-seeds; don't hammer
          seededRef.current.delete(sym);
        }
        dequeue(sym); // by value: forgetFinnhub may have reshaped the queue during the await
        await sleep(SEED_STAGGER_MS);
      }
    } finally {
      drainingRef.current = false;
    }
  }, [applyStatus]);

  const enqueueSeed = useCallback(
    (syms: string[]) => {
      for (const s of syms) {
        if (!seededRef.current.has(s)) {
          seededRef.current.add(s); // mark up-front so we never double-enqueue
          seedQueueRef.current.push(s);
        }
      }
      void drainSeeds();
    },
    [drainSeeds],
  );

  // A symbol leaving the Finnhub set drops its Finnhub state, so a later fallback re-seeds it
  // instead of resurfacing an hours-old trade price (and mergeQuotes preferring it to CNBC's).
  // Covers symbols that hold a trade price without a seed (their seed failed) too.
  const forgetFinnhub = useCallback((keep: string[]) => {
    const k = new Set(keep);
    const gone = [...new Set([...seededRef.current, ...Object.keys(fhPriceRef.current)])].filter((s) => !k.has(s));
    if (!gone.length) return;
    for (const s of gone) {
      seededRef.current.delete(s);
      delete prevCloseRef.current[s];
    }
    seedQueueRef.current = seedQueueRef.current.filter((s) => k.has(s));
    const drop = (prev: Record<string, number>) => {
      const next = { ...prev };
      for (const s of gone) delete next[s];
      return next;
    };
    setFhPrice(drop);
    setFhPct(drop);
  }, []);

  // The Finnhub set: of what we want, only what CNBC can't serve (or all of it while CNBC
  // is down), capped at the socket's 50. Opens the socket only when that set is non-empty,
  // closes it when it empties, and sends only the subscribe/unsubscribe delta.
  const reconcile = useCallback(() => {
    if (!enabledRef.current || !apiKeyRef.current || statusRef.current === "error") return;
    if (!marketOpen()) return; // off-hours: no REST, and the socket is closed anyway
    const fb = new Set(finnhubSymbols(wanted(CNBC_MAX), cnbcRef.current, srcRef.current));
    const desired = liveSymbols(
      watchlistRef.current.filter((t) => fb.has(t)),
      [...visibleRef.current].filter((t) => fb.has(t)),
    );
    forgetFinnhub(desired);
    if (!desired.length) {
      socketCtlRef.current?.close();
      return;
    }
    socketCtlRef.current?.open();
    const toSeed = desired.filter((s) => !seededRef.current.has(s));
    if (toSeed.length) enqueueSeed(toSeed);
    else void drainSeeds(); // resume anything a market-close stranded in the queue
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const { add, remove } = diffSubs(subscribedRef.current, desired);
      for (const s of add) ws.send(JSON.stringify({ type: "subscribe", symbol: s }));
      for (const s of remove) ws.send(JSON.stringify({ type: "unsubscribe", symbol: s }));
      subscribedRef.current = new Set(desired);
    }
  }, [enqueueSeed, drainSeeds, wanted, forgetFinnhub]);

  const handleMessage = useCallback((raw: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const m = msg as { type?: string; data?: Array<{ s?: string; p?: number }> };
    if (m?.type !== "trade" || !Array.isArray(m.data)) return; // ignore ping/keepalive etc.
    const p: Record<string, number> = {};
    const l: Record<string, number> = {};
    const unseeded: string[] = []; // no prior close yet (new session): drop yesterday's Day%
    for (const d of m.data) {
      if (typeof d?.s !== "string" || typeof d?.p !== "number" || !(d.p > 0)) continue;
      if (!subscribedRef.current.has(d.s)) continue; // in flight past an unsubscribe: forgotten
      p[d.s] = d.p;
      const dp = dayPct(d.p, prevCloseRef.current[d.s]);
      if (dp != null) l[d.s] = dp;
      else unseeded.push(d.s);
    }
    if (Object.keys(p).length) setFhPrice((prev) => ({ ...prev, ...p }));
    if (Object.keys(l).length || unseeded.length)
      setFhPct((prev) => {
        const next = { ...prev, ...l };
        for (const s of unseeded) delete next[s];
        return next;
      });
  }, []);

  // Socket lifecycle: opened/closed by reconcile (only when Finnhub has symbols to carry),
  // reconnect with backoff on unexpected close, stop on a bad key.
  useEffect(() => {
    if (!enabled || !apiKey) {
      applyStatus("off");
      return;
    }
    stoppedRef.current = false;
    statusRef.current = "off"; // clear any prior "error" so a fresh key retries
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = BACKOFF_MS;

    function closeSocket() {
      clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      subscribedRef.current = new Set();
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
      if (statusRef.current !== "error") applyStatus(marketOpen() ? "off" : "closed");
    }

    function openSocket() {
      if (stoppedRef.current || wsRef.current || statusRef.current === "error") return; // no-op if open/opening
      applyStatus("connecting");
      const ws = new WebSocket(`${workerUrl.replace(/^http/, "ws")}/live`);
      wsRef.current = ws;
      ws.onopen = () => {
        if (stoppedRef.current) {
          closeSocket();
          return;
        }
        backoff = BACKOFF_MS; // healthy connection resets the backoff
        subscribedRef.current = new Set(); // a fresh socket knows nothing
        applyStatus("live");
        reconcile(); // subscribe the whole desired set + seed prevClose
      };
      ws.onmessage = (ev) => handleMessage(ev.data as string);
      ws.onerror = () => {
        /* onclose drives reconnect */
      };
      ws.onclose = () => {
        wsRef.current = null;
        subscribedRef.current = new Set();
        if (stoppedRef.current || statusRef.current === "error") return;
        if (!marketOpen()) {
          applyStatus("closed");
          return;
        }
        applyStatus("connecting");
        reconnectTimer = setTimeout(reconcile, backoff); // reopens only if still needed
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    }

    socketCtlRef.current = { open: openSocket, close: closeSocket };

    function tick() {
      if (stoppedRef.current || statusRef.current === "error") return; // bad key: stand down
      if (marketOpen()) reconcile();
      else {
        closeSocket();
        // Tomorrow's session needs tomorrow's prior close: re-seed everything. fhPrice stays
        // (dropping it would push those cells back to the snapshot).
        seededRef.current.clear();
        seedQueueRef.current = [];
        prevCloseRef.current = {};
      }
    }

    tick();
    const marketTimer = setInterval(tick, MARKET_CHECK_MS);

    return () => {
      stoppedRef.current = true;
      clearTimeout(reconnectTimer);
      clearInterval(marketTimer);
      socketCtlRef.current = null;
      closeSocket();
    };
  }, [enabled, apiKey, workerUrl, applyStatus, reconcile, handleMessage]);

  // CNBC answers (or failures) change which symbols Finnhub must carry.
  useEffect(() => {
    reconcile();
  }, [cnbc, src, reconcile]);

  // The session clock drives the badge too; poll() alone would leave it up to PROBE_MS stale
  // in backup mode (e.g. "Market closed" for minutes after the open while Finnhub ticks).
  useEffect(() => {
    const id = setInterval(() => setSession(sessionOf(etClock())), MARKET_CHECK_MS);
    return () => clearInterval(id);
  }, []);

  // ---- CNBC primary --------------------------------------------------------------

  // Poll loop. Paused while the tab is hidden (a visible tab polls at once on return).
  useEffect(() => {
    if (!enabled) {
      setCnbcReady(false);
      // Re-enabling starts a clean strike count: a leftover fail must not pair with the
      // Worker's remembered 502 into a switch to Finnhub.
      srcRef.current = INITIAL_SOURCE;
      setSrc(INITIAL_SOURCE);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let again = false; // a poll asked for while one was in flight runs right after it
    let parked = false; // the cadence came due while the tab was hidden: owed on return

    async function poll() {
      clearTimeout(timer);
      if (stopped) return;
      const clock = etClock();
      const sess = sessionOf(clock);
      setSession(sess);
      if (typeof document !== "undefined" && document.hidden) {
        parked = true; // resumed by visibilitychange
        return;
      }
      parked = false;
      if (inFlight) {
        again = true;
        return;
      }
      const syms = cnbcRequest(wanted(CNBC_MAX));
      if (syms.length) {
        inFlight = true;
        let ok = false;
        try {
          // A hung request must count as a failed poll (and free the loop), not stall it.
          const r = await fetch(`${workerUrl}/quotes?symbols=${syms.map(encodeURIComponent).join(",")}`, {
            signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
          });
          const quotes = r.ok ? readQuotes(await r.json(), clock) : null;
          if (quotes) {
            ok = true;
            const at = Date.now();
            for (const k of Object.keys(quotes)) cnbcAtRef.current[k] = at;
            if (!stopped) {
              setCnbc((prev) => (sameQuotes(prev, quotes) ? prev : { ...prev, ...quotes }));
              const real = Object.fromEntries(Object.entries(quotes).filter(([, q]) => q != null));
              setCnbcLast((prev) => (sameQuotes(prev, real) ? prev : { ...prev, ...real }));
            }
          }
        } catch {
          /* network / CORS / blocked — counts as a failed poll */
        }
        inFlight = false;
        if (stopped) return;
        const queued = again;
        again = false;
        // Ref first: the cadence below (and earlyPollOk) must see the new source this pass.
        srcRef.current = nextSource(srcRef.current, ok);
        setSrc(srcRef.current);
        if (queued && earlyPollOk(srcRef.current)) {
          void poll();
          return;
        }
      }
      setCnbcReady(true); // also with nothing to ask for, so the badge leaves "connecting"
      timer = setTimeout(poll, nextPollMs(srcRef.current, sess));
    }

    // On return: a poll that came due while hidden runs now; otherwise only when an early poll
    // is safe — after a failure the pending cadence timer still fires on its own schedule.
    const onVis = () => {
      if (!document.hidden && (parked || earlyPollOk(srcRef.current))) void poll();
    };
    document.addEventListener("visibilitychange", onVis);
    pollNowRef.current = () => void poll();
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      pollNowRef.current = null;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, workerUrl, wanted]);

  // A symbol CNBC has never been asked about (new watch, newly visible row) gets a prompt
  // poll instead of waiting out the cadence; debounced so a scroll is one request.
  const askTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Visibility changes never re-render the app by themselves. While Finnhub carries (or after
  // a failed poll), CNBC keeps to its cadence/PROBE_MS — no prompt polls.
  const symbolsChanged = useCallback(() => {
    reconcile();
    clearTimeout(askTimerRef.current);
    askTimerRef.current = setTimeout(() => {
      if (!earlyPollOk(srcRef.current)) return;
      const syms = wanted(CNBC_MAX);
      // Never asked, or last answered longer ago than the current cadence (a row scrolling back
      // into view mid-session would otherwise wait for the next tick; off-hours the cadence is
      // slow, so a scroll then doesn't buy a poll).
      const now = Date.now();
      const freshFor = nextPollMs(srcRef.current, sessionOf(etClock()));
      const unknown = syms.some((t) => {
        const k = normSym(t);
        return k != null && !(now - (cnbcAtRef.current[k] ?? 0) < freshFor);
      });
      if (unknown) pollNowRef.current?.();
    }, NEW_SYMBOL_DEBOUNCE_MS);
  }, [reconcile, wanted]);
  useEffect(() => () => clearTimeout(askTimerRef.current), []);

  // Watchlist changes → recompute the always-on set.
  useEffect(() => {
    symbolsChanged();
  }, [watchKey, symbolsChanged]);

  // One IntersectionObserver for all rows; visibility deltas drive the symbol set.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const e of entries) {
          const t = elTickerRef.current.get(e.target);
          if (!t) continue;
          if (e.isIntersecting) {
            if (!visibleRef.current.has(t)) {
              visibleRef.current.add(t);
              changed = true;
            }
          } else if (visibleRef.current.delete(t)) {
            changed = true;
          }
        }
        if (changed) symbolsChanged();
      },
      { rootMargin: "200px" }, // prefetch a touch before the row scrolls in
    );
    observerRef.current = io;
    // Rows that mounted before this effect (their ref-callbacks ran first) — pick
    // them up now.
    for (const el of tickerElRef.current.values()) io.observe(el);
    return () => {
      io.disconnect();
      observerRef.current = null;
    };
  }, [symbolsChanged]);

  // Stable per-ticker ref-callback: <tr ref={observe(ticker)}>. Cached so the
  // callback identity is stable across renders (no observe/unobserve churn).
  const observe = useCallback(
    (ticker: string) => {
      let cb = refCbRef.current.get(ticker);
      if (!cb) {
        cb = (el: HTMLElement | null) => {
          if (el) {
            tickerElRef.current.set(ticker, el);
            elTickerRef.current.set(el, ticker);
            observerRef.current?.observe(el);
          } else {
            const prev = tickerElRef.current.get(ticker);
            if (prev) {
              observerRef.current?.unobserve(prev);
              elTickerRef.current.delete(prev);
              tickerElRef.current.delete(ticker);
            }
            if (visibleRef.current.delete(ticker)) symbolsChanged();
          }
        };
        refCbRef.current.set(ticker, cb);
      }
      return cb;
    },
    [symbolsChanged],
  );

  // ---- merge -----------------------------------------------------------------

  // Every symbol either source has ever priced (kept when it scrolls off, so a row coming
  // back shows its live value at once, never a snapshot flash), merged one-source-per-symbol
  // (quotes.ts). cnbcLast keys are normalized; the bundled tickers already are in that form.
  const { price, pct } = useMemo(() => {
    if (!enabled) return { price: {}, pct: {} }; // live off: every cell back on its snapshot
    const tickers = new Set<string>([...watchlist, ...Object.keys(cnbcLast), ...Object.keys(fhPrice)]);
    return mergeQuotes(tickers, cnbc, src, fhPrice, fhPct, cnbcLast);
  }, [enabled, watchlist, cnbc, cnbcLast, src, fhPrice, fhPct]);

  const status: LiveStatus = !enabled
    ? "off"
    : src.source === "finnhub"
      ? session !== "regular"
        ? "closed"
        : !apiKey || fhStatus === "error" // nothing can carry the session: ask for a key
          ? "error"
          : fhStatus === "live"
            ? "backup"
            : "connecting"
      : !cnbcReady
        ? "connecting"
        : session === "regular"
          ? "live"
          : session;

  // `live` = Day% per ticker (kept under its old name — every consumer reads it); `price`
  // feeds the Price columns and the alert engine; `ticking` = Day% is moving right now.
  const ticking = status === "live" || status === "backup";
  return { live: pct, price, status, ticking, observe };
}
