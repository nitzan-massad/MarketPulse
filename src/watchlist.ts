import type { AuthProvider, User } from "firebase/auth";
import { WORKER_URL } from "./workerUrl";
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
export const firebaseConfig = {
  apiKey: "AIzaSyBt4Dzr9WEbWBZ4ANxuGQhc5gPErmTv2lQ",
  authDomain: "marketpulse-df5d9.firebaseapp.com",
  databaseURL: "https://marketpulse-df5d9-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "marketpulse-df5d9",
  appId: "1:340522045483:web:e1138ff66c1b388aeb1a6e",
  measurementId: "G-D9EJ7NZDEL",
};
export const firebaseReady: boolean =
  firebaseConfig.apiKey.length > 0 && firebaseConfig.databaseURL.length > 0;


// The SDK itself (./firebase.ts) is a separate chunk, loaded only after the first render: App's
// first effect calls loadFirebase(). Everything below reads it through `fbP` (outside React) or
// `useFb()` (null until it lands, then a re-render). null for good if the config is empty or the
// chunk fails to load (offline) — same as "Firebase not configured".
export type Fb = typeof import("./firebase");
let startFb!: () => void;
const rendered = new Promise<void>((r) => (startFb = r));
export const loadFirebase = (): void => startFb();
export const fbP: Promise<Fb | null> = firebaseReady
  ? rendered.then(() => import("./firebase")).catch(() => null)
  : Promise.resolve(null);
let fbNow: Fb | null = null;
void fbP.then((f) => (fbNow = f));
export function useFb(): Fb | null {
  const [f, setF] = useState(fbNow);
  useEffect(() => {
    if (!f) void fbP.then(setF);
  }, [f]);
  return f;
}

// Local dev convenience: on localhost, sign in / out as a throwaway user with no
// real auth and no Firebase writes — watchlist / marks / filters live in
// localStorage instead. Never active on the deployed site.
export const DEV_AUTH =
  typeof location !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
// "Track this stock" rows the lite run published but no deploy has bundled yet (stocks.ts merges
// them). A LIVE listener on this same db, so it rides the websocket auth already opens: a stock the
// lite run publishes while the page is open (or its window is) fills in without a reload. Publicly
// readable, so no sign-in needed. `cb(raw)` fires once Firebase loads and on every change; a failure
// (or no Firebase) fires cb(null) once → stocks.json only.
// Localhost (DEV_AUTH: no Firebase traffic in dev): cb(null) now, then whatever
// `window.__mpTrackedRows(raw)` is handed in the console — the way to try the flow locally.
export function onTrackedRows(cb: (raw: unknown) => void): void {
  if (DEV_AUTH) {
    cb(null);
    (window as unknown as { __mpTrackedRows: (raw: unknown) => void }).__mpTrackedRows = cb;
    return;
  }
  void fbP.then((f) => {
    if (!f) return cb(null);
    f.onValue(f.ref(f.db, "trackedRows"), (s) => cb(s.val()), () => cb(null));
  });
}

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
  make: (f: Fb) => AuthProvider; // how to build the Firebase provider (SDK passed in, it's lazy)
}
export const AUTH_PROVIDERS: AuthProviderDef[] = [
  { id: "google", label: "Google", make: (f) => new f.GoogleAuthProvider() },
  { id: "apple", label: "Apple", make: (f) => new f.OAuthProvider("apple.com") },
  { id: "facebook", label: "Facebook", make: (f) => new f.FacebookAuthProvider() },
];

