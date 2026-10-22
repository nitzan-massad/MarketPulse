import type { User } from "firebase/auth";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { evalAlert, reFireSuppressed, type Dir, type Meta } from "./alertEngine";
import { DEV_AUTH, useFb } from "./watchlist";

// Notifications reuse the exact persistence shape of useWatchlist: Firebase RTDB
// when signed in with Firebase configured, localStorage on localhost dev.
// useFb() hands back the same lazily loaded SDK + db instance the watchlist hook uses.

export interface Notification {
  id: string;
  type: "price" | "review" | "tracked"; // tracked: a "Track this stock" request landed
  ticker: string;
  dir?: Dir; // price
  pct?: number; // price: cumulative % vs add price at fire time
  company?: string; // review
  keys?: string[]; // review: identity keys of the new reviews (drives the modal highlight)
  at: number; // epoch ms
  read: boolean;
}

export interface NotificationsApi {
  notifications: Notification[]; // newest first
  unreadCount: number;
  markAllRead: () => void;
  clearAll: () => void;
  pushReview: (ticker: string, company: string, newKeys: string[]) => void;
}

type MetaMap = Record<string, Meta>;

const NOTIFS_LS = "mp_notifs";
// Signed-in boot cache: the last list RTDB sent for this uid, painted on reload while the
// session restores and the listener connects; the first RTDB value replaces it.
const NOTIFS_CACHE = "mp_notifs_cache";
function readNotifsCache(uid: string): Notification[] {
  try {
    const v = JSON.parse(localStorage.getItem(NOTIFS_CACHE) || "null");
    return v && v.uid === uid && Array.isArray(v.list) ? v.list : [];
  } catch {
    return [];
  }
}
function writeNotifsCache(uid: string | null, list: Notification[]): void {
  try {
    if (uid) localStorage.setItem(NOTIFS_CACHE, JSON.stringify({ uid, list }));
    else localStorage.removeItem(NOTIFS_CACHE);
  } catch {
    /* ignore */
  }
}
const META_LS = "mp_watch_meta";

