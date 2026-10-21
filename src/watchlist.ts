import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  FacebookAuthProvider,
  getAuth,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as fbSignOut,
  type Auth,
  type AuthProvider,
  type User,
} from "firebase/auth";
import { get, getDatabase, onValue, ref, set, update, type Database } from "firebase/database";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  keyForAppend,
  moveItem,
  NEW_GAP,
  orderTickers,
  planMove,
  type KeyMap,
} from "./watchlistOrder";

// ---------------------------------------------------------------------------
// Cross-device watchlist — Firebase (Google sign-in + Realtime Database).
// The web config below is PUBLIC by design (safe to ship); real access is
// enforced by Firebase Auth + these DB security rules:
//   { "rules": { "watchlist": { "$uid": {
//       ".read":  "auth != null && auth.uid === $uid",
//       ".write": "auth != null && auth.uid === $uid" } } } }
// Signed in on iPhone + PC with the same Google account => same uid => one
// private list that syncs in realtime. Signed out => this-device localStorage.
// Fill the config from Firebase console → Project settings → your web app.
// ---------------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBt4Dzr9WEbWBZ4ANxuGQhc5gPErmTv2lQ",
  authDomain: "marketpulse-df5d9.firebaseapp.com",
  databaseURL: "https://marketpulse-df5d9-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "marketpulse-df5d9",
  appId: "1:340522045483:web:e1138ff66c1b388aeb1a6e",
  measurementId: "G-D9EJ7NZDEL",
};
export const firebaseReady: boolean =
  firebaseConfig.apiKey.length > 0 && firebaseConfig.databaseURL.length > 0;

export const app: FirebaseApp | null = firebaseReady ? initializeApp(firebaseConfig) : null;
const auth: Auth | null = app ? getAuth(app) : null;
const db: Database | null = app ? getDatabase(app) : null;

// Local dev convenience: on localhost, sign in / out as a throwaway user with no
// real auth and no Firebase writes — watchlist / marks / filters live in
// localStorage instead. Never active on the deployed site.
export const DEV_AUTH =
  typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const DEV_USER = {
  uid: "dev-local", email: "dev@localhost", displayName: "Dev User", photoURL: null,
} as unknown as User;
const DEV_FLAG = "mp_dev_signedin";

// Single source of truth for sign-in providers. Add one line here and its
// button + sign-in flow appear automatically (icon falls back to a monogram if
// none is registered in SignInModal). NOTE: Firebase gives the browser no way
// to read which providers are enabled in the console, so this list is
// authoritative — also enable the matching provider in the Firebase console.
export interface AuthProviderDef {
  id: string; // stable key (also used to pick an icon)
  label: string; // display name
  make: () => AuthProvider; // how to build the Firebase provider
}
export const AUTH_PROVIDERS: AuthProviderDef[] = [
  { id: "google", label: "Google", make: () => new GoogleAuthProvider() },
  { id: "apple", label: "Apple", make: () => new OAuthProvider("apple.com") },
  { id: "facebook", label: "Facebook", make: () => new FacebookAuthProvider() },
];

