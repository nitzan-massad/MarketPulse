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
// RTDB may hand back an array or an object of keys; normalise to string[]
function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (v && typeof v === "object") return Object.keys(v as Record<string, unknown>);
  return [];
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
  const [list, setList] = useState<string[]>(() => readLocal());
  const [user, setUser] = useState<User | null>(null);

  // track auth state
  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  // when signed in, subscribe to this user's list in realtime
  useEffect(() => {
    if (!db || !user) return; // signed out -> localStorage only
    const r = ref(db, `watchlist/${user.uid}`);
    const unsub = onValue(r, (snap) => {
      const arr = toList(snap.val());
      setList(arr);
      writeLocal(arr);
    });
    return () => unsub();
  }, [user]);

  const toggle = useCallback(
    (ticker: string) => {
      setList((prev) => {
        const next = prev.includes(ticker)
          ? prev.filter((t) => t !== ticker)
          : [...prev, ticker];
        writeLocal(next);
        if (db && user) void set(ref(db, `watchlist/${user.uid}`), next);
        return next;
      });
    },
    [user],
  );

  const signIn = useCallback(async (providerId: string, extra: string[] = []) => {
    if (!auth || !db) return;
    const def = AUTH_PROVIDERS.find((p) => p.id === providerId);
    if (!def) return;
    const local = readLocal();
    const res = await signInWithPopup(auth, def.make());
    // merge any device-local list + a pending star (clicked while signed out)
    // into the account on sign-in
    const r = ref(db, `watchlist/${res.user.uid}`);
    const snap = await get(r);
    const remote = toList(snap.val());
    const union = Array.from(new Set([...remote, ...local, ...extra]));
    if (union.length !== remote.length) await set(r, union);
  }, []);

  const signOut = useCallback(() => {
    if (auth) void fbSignOut(auth);
  }, []);

  return { list, toggle, user, signIn, signOut, ready: firebaseReady };
}
