// The Firebase SDK, kept out of the main chunk: watchlist.ts import()s this file (`fbP`) only
// after the first render, so the page paints from the localStorage boot caches without parsing
// Firebase first. Only loaded when the config is filled in, so app/auth/db are never null here.
import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  indexedDBLocalPersistence,
  initializeAuth,
} from "firebase/auth";
import { getDatabase } from "firebase/database";
import { AUTH_LS, firebaseConfig } from "./watchlist";

export const app = initializeApp(firebaseConfig);
// getAuth() with its defaults, minus the popup helper for a returning user: on iOS / Safari auth
// won't restore the session until Google's sign-in iframe has loaded, and RTDB waits on auth —
// that held the first notifications snapshot back by ~0.4-1.5s. signIn passes the resolver itself.
// ponytail: signing out and back in without a reload loads the helper inside the tap, which iOS
// can treat as a blocked popup (a second tap works); preload it on the sign-in menu if that bites.
const signedInBefore = (() => {
  try {
    return localStorage.getItem(AUTH_LS) != null;
  } catch {
    return false;
  }
})();
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
  ...(signedInBefore ? {} : { popupRedirectResolver: browserPopupRedirectResolver }),
});
export const db = getDatabase(app);
export { browserPopupRedirectResolver, FacebookAuthProvider, GoogleAuthProvider, OAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
export { get, onValue, push, ref, remove, serverTimestamp, set, update } from "firebase/database";
