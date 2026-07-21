import type { User } from "firebase/auth";
import { getDatabase, onValue, push, ref, remove, set, update, type Database } from "firebase/database";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { evalAlert, type Dir, type Meta } from "./alertEngine";
import { app, DEV_AUTH } from "./watchlist";

// Notifications reuse the exact persistence shape of useWatchlist: Firebase RTDB
// when signed in with Firebase configured, localStorage on localhost dev.
// getDatabase(app) returns the same instance the watchlist hook uses.
const db: Database | null = app ? getDatabase(app) : null;

export interface Notification {
  id: string;
  ticker: string;
  dir: Dir;
  pct: number; // cumulative % vs add price at fire time
  at: number; // epoch ms
  read: boolean;
}

export interface NotificationsApi {
  notifications: Notification[]; // newest first
  unreadCount: number;
  markAllRead: () => void;
  clearAll: () => void;
}

type MetaMap = Record<string, Meta>;

const NOTIFS_LS = "mp_notifs";
const META_LS = "mp_watch_meta";

function readNotifsLocal(): Notification[] {
  try {
    const v = JSON.parse(localStorage.getItem(NOTIFS_LS) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeNotifsLocal(v: Notification[]): void {
  try {
    localStorage.setItem(NOTIFS_LS, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}
function readMetaLocal(): MetaMap {
  try {
    const v = JSON.parse(localStorage.getItem(META_LS) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function writeMetaLocal(v: MetaMap): void {
  try {
    localStorage.setItem(META_LS, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

// prices: watched ticker -> best-known current price (live Finnhub, else snapshot)
export function useNotifications(
  user: User | null,
  watchlist: string[],
  prices: Record<string, number>,
): NotificationsApi {
  const [notifications, setNotifs] = useState<Notification[]>([]);
  const [meta, setMeta] = useState<MetaMap>({});
  const notifsRef = useRef(notifications);
  notifsRef.current = notifications;
  // guards a single (ticker, ref) crossing from double-firing within a session
  // (e.g. React StrictMode double-invokes effects in dev).
  const firedRef = useRef<Set<string>>(new Set());

  // load / subscribe — mirrors useWatchlist's auth-driven data flow
  useEffect(() => {
    if (DEV_AUTH) {
      setNotifs(user ? readNotifsLocal() : []);
      setMeta(user ? readMetaLocal() : {});
      return;
    }
    if (!db) return;
    if (!user) {
      setNotifs([]);
      setMeta({});
      return;
    }
    const nref = ref(db, `notifications/${user.uid}`);
    const mref = ref(db, `watchmeta/${user.uid}`);
    const unNotif = onValue(nref, (snap) => {
      const v = (snap.val() as Record<string, Omit<Notification, "id">>) || {};
      const arr = Object.entries(v).map(([id, n]) => ({ id, ...n }));
      arr.sort((a, b) => b.at - a.at);
      setNotifs(arr);
    });
    const unMeta = onValue(mref, (snap) => setMeta((snap.val() as MetaMap) || {}));
    return () => {
      unNotif();
      unMeta();
    };
  }, [user]);

  const persistMeta = useCallback(
    (ticker: string, m: Meta | null) => {
      if (!user) return;
      // Update local `meta` synchronously in BOTH modes. In the Firebase branch
      // this is the race fix: previously `meta` only changed after the async
      // set() echoed back via onValue, so until then the reconcile effect's
      // `!meta[t]` guard kept re-firing and re-seeding `ref` at the (rising)
      // live price — pushing the ±5% baseline out of reach and silencing
      // alerts forever. Seeding now happens exactly once, at add-time price.
      setMeta((prev) => {
        const next = { ...prev };
        if (m) next[ticker] = m;
        else delete next[ticker];
        if (DEV_AUTH) writeMetaLocal(next);
        return next;
      });
      // ponytail: onValue does a full-map replace, so a concurrent write to a
      // different ticker could momentarily wipe this optimistic entry and let it
      // re-seed. Rare (needs a live tick inside that window); add a seededRef
      // guard in the reconcile effect if it ever bites.
      if (!DEV_AUTH && db) void set(ref(db, `watchmeta/${user.uid}/${ticker}`), m); // null removes
    },
    [user],
  );

  const addNotif = useCallback(
    (n: Omit<Notification, "id">) => {
      if (!user) return;
      if (DEV_AUTH) {
        setNotifs((prev) => {
          const id = `n${n.at}-${Math.random().toString(36).slice(2, 8)}`;
          const next = [{ id, ...n }, ...prev];
          writeNotifsLocal(next);
          return next;
        });
      } else if (db) {
        void push(ref(db, `notifications/${user.uid}`), n);
      }
    },
    [user],
  );

  // reconcile meta: create for newly-watched tickers (reqs 11 + 12), prune the rest
  useEffect(() => {
    if (!user) return;
    for (const t of watchlist) {
      if (!meta[t] && typeof prices[t] === "number") {
        persistMeta(t, { addPx: prices[t], ref: prices[t] });
      }
    }
    for (const t of Object.keys(meta)) {
      if (!watchlist.includes(t)) persistMeta(t, null);
    }
  }, [user, watchlist, prices, meta, persistMeta]);

  // fire alerts on the ratchet
  useEffect(() => {
    if (!user) return;
    for (const t of watchlist) {
      const m = meta[t];
      const cur = prices[t];
      if (!m || typeof cur !== "number") continue;
      const res = evalAlert(cur, m);
      if (!res) continue;
      const key = `${t}:${m.ref}`;
      if (firedRef.current.has(key)) continue;
      firedRef.current.add(key);
      addNotif({ ticker: t, dir: res.dir, pct: res.pct, at: Date.now(), read: false });
      persistMeta(t, { addPx: m.addPx, ref: res.newRef });
    }
  }, [user, watchlist, prices, meta, addNotif, persistMeta]);

  const markAllRead = useCallback(() => {
    if (!user) return;
    if (DEV_AUTH) {
      setNotifs((prev) => {
        const next = prev.map((n) => (n.read ? n : { ...n, read: true }));
        writeNotifsLocal(next);
        return next;
      });
      return;
    }
    if (!db) return;
    const upd: Record<string, boolean> = {};
    for (const n of notifsRef.current) if (!n.read) upd[`${n.id}/read`] = true;
    if (Object.keys(upd).length) void update(ref(db, `notifications/${user.uid}`), upd);
  }, [user]);

  const clearAll = useCallback(() => {
    if (!user) return;
    if (DEV_AUTH) {
      writeNotifsLocal([]);
      setNotifs([]);
      return;
    }
    if (!db) return;
    void remove(ref(db, `notifications/${user.uid}`));
  }, [user]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  return { notifications, unreadCount, markAllRead, clearAll };
}
