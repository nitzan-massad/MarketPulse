// The Firebase SDK, kept out of the main chunk: watchlist.ts import()s this file (`fbP`) only
// after the first render, so the page paints from the localStorage boot caches without parsing
// Firebase first. Only loaded when the config is filled in, so app/auth/db are never null here.
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { firebaseConfig } from "./watchlist";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);
export { FacebookAuthProvider, GoogleAuthProvider, OAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
export { get, onValue, push, ref, remove, serverTimestamp, set, update } from "firebase/database";
