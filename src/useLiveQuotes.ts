import { useCallback, useEffect, useRef, useState } from "react";

export type LiveStatus = "off" | "closed" | "connecting" | "live" | "error";

// US equities regular session: Mon–Fri 9:30–16:00 America/New_York.
// ponytail: market-holiday calendar omitted — on a holiday it reads "live" but
// the socket simply never streams trades, so Day% stays on the snapshot. Add a
// holiday list here if false "open" readings ever matter.
function marketOpen(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const mins = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// Finnhub free tier: 50 concurrent symbols on one WS connection.
export const WS_SYMBOL_CAP = 50;
// 1.2s between REST seeds => <=50 req/min, comfortably under Finnhub's free-tier
// 60/min. Seeds only fire for newly-subscribed symbols (bounded: watchlist +
// on-screen rows, itself capped at WS_SYMBOL_CAP), so this is sporadic now.
const SEED_STAGGER_MS = 1_200;
// 429 (rate-limit) recovery on a seed: honor Retry-After when present, else this
// fixed pause; give up on a symbol after MAX_429_STRIKES consecutive 429s.
const BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15_000; // clamp so a hostile/huge Retry-After can't freeze the loop
const MAX_429_STRIKES = 3;
const MARKET_CHECK_MS = 30_000; // re-check market hours to open/close the socket

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
// ponytail: at the cap we keep the whole watchlist + as much of the visible tail
// as fits and drop the overflow. The upgrade path for >50 tracked names is a
// second socket or round-robin rotation of the visible tail — unneeded at
// current scale (a handful of watched tickers + one screenful of rows).
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

// Streams live quotes over ONE Finnhub WebSocket. Subscribes to `watchlist`
// always (alerts depend on it) plus whatever rows report themselves visible via
// the returned `observe` ref-callback. prevClose is seeded once per symbol via a
// single REST /quote (also our key-validity probe); Day% is computed client-side
// from the streamed trade price. Live only during market hours; otherwise
// degrades to the snapshot with status "closed".
export function useLiveQuotes(watchlist: string[], apiKey: string | null, enabled: boolean) {
  const [live, setLive] = useState<Record<string, number>>({}); // computed Day%
  const [price, setPrice] = useState<Record<string, number>>({}); // latest trade price (or seed `c`)
  const [status, setStatus] = useState<LiveStatus>("off");

  // Latest props read from inside stable callbacks without re-subscribing.
  const watchlistRef = useRef<string[]>(watchlist);
  const enabledRef = useRef<boolean>(enabled);
  const apiKeyRef = useRef<string | null>(apiKey);
  watchlistRef.current = watchlist;
  enabledRef.current = enabled;
  apiKeyRef.current = apiKey;
  const watchKey = watchlist.join(",");

  const wsRef = useRef<WebSocket | null>(null);
  const stoppedRef = useRef(false); // set during effect cleanup (StrictMode-safe)
  const statusRef = useRef<LiveStatus>("off");
  const subscribedRef = useRef<Set<string>>(new Set()); // what the socket currently holds
  const prevCloseRef = useRef<Record<string, number>>({}); // session cache of prevClose per symbol
  const seededRef = useRef<Set<string>>(new Set()); // symbols seeded (or in-flight/queued)
  const seedQueueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  const seedStrikesRef = useRef(0); // consecutive 429s (rate limit is global, not per-symbol)

  // visibility tracking (fed by the IntersectionObserver below)
  const visibleRef = useRef<Set<string>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elTickerRef = useRef<WeakMap<Element, string>>(new WeakMap());
  const tickerElRef = useRef<Map<string, Element>>(new Map());
  const refCbRef = useRef<Map<string, (el: HTMLElement | null) => void>>(new Map());

  const applyStatus = useCallback((s: LiveStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  // One REST /quote per newly-subscribed symbol: seeds prevClose (baseline for
  // Day%) and `c` (so the row shows a price immediately, before any trade tick),
  // and doubles as the key-validity probe. Staggered + 429 backoff so a burst of
  // newly-visible rows can't exceed 60 REST/min.
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
            break;
          }
          if (r.status === 429) {
            if (++seedStrikesRef.current >= MAX_429_STRIKES) {
              // give up on this symbol for now; unmark so a later reconcile retries
              seedQueueRef.current.shift();
              seededRef.current.delete(sym);
              seedStrikesRef.current = 0;
              continue;
            }
            await sleep(backoffMsFromHeader(r.headers.get("Retry-After")));
            continue; // retry the SAME symbol
          }
          seedStrikesRef.current = 0;
          const j = await r.json();
          const pc = typeof j?.pc === "number" ? j.pc : NaN;
          const c = typeof j?.c === "number" ? j.c : NaN;
          if (pc > 0) prevCloseRef.current[sym] = pc;
          if (Number.isFinite(c)) {
            setPrice((prev) => ({ ...prev, [sym]: c }));
            const dp = dayPct(c, prevCloseRef.current[sym]);
            if (dp != null) setLive((prev) => ({ ...prev, [sym]: dp }));
          }
        } catch {
          // transient network — unmark so a later reconcile re-seeds; don't hammer
          seededRef.current.delete(sym);
        }
        seedQueueRef.current.shift();
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

  // Recompute the desired live set (watchlist ∪ visible, capped) and reconcile
  // it against what's already seeded/subscribed — sending only the delta.
  const reconcile = useCallback(() => {
    if (!enabledRef.current || !apiKeyRef.current || statusRef.current === "error") return;
    if (!marketOpen()) return; // off-hours: no REST, and the socket is closed anyway
    const desired = liveSymbols(watchlistRef.current, [...visibleRef.current]);
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
  }, [enqueueSeed, drainSeeds]);

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
    for (const d of m.data) {
      if (typeof d?.s !== "string" || typeof d?.p !== "number") continue;
      p[d.s] = d.p;
      const dp = dayPct(d.p, prevCloseRef.current[d.s]);
      if (dp != null) l[d.s] = dp;
    }
    if (Object.keys(p).length) setPrice((prev) => ({ ...prev, ...p }));
    if (Object.keys(l).length) setLive((prev) => ({ ...prev, ...l }));
  }, []);

  // Socket lifecycle: open only when enabled + key present + market open; reconnect
  // with backoff on unexpected close; stop on a bad key.
  useEffect(() => {
    if (!enabled || !apiKey) {
      applyStatus("off");
      return;
    }
    stoppedRef.current = false;
    statusRef.current = "connecting"; // clear any prior "error" so a fresh key retries
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = BACKOFF_MS;

    function closeSocket() {
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
    }

    function openSocket() {
      if (stoppedRef.current || wsRef.current) return; // no-op if already open/opening
      applyStatus("connecting");
      const ws = new WebSocket(`wss://ws.finnhub.io?token=${apiKey}`);
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
        reconnectTimer = setTimeout(openSocket, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
    }

    function tick() {
      if (stoppedRef.current || statusRef.current === "error") return; // bad key: stand down
      if (marketOpen()) {
        openSocket();
        reconcile(); // drive seeds even before onopen, so a bad key surfaces fast
      } else {
        closeSocket();
        applyStatus("closed");
      }
    }

    tick();
    const marketTimer = setInterval(tick, MARKET_CHECK_MS);

    return () => {
      stoppedRef.current = true;
      clearTimeout(reconnectTimer);
      clearInterval(marketTimer);
      closeSocket();
    };
  }, [enabled, apiKey, applyStatus, reconcile, handleMessage]);

  // Watchlist changes → recompute the always-on set.
  useEffect(() => {
    reconcile();
  }, [watchKey, reconcile]);

  // One IntersectionObserver for all rows; visibility deltas drive reconcile.
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
        if (changed) reconcile();
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
  }, [reconcile]);

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
            if (visibleRef.current.delete(ticker)) reconcile();
          }
        };
        refCbRef.current.set(ticker, cb);
      }
      return cb;
    },
    [reconcile],
  );

  return { live, price, status, observe };
}
