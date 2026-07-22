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
import { get, getDatabase, onValue, ref, set, type Database } from "firebase/database";
import { useCallback, useEffect, useRef, useState } from "react";

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
  list: string[];
  toggle: (ticker: string) => void;
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
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [devUser, setDevUser] = useState<User | null>(
    () => (DEV_AUTH && localStorage.getItem(DEV_FLAG) === "1" ? DEV_USER : null),
  );
  const user = DEV_AUTH ? devUser : fbUser;
  // false until Firebase reports the first auth state — lets the UI avoid the
  // "Sign in" flash before a persisted session is restored (dev resolves at once)
  const [authReady, setAuthReady] = useState<boolean>(DEV_AUTH || !auth);
  const [marks, setMarks] = useState<Record<string, MarkEntry>>(() => readMarks());
  const marksRef = useRef(marks);
  marksRef.current = marks;

  // track auth state (real auth only; dev uses the localStorage flag above)
  useEffect(() => {
    if (DEV_AUTH || !auth) return;
    return onAuthStateChanged(auth, (u) => {
      setFbUser(u);
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
        // migrate legacy array -> { ticker: addedAt }
        const now = Date.now();
        const obj: Record<string, number> = {};
        for (const t of v) if (t) obj[t] = now;
        void set(r, obj); // re-fires onValue with the object form
        return;
      }
      const next = v ? Object.keys(v) : [];
      setList(next);
      writeLocal(next); // refresh the boot cache
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
          // per-ticker write storing the date it was added (null removes it) —
          // kept for a future "added on" feature, and avoids clobbering the map
          if (user) void set(ref(db, `watchlist/${user.uid}/${ticker}`), has ? null : Date.now());
        } else {
          writeLocal(next); // local-only when Firebase isn't configured
        }
        return next;
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
      const map: Record<string, number> = {};
      if (Array.isArray(v)) {
        for (const t of v) if (t) map[t] = now;
      } else if (v && typeof v === "object") {
        for (const [t, ts] of Object.entries(v)) map[t] = typeof ts === "number" ? ts : now;
      }
      let changed = Array.isArray(v);
      for (const t of extra) {
        if (!(t in map)) {
          map[t] = now;
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
    if (auth) void fbSignOut(auth);
  }, []);

  return { list, toggle, marks, toggleMark, user, authReady, signIn, signOut, ready: firebaseReady };
}
