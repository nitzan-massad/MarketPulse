// Keyboard navigation for the header search results. Pure and dependency-free so it can
// be checked without React — paired with searchNav.check.ts.
//
// The results list is three sources concatenated (ranked stocks, Finnhub lookups, and a
// raw-ticker fallback), and the arrow keys have to walk them as one list. Flattening that
// here keeps the component from indexing into three arrays at once and getting the
// boundaries wrong.
import type { Stock } from "./types";

export type SearchOption =
  | { kind: "stock"; key: string; stock: Stock }
  | { kind: "ticker"; key: string; ticker: string };

export function buildOptions(
  results: Stock[],
  remote: { t: string; n: string }[],
  offUniverseTicker: string | null,
): SearchOption[] {
  const out: SearchOption[] = results.map((s) => ({ kind: "stock", key: `s:${s.t}`, stock: s }));
  for (const r of remote) out.push({ kind: "ticker", key: `r:${r.t}`, ticker: r.t });
  // the raw-ticker guess only shows when the lookup returned nothing
  if (offUniverseTicker && remote.length === 0) {
    out.push({ kind: "ticker", key: `o:${offUniverseTicker}`, ticker: offUniverseTicker });
  }
  return out;
}

/**
 * Where ArrowDown/ArrowUp should move from `current`, wrapping at both ends.
 *
 * `current` is -1 when nothing is highlighted yet, which is the normal state right after
 * typing: the first ArrowDown must land on the FIRST row, and the first ArrowUp on the
 * last. An empty list always yields -1 so a keypress on "No matches" cannot select a row
 * that isn't there.
 */
export function nextIndex(current: number, length: number, dir: 1 | -1): number {
  if (length <= 0) return -1;
  if (current < 0) return dir === 1 ? 0 : length - 1;
  return (current + dir + length) % length;
}
