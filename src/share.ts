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

/**
 * The shareable URL for a ticker.
 * `base` is Vite's BASE_URL — "/" in dev, "/MarketPulse/" in the production build — so the
 * same code produces a working link in both. A ticker we can't normalize yields the bare
 * app URL rather than a link to a modal that would open empty.
 */
export function buildShareUrl(ticker: string, origin: string, base: string): string {
  const root = origin.replace(/\/+$/, "");
  const b = base.startsWith("/") ? base : "/" + base;
  const path = b.endsWith("/") ? b : b + "/";
  const t = normalizeTicker(ticker);
  return t ? `${root}${path}#${t}` : `${root}${path}`;
}

/**
 * The ticker a location hash points at, or null when the hash isn't a share link.
 * Accepts the leading "#" and a leading "/" (some clients rewrite "#AAPL" to "#/AAPL").
 */
export function parseShareHash(hash: string | null | undefined): string | null {
  const raw = (hash ?? "").replace(/^#/, "").replace(/^\/+/, "");
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null; // a malformed %-escape is not a symbol
  }
  return normalizeTicker(decoded) || null;
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
// index.css defines `.mkm-modal[data-burst="<id>"] …`, and ShareBurst.tsx builds the
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