const LS_KEY = "mp_watchlist";
// The last signed-in account, so a reload paints as signed in at once instead of waiting
// ~1-2s for Firebase to restore (and maybe refresh) its session. Only the public profile
// bits — no token. Firebase's answer always wins: a different/no user replaces it.
const AUTH_LS = "mp_auth_user";
function readAuthHint(): User | null {
  try {
    const v = JSON.parse(localStorage.getItem(AUTH_LS) || "null");
    return v && typeof v.uid === "string" ? (v as User) : null;
  } catch {
    return null;
  }
}
function writeAuthHint(u: User | null): void {
  try {
    if (u) localStorage.setItem(AUTH_LS, JSON.stringify({ uid: u.uid, email: u.email, displayName: u.displayName, photoURL: u.photoURL }));
    else localStorage.removeItem(AUTH_LS);
  } catch {
    /* ignore */
  }
}
function readLocal(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeLocal(list: string[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

// ---- read/liked marks: thumbs up/down a user leaves on a stock ----
export type Mark = "up" | "down";
export interface MarkEntry {
  v: Mark;
  d: number; // marked-at, ms epoch
}

const MARKS_LS = "mp_marks"; // dev / local-only mirror of the marks map
function readMarks(): Record<string, MarkEntry> {
  try {
    const v = JSON.parse(localStorage.getItem(MARKS_LS) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function writeMarks(m: Record<string, MarkEntry>): void {
  try {
    localStorage.setItem(MARKS_LS, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

export interface WatchlistApi {
  /** Display order: oldest-starred first, newest LAST, then whatever dragging says. */
  list: string[];
  toggle: (ticker: string) => void;
  /** Move the row at `from` so it ends up at index `to`. Persists and syncs. */
  reorder: (from: number, to: number) => void;
  marks: Record<string, MarkEntry>;
  toggleMark: (ticker: string, v: Mark) => void; // same v again clears it
  user: User | null;
  authReady: boolean; // has Firebase resolved the persisted session yet?
  signIn: (providerId: string, extra?: string[], mark?: { ticker: string; v: Mark }) => Promise<void>;
  signOut: () => void;
  ready: boolean; // firebase configured?
}

export function useWatchlist(): WatchlistApi {
  // With Firebase configured the list belongs to the account: empty until
  // signed in, and cleared on sign-out (nothing left behind).
  // Seed from localStorage so the last-known list paints on boot instead of
  // flashing empty for ~5s while Firebase restores the session + RTDB connects.
  const [list, setList] = useState<string[]>(() => readLocal());
  // The sort keys behind `list`. Held in a ref, not state, because only `reorder` reads them
  // and re-rendering on a key change would repaint the table for a value nothing displays.
  // Empty in local mode — there the array's own order IS the order (see `reorder`).
  const keysRef = useRef<KeyMap>({});
  // Seeded from the last session's account. The RTDB listeners below can attach with its uid
  // right away: the database SDK waits for Auth to finish restoring before it sends a token,
  // so the fresh data lands as soon as the session is back and simply replaces the cached copy.
  const [fbUser, setFbUser] = useState<User | null>(() => (DEV_AUTH || !auth ? null : readAuthHint()));
  const [devUser, setDevUser] = useState<User | null>(
    () => (DEV_AUTH && localStorage.getItem(DEV_FLAG) === "1" ? DEV_USER : null),
  );
  const user = DEV_AUTH ? devUser : fbUser;
  // false until Firebase reports the first auth state — lets the UI avoid the
  // "Sign in" flash before a persisted session is restored (dev resolves at once)
  const [authReady, setAuthReady] = useState<boolean>(() => DEV_AUTH || !auth || readAuthHint() != null);
  const [marks, setMarks] = useState<Record<string, MarkEntry>>(() => readMarks());
  const marksRef = useRef(marks);
  marksRef.current = marks;

  // track auth state (real auth only; dev uses the localStorage flag above)
  useEffect(() => {
    if (DEV_AUTH || !auth) return;
    return onAuthStateChanged(auth, (u) => {
      writeAuthHint(u);
      // same account as the hint: keep the object, so nothing re-subscribes or repaints
      setFbUser((prev) => (u && prev && prev.uid === u.uid && prev.photoURL === u.photoURL && prev.email === u.email ? prev : u));
      setAuthReady(true);
    });
  }, []);

  // read/liked marks: live remote when signed in, empty when signed out
  useEffect(() => {
    if (DEV_AUTH) {
      setMarks(user ? readMarks() : {});
      return;
    }
    if (!db) return;
    if (!user) {
      if (authReady) setMarks({}); // only clear once auth is confirmed signed-out
      return;
    }
    const r = ref(db, `marks/${user.uid}`);
    return onValue(r, (snap) => {
      const m = (snap.val() as Record<string, MarkEntry>) || {};
      setMarks(m);
      writeMarks(m); // refresh the boot cache
    });
  }, [user, authReady]);

  // pressing a thumb: same value again clears it, otherwise set it with today's date
  const toggleMark = useCallback(
    (ticker: string, v: Mark) => {
      if (!user) return; // marks require an account
      const cur = marksRef.current[ticker];
      if (DEV_AUTH) {
        const next = { ...marksRef.current };
        if (cur?.v === v) delete next[ticker];
        else next[ticker] = { v, d: Date.now() };
        writeMarks(next);
        setMarks(next);
        return;
      }
      if (!db) return;
      void set(ref(db, `marks/${user.uid}/${ticker}`), cur?.v === v ? null : { v, d: Date.now() });
    },
    [user],
  );

  // drive the list from auth: signed in -> realtime remote; signed out -> empty
  useEffect(() => {
    if (DEV_AUTH) {
      setList(user ? readLocal() : []);
      return;
    }
    if (!db) return;
    if (!user) {
      // signed out: clear so a previous account's list isn't left behind — but
      // only once auth is confirmed, else we'd wipe the optimistic boot paint.
      if (authReady) setList([]);
      return;
    }
    const r = ref(db, `watchlist/${user.uid}`);
    const unsub = onValue(r, (snap) => {
      const v = snap.val();
      if (Array.isArray(v)) {
        // migrate legacy array -> { ticker: sortKey }. Keys are SPREAD, not all stamped with
        // one Date.now(): identical keys make the whole list one tie, and a tie is broken by
        // ticker, so the user's original order would silently become alphabetical.
        const now = Date.now();
        const obj: KeyMap = {};
        v.forEach((t, i) => {
          if (t) obj[t] = now + i * NEW_GAP;
        });
        void set(r, obj); // re-fires onValue with the object form
        return;
      }
      const map: KeyMap = {};
      if (v && typeof v === "object") for (const [t, k] of Object.entries(v)) map[t] = typeof k === "number" ? k : 0;
      keysRef.current = map;
      // Object.keys() order is RTDB's (lexicographic for string keys), which is why the
      // watchlist used to be alphabetical-ish rather than in the order it was built.
      const next = orderTickers(map);
      setList(next);
      writeLocal(next); // refresh the boot cache, in display order
    });
    return () => unsub();
  }, [user, authReady]);

  const toggle = useCallback(
    (ticker: string) => {
      setList((prev) => {
        const has = prev.includes(ticker);
        const next = has ? prev.filter((t) => t !== ticker) : [...prev, ticker];
        if (DEV_AUTH) {
          if (user) writeLocal(next);
        } else if (db) {
          // Per-ticker write (null removes it) so a concurrent star from another device
          // can't be clobbered. The number is the SORT KEY — seeded from the add time, which
          // is what puts a newly starred stock at the BOTTOM of the list, and rewritten by
          // `reorder` when the row is dragged. See watchlistOrder.ts.
          if (user) {
            const key = has ? null : keyForAppend(keysRef.current, Date.now());
            if (key != null) keysRef.current = { ...keysRef.current, [ticker]: key };
            else { const k = { ...keysRef.current }; delete k[ticker]; keysRef.current = k; }
            void set(ref(db, `watchlist/${user.uid}/${ticker}`), key);
          }
        } else {
          writeLocal(next); // local-only when Firebase isn't configured
        }
        return next;
      });
    },
    [user],
  );

  // Drag-to-reorder. One write in the common case: the dragged row's key becomes the
  // midpoint of its new neighbours', so list length doesn't affect sync cost. When a gap
  // runs out of room, planMove returns a full respacing instead — see watchlistOrder.ts.
  const reorder = useCallback(
    (from: number, to: number) => {
      setList((prev) => {
        if (from === to || from < 0 || from >= prev.length) return prev;
        const next = moveItem(prev, from, to);
        if (DEV_AUTH || !db || !user) {
          // Local mode: the stored array's own order is the order, so a splice IS the write.
          if (!db || DEV_AUTH) writeLocal(next);
          return next;
        }
        const plan = planMove(prev, keysRef.current, from, to);
        if (plan.kind === "key") {
          keysRef.current = { ...keysRef.current, [plan.ticker]: plan.key };
          void set(ref(db, `watchlist/${user.uid}/${plan.ticker}`), plan.key);
        } else if (plan.kind === "renumber") {
          keysRef.current = plan.keys;
          // update(), not set(): a star added on another device between our read and this
          // write is a key we don't have, and set() would delete it.
          void update(ref(db, `watchlist/${user.uid}`), plan.keys);
        }
        writeLocal(next);
        return next; // optimistic — onValue confirms, and agrees because keysRef matched
      });
    },
    [user],
  );

  const signIn = useCallback(
    async (providerId: string, extra: string[] = [], mark?: { ticker: string; v: Mark }) => {
      // Dev: become the throwaway user, no popup. Persist any pending mark/tracks
      // to localStorage first so the effects load them when devUser flips on.
      if (DEV_AUTH) {
        if (mark) {
          const m = readMarks();
          m[mark.ticker] = { v: mark.v, d: Date.now() };
          writeMarks(m);
        }
        if (extra.length) {
          const l = readLocal();
          for (const t of extra) if (!l.includes(t)) l.push(t);
          writeLocal(l);
        }
        localStorage.setItem(DEV_FLAG, "1");
        setDevUser(DEV_USER);
        return;
      }
      if (!auth || !db) return;
      const def = AUTH_PROVIDERS.find((p) => p.id === providerId);
      if (!def) return;
      const res = await signInWithPopup(auth, def.make());
      // apply a thumb pressed while signed out (write against the resolved uid so
      // it doesn't race the auth-state / marks subscription)
      if (mark) await set(ref(db, `marks/${res.user.uid}/${mark.ticker}`), { v: mark.v, d: Date.now() });
      // merge a pending star (clicked while signed out); also normalise a legacy
      // array to the { ticker: addedAt } map
      const r = ref(db, `watchlist/${res.user.uid}`);
      const v = (await get(r)).val();
      const now = Date.now();
      const map: KeyMap = {};
      if (Array.isArray(v)) {
        // spread, not one shared `now` — see the migration note in the onValue handler
        v.forEach((t, i) => {
          if (t) map[t] = now + i * NEW_GAP;
        });
      } else if (v && typeof v === "object") {
        for (const [t, ts] of Object.entries(v)) map[t] = typeof ts === "number" ? ts : now;
      }
      let changed = Array.isArray(v);
      for (const t of extra) {
        if (!(t in map)) {
          map[t] = keyForAppend(map, now); // a star pressed while signed out still lands last
          changed = true;
        }
      }
      if (changed) await set(r, map);
    },
    [],
  );

  const signOut = useCallback(() => {
    if (DEV_AUTH) {
      localStorage.removeItem(DEV_FLAG);
      setDevUser(null);
      return;
    }
    writeLocal([]); // drop the boot cache so a signed-out reload paints empty
    writeMarks({});
    writeAuthHint(null);
    if (auth) void fbSignOut(auth);
  }, []);

  return { list, toggle, reorder, marks, toggleMark, user, authReady, signIn, signOut, ready: firebaseReady };
}

// ---------------------------------------------------------------------------
// "Track this stock" — a signed-in user asks CI to add an off-universe ticker.
// RTDB `trackRequests/<KEY>` = { uid, ts, tracked:false }; ci/track-requests.mjs pins it
// and flips tracked=true once its row ships. Keys can't hold ".", so BRK.B is BRK_B.
// `trackreq/<uid>/<KEY>` is the requester's own copy: useNotifications watches it and
// posts the one-time "now tracked" notification, then deletes it.
// ---------------------------------------------------------------------------
export type TrackRequestState = "none" | "pending" | "tracked";
// worker/ — starts the lite track-requests.yml run at once. Empty => the 5h run picks it up.
// Never called from a dev build (`npm run dev`), even one signed in against real Firebase.
const TRACK_WORKER_URL = "https://marketpulse-track.nitzanmassad.workers.dev";
export const trackKey = (t: string) => t.replace(/\./g, "_");
// Dev: no backend, so requests live in localStorage and the card listens for this event.
const DEV_REQ_LS = "mp_dev_trackreq";
const devRequests = new Set<string>(DEV_AUTH ? (() => { try { return JSON.parse(localStorage.getItem(DEV_REQ_LS) || "[]"); } catch { return []; } })() : []);
const DEV_REQ_EVENT = "mp-trackreq";

export function requestTracking(ticker: string, user: User): void {
  const key = trackKey(ticker);
  if (DEV_AUTH || !db) {
    devRequests.add(key);
    try { localStorage.setItem(DEV_REQ_LS, JSON.stringify([...devRequests])); } catch { /* ignore */ }
    window.dispatchEvent(new Event(DEV_REQ_EVENT));
    return;
  }
  void set(ref(db, `trackreq/${user.uid}/${key}`), Date.now());
  set(ref(db, `trackRequests/${key}`), { uid: user.uid, ts: Date.now(), tracked: false })
    .then(() => { if (TRACK_WORKER_URL && import.meta.env.PROD) void fetch(TRACK_WORKER_URL, { method: "POST" }).catch(() => {}); })
    .catch(() => { /* someone already requested it — the listener shows its state */ });
}

export function useTrackRequest(ticker: string, user: User | null): TrackRequestState {
  const [state, setState] = useState<TrackRequestState>("none");
  const key = trackKey(ticker);
  useEffect(() => {
    setState("none");
    if (!user) return;
    if (DEV_AUTH || !db) {
      const sync = () => setState(devRequests.has(key) ? "pending" : "none");
      sync();
      window.addEventListener(DEV_REQ_EVENT, sync);
      return () => window.removeEventListener(DEV_REQ_EVENT, sync);
    }
    return onValue(
      ref(db, `trackRequests/${key}`),
      (s) => setState(!s.exists() ? "none" : s.val().tracked ? "tracked" : "pending"),
      () => setState("none"),
    );
  }, [key, user]);
  return state;
}
