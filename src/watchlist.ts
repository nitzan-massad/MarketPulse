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
import { useCallback, useEffect, useState } from "react";

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
};
export const firebaseReady: boolean =
  firebaseConfig.apiKey.length > 0 && firebaseConfig.databaseURL.length > 0;

const app: FirebaseApp | null = firebaseReady ? initializeApp(firebaseConfig) : null;
const auth: Auth | null = app ? getAuth(app) : null;
const db: Database | null = app ? getDatabase(app) : null;

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

export interface WatchlistApi {
  list: string[];
  toggle: (ticker: string) => void;
  user: User | null;
  signIn: (providerId: string, extra?: string[]) => Promise<void>;
  signOut: () => void;
  ready: boolean; // firebase configured?
}

export function useWatchlist(): WatchlistApi {
  // With Firebase configured the list belongs to the account: empty until
  // signed in, and cleared on sign-out (nothing left behind). Only the
  // no-Firebase dev fallback uses localStorage.
  const [list, setList] = useState<string[]>(() => (firebaseReady ? [] : readLocal()));
  const [user, setUser] = useState<User | null>(null);

  // track auth state
  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  // drive the list from auth: signed in -> realtime remote; signed out -> empty
  useEffect(() => {
    if (!db) return; // no Firebase -> local-only mode, leave the list as-is
    if (!user) {
      setList([]); // signed out: clear so a previous account's list isn't left behind
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
      setList(v ? Object.keys(v) : []);
    });
    return () => unsub();
  }, [user]);

  const toggle = useCallback(
    (ticker: string) => {
      setList((prev) => {
        const has = prev.includes(ticker);
        const next = has ? prev.filter((t) => t !== ticker) : [...prev, ticker];
        if (db) {
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

  const signIn = useCallback(async (providerId: string, extra: string[] = []) => {
    if (!auth || !db) return;
    const def = AUTH_PROVIDERS.find((p) => p.id === providerId);
    if (!def) return;
    const res = await signInWithPopup(auth, def.make());
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
  }, []);

  const signOut = useCallback(() => {
    if (auth) void fbSignOut(auth);
  }, []);

  return { list, toggle, user, signIn, signOut, ready: firebaseReady };
}
