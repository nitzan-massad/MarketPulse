// Analyst-consensus ranking — the one place that decides whether a change in a
// ticker's consensus rating is an upgrade or a downgrade.
//
// The vocabulary is written by the data pipeline, from two kinds of writer:
//   1. ci/keep.mjs:50 `CON_NAME` maps the TipRanks rating/enumId 1–5 to
//      StrongSell | Sell | Neutral | Buy | StrongBuy  (note: "Neutral", never "Hold"),
//      used by rowFromGetData (ci/keep.mjs:81) and forecastFields (ci/keep.mjs:114).
//   2. the screener passthrough `bc.analystConsensus?.name || null`
//      (ci/refresh-data-ci.mjs:72 and scripts/refresh-data.mjs:41) — an *unvalidated*
//      upstream string, so a label we've never seen can appear at any time.
// Either writer can also produce `null` (no coverage), and seen.json carries whatever
// was current at first sighting, so both sides of a comparison may be null.
//
// Consequences for the design here:
//   - "Hold" is accepted as a synonym of "Neutral" (same rank) rather than replacing it:
//     the passthrough writers are not constrained to the CON_NAME vocab, src/types.ts
//     documents "Hold", and src/App.tsx already aliases Hold → Neutral (line 35) and
//     lists both (line 135). Ranking only one of them would silently re-open this bug.
//   - lookup is normalised (lowercase, non-alphanumerics stripped) the same way
//     ci/keep.mjs `sectorName` normalises sectors, so "Strong Buy" ranks like "StrongBuy".
//   - anything else — a genuinely new label such as "Moderate Buy", or a missing value —
//     has NO known rank, and therefore yields NO direction. Guessing would render a
//     confident green/red arrow that can be exactly backwards.

/** Direction of a consensus change; `null` = not knowable, render no direction. */
export type ConsDir = "up" | "down" | null;

const CONS_RANK: Record<string, number> = {
  strongsell: 1,
  sell: 2,
  neutral: 3,
  hold: 3, // synonym of Neutral — see above
  buy: 4,
  strongbuy: 5,
};

/** Rank of a consensus label (1 = most bearish, 5 = most bullish), or null if unknown/missing. */
export function consRank(c: string | null | undefined): number | null {
  if (!c) return null;
  return CONS_RANK[String(c).toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null;
}

/**
 * Direction of a consensus change `from` → `to`.
 * Returns null — meaning "show the change, claim no direction" — when either side is
 * missing, either side is a label we don't rank, or the two rank the same.
 */
export function consDir(from: string | null | undefined, to: string | null | undefined): ConsDir {
  const a = consRank(from);
  const b = consRank(to);
  if (a == null || b == null || a === b) return null;
  return b > a ? "up" : "down";
}
