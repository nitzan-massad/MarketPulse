// Watchlist ordering — a per-ticker numeric sort key, ascending.
//
// Dependency-free on purpose (no React, no Firebase) so it can be unit-checked; see
// watchlistOrder.check.ts.
//
// WHY A KEY AND NOT AN ARRAY INDEX. The signed-in list already lives in RTDB as
// `watchlist/<uid>/<ticker> = <ms epoch>` (watchlist.ts `toggle`), a MAP, because a
// per-ticker write can't clobber a concurrent star from another device. Positions therefore
// have to be a property of each ticker, not of a list. Reusing that existing number as the
// sort key means: no new RTDB path (so database.rules.json is untouched), no migration for
// existing users, and "a newly starred stock lands LAST" falls out for free — Date.now() is
// greater than every key already stored.
//
// The number stops meaning strictly "added at" the moment a row is dragged. That is the
// deliberate trade: one field that is "position, seeded from add time" beats two fields that
// can disagree about which one the list is sorted by.

/** Key spacing when appending, or when moving to either end. One minute, in ms. */
export const NEW_GAP = 60_000;
/** Two neighbours closer than this leave no room to subdivide — renumber instead. */
export const MIN_GAP = 1;

export type KeyMap = Record<string, number>;

/**
 * Tickers in display order: key ascending, so the most recently added is LAST.
 *
 * Ties break on ticker, which matters more than it looks: the legacy array->map migration
 * stamped every ticker with the same `Date.now()`, so a whole list can be one big tie. Without
 * a deterministic tiebreak those rows would reshuffle on every render.
 *
 * A non-numeric or non-finite key sorts LAST rather than first — corrupt data should not be
 * able to jump to the top of someone's list.
 */
export function orderTickers(keys: KeyMap): string[] {
  const at = (t: string): number => {
    const v = keys[t];
    return typeof v === "number" && Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
  };
  return Object.keys(keys).sort((a, b) => at(a) - at(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The key a newly starred ticker gets: strictly after everything already in the list. */
export function keyForAppend(keys: KeyMap, now: number): number {
  const vals = Object.values(keys).filter((v) => typeof v === "number" && Number.isFinite(v));
  const max = vals.length ? Math.max(...vals) : 0;
  // max()+gap rather than plain `now` so a device with a slow clock — or a list whose keys
  // were renumbered away from epoch values — still appends to the END and not the middle.
  return Math.max(max + NEW_GAP, now);
}

/** Evenly respaced keys for the whole order. The escape hatch when a gap runs out. */
export function renumber(order: string[], step: number = NEW_GAP): KeyMap {
  const out: KeyMap = {};
  order.forEach((t, i) => {
    out[t] = (i + 1) * step;
  });
  return out;
}

export type MovePlan =
  /** Nothing to do (out of range, or the row is already there). */
  | { kind: "none" }
  /** The common case: one ticker's key changes, so one write. */
  | { kind: "key"; ticker: string; key: number }
  /** The neighbours have no room left between them — rewrite the whole map. */
  | { kind: "renumber"; keys: KeyMap };

/**
 * What to persist to move the row at `from` so it ends up at index `to` of the resulting
 * list (standard array-move semantics: move(["A","B","C","D"], 0, 2) === ["B","C","A","D"]).
 *
 * Dropping between two neighbours takes the midpoint of their keys, so a move costs ONE write
 * regardless of list length — important because every write here is a device-to-device sync.
 * Repeatedly dropping into the same shrinking gap is the one thing that defeats it, hence the
 * renumber plan; ms-scale starting gaps give ~20 halvings before that ever fires.
 */
export function planMove(order: string[], keys: KeyMap, from: number, to: number): MovePlan {
  if (!Number.isInteger(from) || from < 0 || from >= order.length) return { kind: "none" };
  const dest = Math.max(0, Math.min(order.length - 1, to));
  if (dest === from) return { kind: "none" };

  const ticker = order[from];
  const without = order.slice();
  without.splice(from, 1);
  // `dest` is the index in the FINAL list, so after the removal the new neighbours are
  // exactly without[dest - 1] and without[dest].
  const prev = without[dest - 1];
  const next = without[dest];
  const keyOf = (t: string | undefined): number | null => {
    if (t === undefined) return null;
    const v = keys[t];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const lo = keyOf(prev);
  const hi = keyOf(next);

  // Either end of the list: step clear of the neighbour rather than subdividing.
  if (lo == null && hi == null) return { kind: "none" }; // single-item list, nowhere to go
  if (lo == null) return { kind: "key", ticker, key: hi! - NEW_GAP };
  if (hi == null) return { kind: "key", ticker, key: lo + NEW_GAP };

  // Neighbours out of order, or touching: subdividing would produce a key equal to one of
  // them, and the tie would then be broken by TICKER, silently landing the row somewhere the
  // user did not drop it. Respace everything instead.
  if (hi - lo <= MIN_GAP) {
    const target = without.slice();
    target.splice(dest, 0, ticker);
    return { kind: "renumber", keys: renumber(target) };
  }
  return { kind: "key", ticker, key: lo + (hi - lo) / 2 };
}

/** Array move, for the optimistic repaint while the write is in flight. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const dest = Math.max(0, Math.min(out.length - 1, to));
  const [item] = out.splice(from, 1);
  out.splice(dest, 0, item);
  return out;
}
