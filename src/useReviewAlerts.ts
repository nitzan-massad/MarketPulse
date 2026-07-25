import type { User } from "firebase/auth";
import { getDatabase, onValue, ref, set, type Database } from "firebase/database";
import { useCallback, useEffect, useRef } from "react";
import stocksData from "./data/stocks.json";
import { fetchForecasts } from "./forecasts";
import { allReviewKeys, newReviewKeys } from "./reviewAlerts";
import type { Stock } from "./types";
import { app, DEV_AUTH } from "./watchlist";

// Detects new analyst reviews on watchlist stocks and pushes grouped notifications
// (via the shared store's `pushReview`). Per-ticker "seen" review keys persist the same
// way the watchlist does: Firebase RTDB when signed in, localStorage on localhost dev.
const db: Database | null = app ? getDatabase(app) : null;
const SEEN_LS = "mp_review_seen";
const POLL_MS = 30 * 60 * 1000; // reviews land ~every 5h via CI; a light poll catches them

type SeenMap = Record<string, string[]>;
const nameByTicker = new Map((stocksData as Stock[]).map((s) => [s.t, s.n]));

function readSeenLocal(): SeenMap {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_LS) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function useReviewAlerts(
  user: User | null,
  watchlist: string[],
  pushReview: (ticker: string, company: string, newKeys: string[]) => void,
): void {
  const seenRef = useRef<SeenMap>({});
  const loadedRef = useRef(false);
  const runningRef = useRef(false);
  const pushRef = useRef(pushReview);
  pushRef.current = pushReview;
  const watchRef = useRef(watchlist);
  watchRef.current = watchlist;

  // load / subscribe to the per-ticker seen sets
  useEffect(() => {
    loadedRef.current = false;
    seenRef.current = {};
    if (!user) return;
    if (DEV_AUTH) {
      seenRef.current = readSeenLocal();
      loadedRef.current = true;
      return;
    }
    if (!db) return;
    const sref = ref(db, `reviewseen/${user.uid}`);
    const un = onValue(sref, (snap) => {
      seenRef.current = (snap.val() as SeenMap) || {};
      loadedRef.current = true;
    });
    return un;
  }, [user]);

  const persist = useCallback(
    (ticker: string, keys: string[] | null) => {
      if (!user) return;
      if (keys) seenRef.current[ticker] = keys;
      else delete seenRef.current[ticker];
      if (DEV_AUTH) {
        try {
          localStorage.setItem(SEEN_LS, JSON.stringify(seenRef.current));
        } catch {
          /* ignore */
        }
      } else if (db) {
        void set(ref(db, `reviewseen/${user.uid}/${ticker}`), keys); // null removes
      }
    },
    [user],
  );

  const run = useCallback(async () => {
    if (!user || !loadedRef.current || runningRef.current) return;
    runningRef.current = true;
    try {
      const watched = watchRef.current;
      for (const t of watched) {
        const fc = await fetchForecasts(t, true);
        if (!fc) continue; // no coverage / offline — never errors
        const cur = allReviewKeys(fc);
        const prev = seenRef.current[t];
        if (prev === undefined) {
          persist(t, cur); // first sight -> baseline silently, no flood of old reviews
          continue;
        }
        const fresh = newReviewKeys(fc, prev);
        if (fresh.length) pushRef.current(t, nameByTicker.get(t) || t, fresh);
        if (fresh.length || prev.length !== cur.length) persist(t, cur); // advance the watermark
      }
      // prune seen sets for stocks no longer watched (re-adds will re-baseline)
      const watchedSet = new Set(watched);
      for (const t of Object.keys(seenRef.current)) if (!watchedSet.has(t)) persist(t, null);
    } finally {
      runningRef.current = false;
    }
  }, [user, persist]);

  // run on mount, on a light interval, and when the tab regains focus
  useEffect(() => {
    if (!user || !watchlist.length) return;
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void run();
    };
    const kick = setTimeout(tick, 800); // let the seen subscription settle first
    const id = setInterval(tick, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      clearTimeout(kick);
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [user, watchlist, run]);
}
