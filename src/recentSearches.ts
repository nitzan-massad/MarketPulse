import type { User } from "firebase/auth";
import { useEffect, useState } from "react";
import { DEV_AUTH, useFb } from "./watchlist";
import { pushRecent } from "./searchNav";

// The last 5 tickers picked in the header search. Signed in -> Realtime DB at
// /recent/<uid> (follows the user across devices); signed out -> this-device localStorage.
// ponytail: last write wins across devices; no merge of the signed-out list on sign-in.
const LS_KEY = "mp_recent";

const clean = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((t): t is string => typeof t === "string").slice(0, 5) : [];

function readLocal(): string[] {
  try {
    return clean(JSON.parse(localStorage.getItem(LS_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function useRecentSearches(user: User | null): [string[], (ticker: string) => void] {
  const fb = useFb();
  const f = DEV_AUTH ? null : fb;
  const [list, setList] = useState<string[]>(readLocal);

  useEffect(() => {
    if (!user || !f) {
      setList(readLocal());
      return;
    }
    return f.onValue(f.ref(f.db, `recent/${user.uid}`), (snap) => setList(clean(snap.val())));
  }, [f, user]);

  const push = (ticker: string) => {
    const next = pushRecent(list, ticker);
    setList(next);
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    if (user && f) void f.set(f.ref(f.db, `recent/${user.uid}`), next).catch(() => {});
  };
  return [list, push];
}
