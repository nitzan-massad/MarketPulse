# Plan — merge SSR forecast rows into the JSON path (stage 2)

**Status: SHIPPED 2026-08-22.** Written 2026-08-03. Implemented in `ci/forecast-merge.mjs`
(union + precedence), `ci/test-forecast-merge.mjs` (guards) and `ci/scrape-forecasts.mjs`
(wiring; default on, `SSR_MERGE=0` rolls back).

**What changed against this plan — read before trusting the numbers below:**

- **Phase 0 ran over all 418 tickers.** Real effect **+42.6%** rows, not the +24% estimated
  here from 8 tickers. 85% of tickers gained rows, 83% got fresher data, median **+16 days**,
  worst **+349** (ANVS, stuck on 2025-09-03). 0 rows lost, 0 malformed, 0 target conflicts.
- **Cost was ~5× the estimate:** **+474s / +34 MB** per 90-ticker rotation, not +100s / 24 MB.
  p50 per fetch 1.4s but p95 12s and max 20s — Cloudflare challenges dominate the tail.
- **Guardrail 3 (row-count sanity check) was dropped, not built.** The page's stated analyst
  count is unusable as a truncation signal in either direction: it over-counts analysts with no
  price target (ALAR states 2 but renders one target and one `―`) and under-counts against a
  table showing history beyond the consensus window (120 tickers). Under union semantics a
  truncated read can only shrink the *gain*, never the file, so that structural property
  replaces the check. See ci/README.md.
- **Phases 1 and 2 were skipped.** 0 losses / 0 conflicts / 0 malformed across the whole
  universe made a staleness-gated cohort rollout ceremony; shipped default-on with the flag as
  the rollback instead.
- **The notification blast was accepted, not mitigated.** The seed-and-suppress design below was
  NOT implemented — the repo owner chose to let it fire.

## The problem, and the evidence

TipRanks' `getData` API paywall-anonymizes a fixed teaser window — 6 AI-model rows plus **up to
4 real brokers**. Anonymized rows keep `firm`, `date`, `ratingId` and `stars` but have
`name: null` and every price-target field nulled, so `toForecasts()` drops them on `!e.name`.

The window covers the **freshest** ratings. That is the whole point of this plan: it is not a
micro-cap problem, it is a *recency* problem that hits every ticker.

Measured across 8 healthy large caps that currently take the JSON path:

| ticker | newest via JSON | newest via SSR | JSON rows | union | gain |
|---|---|---|---|---|---|
| ALGS | 2026-03-19 | **2026-07-14** | 2 | 6 | +200% |
| HD | 2026-05-21 | **2026-07-20** | 19 | 20 | +5% |
| AUTL | 2026-05-14 | **2026-07-13** | 2 | 4 | +100% |
| C | 2026-07-07 | **2026-07-29** | 9 | 18 | +100% |
| EQIX | 2026-07-30 | 2026-07-31 | 19 | 28 | +47% |
| AMZN | 2026-07-31 | 2026-08-02 | 42 | 46 | +10% |
| META | — | — | 43 | 46 | +7% |
| ALLO | — | — | 9 | 12 | +33% |
| **total** | | | **145** | **180** | **+24%** |

**8 of 8 missed the most recent analyst action.** Every html-only row maps to a
`name: null, priceTarget: null, aiModel: false` expert in the payload — real brokers, not AI noise.

⚠️ **This is an 8-ticker sample.** It was never extrapolated to the other 343. Phase 0 exists
precisely to replace it with a full-universe measurement before any behaviour changes.

## Why merge, not switch

The SSR table is a **bounded recent window** (AMZN: 15 SSR rows vs 42 in JSON; max ~15 unique
observed). JSON supplies the long tail. Switching would trade 4-month staleness for a
truncated history. So: SSR for recency, JSON for depth, union for both.

## Merge rules

Two sources, no shared identifier — anonymized JSON rows have no name, which is the whole
reason this path exists. So:

1. **Take every SSR row** (already `withStars`-joined for `st` via `firm|date`).
2. **Add JSON rows not already present**, keyed on `name|date`. Both sources name their
   analyst for non-anonymized rows, so this key is sound where it applies.
3. An anonymized JSON row is *never* added on its own — it has no name and no target. Its only
   contribution is `st`, already harvested by the existing `firm|date` join in `withStars`.
4. Sort newest-first, as now.

**Field precedence when a rating appears in both:**

| field | winner | why |
|---|---|---|
| `pt`, `opt` | SSR | it is the rendered truth, and the JSON copy is nulled for anonymized rows |
| `n`, `f`, `d`, `r` | SSR | same source as `pt`; keeps a row internally consistent |
| `st` | JSON | the only source of stars; SSR does not render them reliably |

