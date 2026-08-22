// Merging the two forecast sources. Pure and import-safe — no network, no writes — so
// ci/test-forecast-merge.mjs can exercise it directly instead of mirroring it (which is what
// ci/test-forecast-gate.mjs had to do for the old inline gate).
//
// WHY THIS EXISTS. TipRanks' `getData` API paywall-anonymizes a teaser window of rows: they
// keep `firm`, `date`, `ratingId` and `stars` but null `name` and every price-target field, so
// toForecasts() drops them on `!e.name`. The window covers the FRESHEST ratings, so this is a
// recency problem on every ticker, not a micro-cap problem. The SSR page renders names and
// targets in full.
//
// Until now the page was a FALLBACK, fetched only when the JSON path yielded nothing at all
// (`!fc.length`). BIOA is the shape of the bug that leaves: 9 real broker ratings exist, 2
// survived the teaser, so the fallback never fired and 7 stayed invisible next to a label
// reading "n=9".
//
// Measured over all 418 tickers (Phase 0 of PLAN-ssr-merge.md, 2026-08-22):
//   rows 3976 -> 5669 (+42.6%)      85% of tickers gain rows
//   83% get FRESHER data            median +16 days, worst +349 (ANVS, stuck on 2025-09-03)
//   0 tickers lose rows   0 malformed rows   0 target conflicts where both sources have it

/**
 * Identity of a rating across the two sources. Analyst + date: both sources name the analyst
 * for every row that survives to here, and one analyst does not issue two ratings on a stock
 * on the same day.
 *
 * Not firm|date — two analysts at one firm on one date collide there (that collision is
 * accepted for the STAR join in forecast-html.mjs `withStars`, where the cost is a wrong star
 * count; here it would drop a whole rating).
 */
export const mergeKey = (f) => `${(f.n || "").toLowerCase().trim()}|${f.d || ""}`;

/**
 * Should we fetch the SSR page for this ticker?
 *
 * `merge` on  → always. The page is the only source of the freshest ratings, and Phase 0 found
 *               a gain on 85% of tickers, including ones whose JSON path returned plenty.
 * `merge` off → the legacy fallback: only when JSON gave us nothing AND the payload admits it
 *               withheld rows. Kept so SSR_MERGE=0 is an exact rollback, not a new code path.
 */
export function shouldFetchPage(fc, data, merge) {
  if (merge) return true;
  return !fc.length && (data?.expertRatingsFilteredCount ?? 0) > 0;
}

/**
 * Union of the SSR rows and the JSON rows, newest first.
 *
 * Precedence, per PLAN-ssr-merge.md:
 *   pt, opt, n, f, d, r  -> SSR. It is the rendered truth, and the JSON copy of these is
 *                           nulled for exactly the anonymized rows this path exists to recover.
 *   st (stars)           -> JSON. SSR does not render them. `withStars` already joins most of
 *                           them on firm|date before we get here; this backfills on the
 *                           stronger name|date key for any it missed.
 *
 * STRICTLY ADDITIVE, and that is load-bearing: a truncated FlareSolverr read parses to a valid
 * PREFIX, so under union it can only shrink the GAIN, never the file. That property is why
 * PLAN-ssr-merge.md's row-count guardrail was dropped rather than fixed — see the note in
 * ci/README.md. Verified across 418 tickers: 0 lost a row.
 */
export function mergeForecasts(ssr, json) {
  const jsonRows = Array.isArray(json) ? json : [];
  const ssrRows = Array.isArray(ssr) ? ssr : [];

  const starFor = new Map();
  for (const f of jsonRows) if (f?.n && f.st != null) starFor.set(mergeKey(f), f.st);

  const out = [];
  const seen = new Set();
  for (const f of ssrRows) {
    if (!f?.n) continue; // a nameless SSR row is a parse artefact, not a rating
    const k = mergeKey(f);
    if (seen.has(k)) continue; // the page renders an analyst's avatar and name; dedupe anyway
    seen.add(k);
    out.push(f.st == null && starFor.has(k) ? { ...f, st: starFor.get(k) } : f);
  }
  for (const f of jsonRows) {
    // An anonymized JSON row never joins on its own: no name to key on and no target to show.
    // Its only contribution is `st`, already harvested above and by withStars.
    if (!f?.n) continue;
    const k = mergeKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  out.sort((a, b) => (b.d || "").localeCompare(a.d || ""));
  return out;
}