const LS_KEY = "mp_watchlist";
// The last signed-in account, so a reload paints as signed in at once instead of waiting
// ~1-2s for Firebase to restore (and maybe refresh) its session. Only the public profile
// bits — no token. Firebase's answer always wins: a different/no user replaces it.
export const AUTH_LS = "mp_auth_user";
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
  const f = useFb();
  // With Firebase configured the list belongs to the account: empty until
  // signed in, and cleared on sign-out (nothing left behind).
  // Seed from localStorage so the last-known list paints on boot instead of
  // flashing empty for ~5s while Firebase restores the session + RTDB connects.
  const [list, setList] = useState<string[]>(() => readLocal());
  // The sort keys behind `list`. Held in a ref, not state, because only `reorder` reads them
  // and re-rendering on a key change would repaint the table for a value nothing displays.
  // Empty in local mode — there the array's own order IS the order (see `reorder`).
  const keysRef = useRef<KeyMap>({});
  // Stars clicked before the SDK lands: ticker -> starred?, replayed onto the first remote
  // snapshot (net state, so a star + unstar cancels out).
  const pendingRef = useRef<Map<string, boolean>>(new Map());
  // Seeded from the last session's account. The RTDB listeners below can attach with its uid
  // right away: the database SDK waits for Auth to finish restoring before it sends a token,
  // so the fresh data lands as soon as the session is back and simply replaces the cached copy.
  const [fbUser, setFbUser] = useState<User | null>(() => (DEV_AUTH || !firebaseReady ? null : readAuthHint()));
  const [devUser, setDevUser] = useState<User | null>(
    () => (DEV_AUTH && localStorage.getItem(DEV_FLAG) === "1" ? DEV_USER : null),
  );
  const user = DEV_AUTH ? devUser : fbUser;
  // false until Firebase reports the first auth state — lets the UI avoid the
  // "Sign in" flash before a persisted session is restored (dev resolves at once)
  const [authReady, setAuthReady] = useState<boolean>(() => DEV_AUTH || !firebaseReady || readAuthHint() != null);
  const [marks, setMarks] = useState<Record<string, MarkEntry>>(() => readMarks());
  const marksRef = useRef(marks);
  marksRef.current = marks;

  // track auth state (real auth only; dev uses the localStorage flag above)
  useEffect(() => {
    if (DEV_AUTH || !f) return;
    return f.onAuthStateChanged(f.auth, (u) => {
      writeAuthHint(u);
      // same account as the hint: keep the object, so nothing re-subscribes or repaints
      setFbUser((prev) => (u && prev && prev.uid === u.uid && prev.photoURL === u.photoURL && prev.email === u.email ? prev : u));
      setAuthReady(true);
    });
  }, [f]);

  // read/liked marks: live remote when signed in, empty when signed out
  useEffect(() => {
    if (DEV_AUTH) {
      setMarks(user ? readMarks() : {});
      return;
    }
    if (!f) return;
    if (!user) {
      if (authReady) setMarks({}); // only clear once auth is confirmed signed-out
      return;
    }
    const r = f.ref(f.db, `marks/${user.uid}`);
    return f.onValue(r, (snap) => {
      const m = (snap.val() as Record<string, MarkEntry>) || {};
      setMarks(m);
      writeMarks(m); // refresh the boot cache
    });
  }, [f, user, authReady]);

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
      if (!f) return;
      void f.set(f.ref(f.db, `marks/${user.uid}/${ticker}`), cur?.v === v ? null : { v, d: Date.now() });
    },
    [f, user],
  );

  // drive the list from auth: signed in -> realtime remote; signed out -> empty
  useEffect(() => {
    if (DEV_AUTH) {
      setList(user ? readLocal() : []);
      return;
    }
    if (!f) return;
    if (!user) {
      // signed out: clear so a previous account's list isn't left behind — but
      // only once auth is confirmed, else we'd wipe the optimistic boot paint.
      if (authReady) {
        setList([]);
        pendingRef.current.clear(); // nobody to save them for
      }
      return;
    }
    const r = f.ref(f.db, `watchlist/${user.uid}`);
    const unsub = f.onValue(r, (snap) => {
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
        void f.set(r, obj); // re-fires onValue with the object form
        return;
      }
      const map: KeyMap = {};
      if (v && typeof v === "object") for (const [t, k] of Object.entries(v)) map[t] = typeof k === "number" ? k : 0;
      for (const [t, want] of pendingRef.current) {
        if (want === t in map) continue;
        const key = want ? keyForAppend(map, Date.now()) : null;
        if (key != null) map[t] = key;
        else delete map[t];
        void f.set(f.ref(f.db, `watchlist/${user.uid}/${t}`), key); // re-fires onValue, agreeing
      }
      pendingRef.current.clear();
      keysRef.current = map;
      // Object.keys() order is RTDB's (lexicographic for string keys), which is why the
      // watchlist used to be alphabetical-ish rather than in the order it was built.
      const next = orderTickers(map);
      setList(next);
      writeLocal(next); // refresh the boot cache, in display order
    });
    return () => unsub();
  }, [f, user, authReady]);

  const toggle = useCallback(
    (ticker: string) => {
      setList((prev) => {
        const has = prev.includes(ticker);
        const next = has ? prev.filter((t) => t !== ticker) : [...prev, ticker];
        if (DEV_AUTH) {
          if (user) writeLocal(next);
        } else if (f) {
          // Per-ticker write (null removes it) so a concurrent star from another device
          // can't be clobbered. The number is the SORT KEY — seeded from the add time, which
          // is what puts a newly starred stock at the BOTTOM of the list, and rewritten by
          // `reorder` when the row is dragged. See watchlistOrder.ts.
          if (user) {
            const key = has ? null : keyForAppend(keysRef.current, Date.now());
            if (key != null) keysRef.current = { ...keysRef.current, [ticker]: key };
            else { const k = { ...keysRef.current }; delete k[ticker]; keysRef.current = k; }
            void f.set(f.ref(f.db, `watchlist/${user.uid}/${ticker}`), key);
          }
        } else {
          // local-only when Firebase isn't configured — or not loaded yet, in which case the
          // click is queued and written once the signed-in user's list arrives
          pendingRef.current.set(ticker, !has);
          writeLocal(next);
        }
        return next;
      });
    },
    [f, user],
  );

  // Drag-to-reorder. One write in the common case: the dragged row's key becomes the
  // midpoint of its new neighbours', so list length doesn't affect sync cost. When a gap
  // runs out of room, planMove returns a full respacing instead — see watchlistOrder.ts.
  const reorder = useCallback(
    (from: number, to: number) => {
      setList((prev) => {
        if (from === to || from < 0 || from >= prev.length) return prev;
        const next = moveItem(prev, from, to);
        if (DEV_AUTH || !f || !user) {
          // Local mode: the stored array's own order is the order, so a splice IS the write.
          if (!f || DEV_AUTH) writeLocal(next);
          return next;
        }
        const plan = planMove(prev, keysRef.current, from, to);
        if (plan.kind === "key") {
          keysRef.current = { ...keysRef.current, [plan.ticker]: plan.key };
          void f.set(f.ref(f.db, `watchlist/${user.uid}/${plan.ticker}`), plan.key);
        } else if (plan.kind === "renumber") {
          keysRef.current = plan.keys;
          // update(), not set(): a star added on another device between our read and this
          // write is a key we don't have, and set() would delete it.
          void f.update(f.ref(f.db, `watchlist/${user.uid}`), plan.keys);
        }
        writeLocal(next);
        return next; // optimistic — onValue confirms, and agrees because keysRef matched
      });
    },
    [f, user],
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
      const fb = f ?? (await fbP); // clicked before the SDK landed: wait for it
      if (!fb) return;
      const def = AUTH_PROVIDERS.find((p) => p.id === providerId);
      if (!def) return;
      const res = await fb.signInWithPopup(fb.auth, def.make(fb), fb.browserPopupRedirectResolver);
      // apply a thumb pressed while signed out (write against the resolved uid so
      // it doesn't race the auth-state / marks subscription)
      if (mark) await fb.set(fb.ref(fb.db, `marks/${res.user.uid}/${mark.ticker}`), { v: mark.v, d: Date.now() });
      // merge a pending star (clicked while signed out); also normalise a legacy
      // array to the { ticker: addedAt } map
      const r = fb.ref(fb.db, `watchlist/${res.user.uid}`);
      const v = (await fb.get(r)).val();
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
      if (changed) await fb.set(r, map);
    },
    [f],
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
    void fbP.then((fb) => fb && fb.signOut(fb.auth));
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
export const trackKey = (t: string) => t.replace(/\./g, "_");
// Dev: no backend, so requests live in localStorage and the card listens for this event.
const DEV_REQ_LS = "mp_dev_trackreq";
const devRequests = new Set<string>(DEV_AUTH ? (() => { try { return JSON.parse(localStorage.getItem(DEV_REQ_LS) || "[]"); } catch { return []; } })() : []);
const DEV_REQ_EVENT = "mp-trackreq";

