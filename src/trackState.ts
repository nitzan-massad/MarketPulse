// Pure helpers for the "Track this stock" UI (kept out of watchlist.ts so the check script can
// import them without Firebase).
export type TrackRequestState = "none" | "pending" | "tracked" | "failed";

/** RTDB `trackRequests/<KEY>` value → UI state. CI stamps `err` on a pending request whose fetch
 *  failed and clears it when the stock is tracked, but tracked wins regardless: a stale `err` next to
 *  tracked=true must never show "couldn't fetch". */
export function trackStateOf(val: { tracked?: unknown; err?: unknown } | null | undefined): TrackRequestState {
  if (!val) return "none";
  if (val.tracked) return "tracked";
  return val.err ? "failed" : "pending";
}

/** A row with nothing from the analysts: no price target, no AI score, and no consensus (null, or
 *  the no-coverage "Neutral" with 0 buy/hold/sell that the outlook mapper writes). */
export function noAnalystCoverage(s: { con?: string | null; pt?: number | null; ai?: number | null; b?: number | null; h?: number | null; s?: number | null }): boolean {
  return s.pt == null && s.ai == null && (s.con == null || ((s.b ?? 0) + (s.h ?? 0) + (s.s ?? 0) === 0));
}