**Known unfixable:** two experts at the same firm on the same date collide on the `firm|date`
star join — last wins. Cosmetic, and unresolvable from the API side.

## Cost — smaller than it first looks

The forecast scrape **already rotates**: `LIMIT=90` per run, `STALE_DAYS=3`, so a run touches
at most 90 tickers, not 351. The merge therefore adds **≤90 HTML fetches per run**, not 351.

Measured (warm local FlareSolverr): JSON 0.67s avg, HTML 1.32s avg, pages 227–347 KB (avg 262 KB).

| | now | after merge |
|---|---|---|
| fetches / run | 90 JSON + ~13 HTML | 90 JSON + 90 HTML |
| added wall clock | — | **~+100s** |
| added transfer | — | **~24 MB/run** |

CI has headroom: `site.yml` sets no job timeout (default 360 min) and the current full run is
~7.5 min. Caveat: measured warm and local; a CI FlareSolverr paying a cold Cloudflare
challenge per request will be slower. Treat +100s as a floor.

## Phases

**Phase 0 — measure, write nothing.** Run the merge for all 351 tickers and record what it
*would* produce: rows gained, newest-date delta, conflicts, malformed rows, real per-fetch cost.
Compare against the committed files; write a report to the scratchpad, not to `public/forecasts/`.
This replaces the 8-ticker sample with real numbers and is the gate for Phase 1.

**Phase 1 — highest value, smallest blast radius.** Enable for tickers where
`expertRatingsFilteredCount > 0` **and** the JSON newest rating is older than 14 days. That is
the ALGS/AUTL cohort — the worst staleness, a small count. Ship behind `SSR_MERGE=1`.

**Phase 2 — widen** to all tickers whose SSR page is already being fetched, then to the full
rotation, gated on Phase 0/1 numbers holding.

**Phase 3 — make it the default**, remove the flag, update `ci/README.md`.

## Guardrails (non-negotiable)

- **SSR failure must never reduce data.** If the page parses to 0 rows, keep the JSON result
  untouched. The merge is strictly additive. Today's fallback has this property; the merge must
  keep it, because the brittle path stops being confined to ~48 tickers.
- **`SSR_MERGE` env flag** for instant rollback without a revert.
- **Row-count sanity check.** A truncated FlareSolverr response parses to a valid *prefix*
  (measured: always a prefix, never a partial row), so a short read would silently shrink a
  file. Compare against the page's own "N Wall Street analysts" figure and skip the merge on
  a mismatch. This is currently an accepted gap; at merge scale it stops being acceptable.
- **Markup-change blast radius.** HTML parsing currently affects ~48 tickers; after Phase 3 it
  affects all 351. `ci/test-forecast-html.mjs` (2,973 assertions, 6 fixtures) is the mitigation
  — extend it with any new real markup Phase 0 turns up.

## ⚠️ The notification blast — biggest operational risk

`ci/build-reviews-recent.mjs` feeds `public/reviews-recent.json`, which drives the New Arrivals
"fresh review" rows **and** the review detector (`src/useReviewAlerts.ts`). Merging will surface
dozens of ratings that already existed but were hidden behind the paywall. On the first merged
run they look brand new, so users could get a flood of notifications for weeks-old ratings.

**Mitigation:** on the first run with `SSR_MERGE` enabled, write the merged forecasts but
suppress review-alert generation for rows whose date predates the run — seed the alert
baseline instead of firing it. Verify against `reviewKey()` in `src/reviewAlerts.ts`. Decide
this **before** Phase 1, not after.

## Tests to add

- Merge unit tests in `ci/test-forecast-html.mjs` (or a new `ci/test-forecast-merge.mjs`):
  union correctness, `name|date` dedup, precedence per field, SSR-empty leaves JSON untouched,
  JSON-empty behaves as today's fallback, both empty → `[]`.
- A fixture pair (one JSON payload + one SSR page for the same ticker) exercising a rating
  present in both, one JSON-only, one SSR-only.
- Extend `ci/test-forecast-gate.mjs`: the gate becomes "always merge" rather than
  "fallback when empty" — its four pinned scraper source-line assertions will need updating,
  deliberately.

## Open decisions

1. Notification suppression: seed-and-suppress (recommended) vs let it fire once?
2. Phase 1 threshold: 14 days, or `filteredCount > 0` alone?
3. Accept ~24 MB/run transfer, or cap the merge below the rotation limit?