// "Last viewed" per ticker, by ANY visitor (signed in or not): `views/<KEY>` = server time.
// ci/track-requests.mjs snapshots it into keepalive.json, and computeKeep won't drop a stock
// opened within VIEW_KEEP_DAYS. Prod only, like analytics.
// ponytail: unauthenticated writes, so anyone can keep a ticker alive by spamming opens — the
// rule pins the value to `now`, so that is the whole blast radius.
export function noteView(ticker: string): void {
  if (DEV_AUTH || !import.meta.env.PROD) return;
  void fbP.then((f) => f?.set(f.ref(f.db, `views/${trackKey(ticker)}`), f.serverTimestamp()).catch(() => { /* rules not deployed yet / offline */ }));
}

export async function requestTracking(ticker: string, user: User): Promise<void> {
  const key = trackKey(ticker);
  const f = DEV_AUTH ? null : await fbP;
  if (!f) {
    devRequests.add(key);
    try { localStorage.setItem(DEV_REQ_LS, JSON.stringify([...devRequests])); } catch { /* ignore */ }
    window.dispatchEvent(new Event(DEV_REQ_EVENT));
    return;
  }
  void f.set(f.ref(f.db, `trackreq/${user.uid}/${key}`), Date.now());
  f.set(f.ref(f.db, `trackRequests/${key}`), { uid: user.uid, ts: Date.now(), tracked: false })
    // worker/ starts the lite track-requests.yml run at once (else the 5h run picks it up).
    // Never from a dev build (`npm run dev`), even one signed in against real Firebase.
    .then(() => { if (import.meta.env.PROD) void fetch(WORKER_URL, { method: "POST" }).catch(() => {}); })
    .catch(() => { /* someone already requested it — the listener shows its state */ });
}

export function useTrackRequest(ticker: string, user: User | null): TrackRequestState {
  const [state, setState] = useState<TrackRequestState>("none");
  const f = useFb();
  const key = trackKey(ticker);
  useEffect(() => {
    setState("none");
    if (!user) return;
    if (DEV_AUTH || !f) {
      const sync = () => setState(devRequests.has(key) ? "pending" : "none");
      sync();
      window.addEventListener(DEV_REQ_EVENT, sync);
      return () => window.removeEventListener(DEV_REQ_EVENT, sync);
    }
    return f.onValue(
      f.ref(f.db, `trackRequests/${key}`),
      (s) => setState(!s.exists() ? "none" : s.val().tracked ? "tracked" : "pending"),
      () => setState("none"),
    );
  }, [f, key, user]);
  return state;
}
