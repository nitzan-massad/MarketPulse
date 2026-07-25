// Pure diff engine for analyst-review notifications. Dependency-free (no React/Firebase)
// so it can be unit-checked — see reviewAlerts.check.ts.
//
// Each analyst review gets a stable identity key. A key we've never seen is "new" —
// that covers a brand-new analyst AND an existing analyst re-issuing on a new date or
// with a changed target/rating, which is exactly "a new review dropped".

// Minimal shape needed for identity (a structural subset of forecasts.ts `Forecast`).
export interface ReviewLike {
  n: string | null; // analyst
  f: string | null; // firm
  d: string; // rating date
  r: string | null; // Buy / Hold / Sell
  pt: number | null; // price target
}

export function reviewKey(f: ReviewLike): string {
  return [f.n ?? "", f.f ?? "", f.d ?? "", f.r ?? "", f.pt ?? ""].join("|");
}

// Keys present in `current` but not in `seen`, de-duplicated, order preserved (newest first).
export function newReviewKeys(current: ReviewLike[], seen: readonly string[]): string[] {
  const s = new Set(seen);
  const out: string[] = [];
  for (const f of current) {
    const k = reviewKey(f);
    if (!s.has(k)) {
      s.add(k);
      out.push(k);
    }
  }
  return out;
}

// Every key in a forecast set — used to baseline a ticker we're seeing for the first time.
export function allReviewKeys(current: ReviewLike[]): string[] {
  return current.map(reviewKey);
}
