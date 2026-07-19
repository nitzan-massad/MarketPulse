// Pure ratchet engine for watchlist price alerts. Dependency-free on purpose so
// it can be unit-checked without React or Firebase — see alertEngine.check.ts.
//
// A ticker carries { addPx, ref }: addPx is the price when it was added (fixed,
// drives the displayed cumulative %), ref is the moving reference that ratchets
// after each alert so we don't spam. An alert fires when the move from ref
// crosses ±5%; on firing, ref resets to the current price.

export type Dir = "up" | "down";

export interface Meta {
  addPx: number; // price when the ticker was added to the watchlist
  ref: number; // reference for the next alert; starts equal to addPx
}

export interface AlertResult {
  dir: Dir;
  pct: number; // signed % vs addPx at fire time (cumulative since added)
  newRef: number; // ref to persist so the next alert needs another 5% from here
}

export const ALERT_THRESHOLD = 0.05; // ±5%

export function evalAlert(current: number, meta: Meta): AlertResult | null {
  const { addPx, ref } = meta;
  // ignore missing / non-positive prices (unknown quote, off-universe ticker)
  if (!(current > 0) || !(ref > 0) || !(addPx > 0)) return null;

  const move = (current - ref) / ref;
  let dir: Dir;
  if (move >= ALERT_THRESHOLD) dir = "up";
  else if (move <= -ALERT_THRESHOLD) dir = "down";
  else return null;

  const pct = Math.round(((current - addPx) / addPx) * 100);
  return { dir, pct, newRef: current };
}
