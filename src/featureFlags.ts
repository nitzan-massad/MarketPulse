// Feature flags for a static site with no backend.
//
// `?ff=feed` turns a flag on and remembers it; `?ff=-feed` turns it off. That is the entire
// mechanism — this app deploys to GitHub Pages and has no server to ask, so a flag service
// is not an option. Good enough to keep an unfinished section out of everyone's way, and to
// hand a reviewer a link that switches it on.
//
// ponytail: URL + localStorage, per-browser. If a flag ever needs to follow a user across
// devices, it moves to the Firebase RTDB path the watchlist already uses.

export const FLAGS_LS = "mp:ff";

/** Pure core: current query string + whatever was stored -> the active flag list. */
export function resolveFlags(search: string, stored: string | null): string[] {
  const active = new Set<string>();

  try {
    const parsed: unknown = JSON.parse(stored ?? "[]");
    if (Array.isArray(parsed)) {
      for (const f of parsed) if (typeof f === "string" && f.trim()) active.add(f.trim());
    }
  } catch {
    // A corrupt value means no flags, never a crash on boot.
  }

  const raw = new URLSearchParams(search).get("ff");
  if (raw) {
    for (const part of raw.split(",")) {
      const name = part.trim();
      if (!name || name === "-") continue;
      if (name.startsWith("-")) active.delete(name.slice(1).trim());
      else active.add(name);
    }
  }

  return [...active].sort();
}

/** Impure wrapper. Reads the URL and storage, writes the merged set back, never throws —
 *  a blocked or full localStorage must not stop the app rendering. */
export function flagOn(name: string): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FLAGS_LS);
  } catch {
    /* private window, blocked storage */
  }

  const flags = resolveFlags(typeof location === "undefined" ? "" : location.search, stored);

  try {
    localStorage.setItem(FLAGS_LS, JSON.stringify(flags));
  } catch {
    /* over quota or blocked — the flag still applies for this page load */
  }

  return flags.includes(name);
}