function readNotifsLocal(): Notification[] {
  try {
    const v = JSON.parse(localStorage.getItem(NOTIFS_LS) || "[]");
    return Array.isArray(v) ? v.map((n) => ({ type: "price", ...n })) : [];
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

// prices: watched ticker -> best-known current price (live CNBC/Finnhub, else snapshot)
export function useNotifications(
  user: User | null,
  watchlist: string[],
  prices: Record<string, number>,
): NotificationsApi {
  const [notifications, setNotifs] = useState<Notification[]>(() =>
    user && !DEV_AUTH ? readNotifsCache(user.uid) : [],
  );
  const [meta, setMeta] = useState<MetaMap>({});
  // True once THIS user's stored meta has arrived. Until then an empty `meta` means "not loaded",
  // not "no baselines" — seeding from it would overwrite every stored alert baseline with the
  // current price (the reconcile effect below), so both alert effects wait for it.
  const [metaLoaded, setMetaLoaded] = useState(false);
  const notifsRef = useRef(notifications);
  notifsRef.current = notifications;
  // In-memory price at each ticker's last alert. The re-fire guard reads this
  // synchronously so it never depends on the async `meta.ref` round-trip (see the
  // fire effect); also covers React StrictMode's double-invoke in dev.
  const lastFiredPxRef = useRef<Record<string, number>>({});
  const f = useFb();

  // load / subscribe — mirrors useWatchlist's auth-driven data flow
  useEffect(() => {
    if (DEV_AUTH) {
      setNotifs(user ? readNotifsLocal() : []);
      setMeta(user ? readMetaLocal() : {});
      setMetaLoaded(!!user);
      return;
    }
    setMetaLoaded(false);
    if (!f) return;
    if (!user) {
      setNotifs([]);
      setMeta({});
      writeNotifsCache(null, []);
      return;
    }
    const nref = f.ref(f.db, `notifications/${user.uid}`);
    const mref = f.ref(f.db, `watchmeta/${user.uid}`);
    const unNotif = f.onValue(nref, (snap) => {
      const v =
        (snap.val() as Record<string, Omit<Notification, "id" | "type"> & { type?: Notification["type"] }>) || {};
      const arr = Object.entries(v).map(([id, n]) => ({ id, ...n, type: n.type ?? "price" }));
      arr.sort((a, b) => b.at - a.at);
      setNotifs(arr);
      writeNotifsCache(user.uid, arr);
    });
    const unMeta = f.onValue(mref, (snap) => {
      setMeta((snap.val() as MetaMap) || {});
      setMetaLoaded(true);
    });
    return () => {
      unNotif();
      unMeta();
    };
  }, [f, user]);

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
      if (!DEV_AUTH && f) void f.set(f.ref(f.db, `watchmeta/${user.uid}/${ticker}`), m); // null removes
    },
    [f, user],
  );

  // `id`: a fixed key instead of push() — two tabs or devices writing the same event land on ONE entry
  const addNotif = useCallback(
    (n: Omit<Notification, "id">, id?: string) => {
      if (!user) return;
      if (DEV_AUTH) {
        setNotifs((prev) => {
          const id = `n${n.at}-${Math.random().toString(36).slice(2, 8)}`;
          const next = [{ id, ...n }, ...prev];
          writeNotifsLocal(next);
          return next;
        });
      } else if (f) {
        if (id) void f.set(f.ref(f.db, `notifications/${user.uid}/${id}`), n);
        else void f.push(f.ref(f.db, `notifications/${user.uid}`), n);
      }
    },
    [f, user],
  );

  // Review alerts share this store. Bump the single unread review notification for a
  // ticker (grouping) instead of stacking a new one each detection cycle.
  const pushReview = useCallback(
    (ticker: string, company: string, newKeys: string[]) => {
      if (!user || !newKeys.length) return;
      const existing = notifsRef.current.find((n) => n.type === "review" && n.ticker === ticker && !n.read);
      if (!existing) {
        addNotif({ type: "review", ticker, company, keys: newKeys, at: Date.now(), read: false });
        return;
      }
      const keys = Array.from(new Set([...(existing.keys ?? []), ...newKeys]));
      const at = Date.now();
      if (DEV_AUTH) {
        setNotifs((prev) => {
          const next = prev.map((n) => (n.id === existing.id ? { ...n, keys, at } : n)).sort((a, b) => b.at - a.at);
          writeNotifsLocal(next);
          return next;
        });
      } else if (f) {
        void f.update(f.ref(f.db, `notifications/${user.uid}/${existing.id}`), { keys, at });
      }
    },
    [f, user, addNotif],
  );

  // "Track this stock" landed: each of this user's own requests (trackreq/<uid>, written by
  // requestTracking) is watched until the shared request flips tracked=true, then notifies
  // ONCE and deletes the user's copy — so a reload or second device never re-notifies.
  // Dev has no backend, so nothing ever lands there.
  const trackedFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (DEV_AUTH || !f || !user) return;
    const d = f.db;
    const subs = new Map<string, () => void>();
    const unList = f.onValue(f.ref(d, `trackreq/${user.uid}`), (snap) => {
      const keys = new Set(Object.keys(snap.val() || {}));
      for (const [k, un] of subs) if (!keys.has(k)) { un(); subs.delete(k); }
      for (const k of keys) {
        if (subs.has(k)) continue;
        subs.set(k, f.onValue(f.ref(d, `trackRequests/${k}/tracked`), (s) => {
          if (s.val() !== true || trackedFiredRef.current.has(k)) return;
          trackedFiredRef.current.add(k); // StrictMode / echo guard until the remove lands
          // that guard is per tab: a second open tab or device also sees tracked=true before the
          // remove lands, and used to push a duplicate. A fixed id makes them write the same entry.
          addNotif({ type: "tracked", ticker: k.replace(/_/g, "."), at: Date.now(), read: false }, `tracked-${k}`);
          void f.remove(f.ref(d, `trackreq/${user.uid}/${k}`));
        }));
      }
    });
    return () => {
      unList();
      for (const un of subs.values()) un();
    };
  }, [f, user, addNotif]);

  // reconcile meta: create for newly-watched tickers (reqs 11 + 12), prune the rest
  useEffect(() => {
    if (!user || !metaLoaded) return;
    for (const t of watchlist) {
      if (!meta[t] && typeof prices[t] === "number") {
        persistMeta(t, { addPx: prices[t], ref: prices[t] });
      }
    }
    for (const t of Object.keys(meta)) {
      if (!watchlist.includes(t)) {
        persistMeta(t, null);
        delete lastFiredPxRef.current[t]; // fresh baseline if it's ever re-added
      }
    }
  }, [user, metaLoaded, watchlist, prices, meta, persistMeta]);

  // fire alerts on the ratchet
  useEffect(() => {
    if (!user || !metaLoaded) return;
    for (const t of watchlist) {
      const m = meta[t];
      const cur = prices[t];
      if (!m || typeof cur !== "number") continue;
      const res = evalAlert(cur, m);
      if (!res) continue;
      // `meta.ref` resets async via Firebase; a not-yet-echoed reset can be reverted by
      // onValue's full-map replace, which let one 7% MU drop fire both a 5% and a 7%
      // alert off the stale ref. Gate on the in-memory last-fire price, which no async
      // write can revert.
      if (reFireSuppressed(cur, lastFiredPxRef.current[t])) continue;
      lastFiredPxRef.current[t] = cur;
      addNotif({ type: "price", ticker: t, dir: res.dir, pct: res.pct, at: Date.now(), read: false });
      persistMeta(t, { addPx: m.addPx, ref: res.newRef });
    }
  }, [user, metaLoaded, watchlist, prices, meta, addNotif, persistMeta]);

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
    if (!f) return;
    const upd: Record<string, boolean> = {};
    for (const n of notifsRef.current) if (!n.read) upd[`${n.id}/read`] = true;
    if (Object.keys(upd).length) void f.update(f.ref(f.db, `notifications/${user.uid}`), upd);
  }, [f, user]);

  const clearAll = useCallback(() => {
    if (!user) return;
    if (DEV_AUTH) {
      writeNotifsLocal([]);
      setNotifs([]);
      return;
    }
    if (!f) return;
    void f.remove(f.ref(f.db, `notifications/${user.uid}`));
  }, [f, user]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  return { notifications, unreadCount, markAllRead, clearAll, pushReview };
}
