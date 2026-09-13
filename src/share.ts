// Sharing a stock as a deep link, plus the random pick for the copy animation.
//
// Dependency-free on purpose — no React, no Firebase, and deliberately NO `import.meta`:
// ci/run-tests.mjs compiles src/*.check.ts with `--module commonjs`, where `import.meta`
// is a hard compile error. That is why `buildShareUrl` takes `origin` and `base` as
// arguments instead of reading `location` / `import.meta.env.BASE_URL` itself; the two
// call sites pass them in. See share.check.ts.
//
// The link is a HASH (`…/MarketPulse/#AAPL`) rather than a path or a query. On GitHub
// Pages a path like /MarketPulse/AAPL is a 404 — there is no server to rewrite it — and a
// query string still costs `?t=`. The hash is the shortest form that a static host can
// serve, and it never reaches the network at all.

/** Longest hash we will even look at. Real symbols are <= 5 chars (+ a `.X` share class). */
export const TICKER_MAX = 7;

// A symbol starts with a letter, is at most TICKER_MAX chars, and may carry a single
// share-class suffix (BRK.B). Digits are allowed after the first character.
//
// This is a whitelist, not a sanity filter: the app owns the whole hash space, and
// rejecting anything that isn't symbol-shaped is what stops an unrelated `#section-2`
// or a stray `#` from opening a "No data" modal on page load.
const TICKER_RE = /^[A-Za-z][A-Za-z0-9]{0,4}(\.[A-Za-z]{1,2})?$/;

/** Uppercase + trim a symbol. Returns "" for anything that isn't symbol-shaped. */
export function normalizeTicker(raw: string | null | undefined): string {
  const t = (raw ?? "").trim();
  if (!t || t.length > TICKER_MAX || !TICKER_RE.test(t)) return "";
  return t.toUpperCase();
}

// ---- what a link can point at ---------------------------------------------
// Two kinds, and the split matters for back-compatibility: a ticker keeps the bare
// `#AAPL` form it has always had, so every link already in the wild still resolves.
// Anything else is namespaced behind a sigil that TICKER_RE can never match (it demands
// a leading letter), which is what stops a panel link and a symbol link from colliding.
export const PANEL_SIGIL = "!";

/** Panels that can be deep-linked. A whitelist, for the same reason TICKER_RE is one. */
export const PANELS = ["feargreed"] as const;
export type PanelId = (typeof PANELS)[number];

export type ShareTarget =
  | { kind: "ticker"; id: string }
  | { kind: "panel"; id: PanelId };

export const tickerTarget = (id: string): ShareTarget => ({ kind: "ticker", id });
export const panelTarget = (id: PanelId): ShareTarget => ({ kind: "panel", id });

/**
 * The shareable URL for a target.
 * `base` is Vite's BASE_URL — "/" in dev, "/MarketPulse/" in the production build — so the
 * same code produces a working link in both. A target we can't normalize yields the bare
 * app URL rather than a link to a modal that would open empty.
 */
export function buildShareUrl(target: ShareTarget, origin: string, base: string): string {
  const root = origin.replace(/\/+$/, "");
  const b = base.startsWith("/") ? base : "/" + base;
  const path = b.endsWith("/") ? b : b + "/";
  if (target.kind === "panel") {
    return (PANELS as readonly string[]).includes(target.id)
      ? `${root}${path}#${PANEL_SIGIL}${target.id}`
      : `${root}${path}`;
  }
  const t = normalizeTicker(target.id);
  return t ? `${root}${path}#${t}` : `${root}${path}`;
}

/**
 * What a location hash points at, or null when the hash isn't a share link.
 * Accepts the leading "#" and a leading "/" (some clients rewrite "#AAPL" to "#/AAPL").
 *
 * Callers MUST switch on `kind` rather than treating null as "close everything" — App.tsx
 * used to do exactly that, which was only safe while sharing owned the whole hash space.
 */
export function parseShareHash(hash: string | null | undefined): ShareTarget | null {
  const raw = (hash ?? "").replace(/^#/, "").replace(/^\/+/, "");
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // a malformed %-escape is not a symbol
  }
  if (decoded.startsWith(PANEL_SIGIL)) {
    const id = decoded.slice(PANEL_SIGIL.length).trim().toLowerCase();
    // whitelist, so `#!whatever` is inert rather than opening something that isn't there
    return (PANELS as readonly string[]).includes(id) ? { kind: "panel", id: id as PanelId } : null;
  }
  const t = normalizeTicker(decoded);
  return t ? { kind: "ticker", id: t } : null;
}

/**
 * Copy to the clipboard, resolving to whether it actually worked. Callers must not play a
 * success animation on `false` — a confetti burst over a clipboard that didn't take is
 * worse than no feedback.
 *
 * The `execCommand` path is the fallback for a non-secure context (plain http on a LAN IP,
 * where `navigator.clipboard` is simply undefined). It is deprecated, not gone.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* denied / not focused -> try the legacy path */
  }
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Off-screen but still focusable; display:none would make the selection fail.
    ta.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ---- the copy-confirmation animations -------------------------------------
// One of these fires on every successful copy. The ids are the CSS hooks:
// index.css defines `[data-burst="<id>"] …` on whichever host is sharing, and ShareBurst.tsx builds the
// particles for the ones that need them.
export const BURSTS = [
  "confetti", "shock", "tape", "slam", "plane",
  "hole", "liquid", "glitch", "fire", "money",
  "radar", "candle", "matrix", "band", "flip",
  "type", "nova", "bubble", "chain", "bull",
] as const;

export type BurstId = (typeof BURSTS)[number];

/**
 * A random burst that is never the one we just played — back-to-back repeats read as
 * "it only has one animation", which is the opposite of the point. `rand` is injectable
 * so the check can drive it deterministically.
 */
export function pickBurst(prev?: BurstId | null, rand: () => number = Math.random): BurstId {
  if (BURSTS.length < 2) return BURSTS[0];
  const pool = prev == null ? BURSTS : BURSTS.filter((b) => b !== prev);
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)));
  return pool[i];
}
