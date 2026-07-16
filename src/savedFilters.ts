import type { User } from "firebase/auth";
import { getDatabase, onValue, ref, set } from "firebase/database";
import { useEffect, useRef } from "react";
import { app, DEV_AUTH } from "./watchlist";

// The toolbar filter state that follows a user around. Signed in -> Realtime
// DB at /filters/<uid> (syncs across devices, same as the watchlist); signed
// out -> this-device localStorage. Requires the matching DB rule:
//   "filters": { "$uid": {
//       ".read":  "auth != null && auth.uid === $uid",
//       ".write": "auth != null && auth.uid === $uid" } }
// Older single-select shape may still be in a user's localStorage/DB; App's
// applyFilters migrates it. Both key sets are optional here so a stale record
// still deserializes without throwing.
export interface SavedFilters {
  q: string;
  sectors?: string[];
  sectorNot: boolean;
  consensuses?: string[];
  cap: number;
  sector?: string; // legacy
  consensus?: string; // legacy
}

// Firebase only when signed in for real; dev/localhost stays on localStorage.
const db = app && !DEV_AUTH ? getDatabase(app) : null;
const LS_KEY = "mp_filters";

function readLocal(): SavedFilters | null {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    return v && typeof v === "object" ? (v as SavedFilters) : null;
  } catch {
    return null;
  }
}

export function useSavedFilters(
  user: User | null,
  filters: SavedFilters,
  onLoad: (f: SavedFilters) => void,
): void {
  // serialized value we last loaded or wrote — guards against the write→read→
  // write loop when a remote/local load triggers the save effect
  const lastSynced = useRef<string>("");
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  // hydrate: signed in -> live remote; otherwise localStorage (once)
  useEffect(() => {
    if (user && db) {
      const r = ref(db, `filters/${user.uid}`);
      return onValue(r, (snap) => {
        const v = snap.val() as SavedFilters | null;
        if (v && typeof v === "object") {
          lastSynced.current = JSON.stringify(v);
          onLoadRef.current(v);
        }
      });
    }
    const local = readLocal();
    if (local) {
      lastSynced.current = JSON.stringify(local);
      onLoadRef.current(local);
    }
  }, [user]);

  // persist on change (skip the value we just loaded)
  useEffect(() => {
    const s = JSON.stringify(filters);
    if (s === lastSynced.current) return;
    lastSynced.current = s;
    try {
      localStorage.setItem(LS_KEY, s);
    } catch {
      /* ignore */
    }
    if (user && db) void set(ref(db, `filters/${user.uid}`), filters).catch(() => {});
  }, [filters, user]);
}
