# CI/CD — data refresh & deploy

This folder holds the code the automated pipeline runs. **The pipeline lives entirely
in this repo** — there is no separate system to log into or "upload" to. Editing the
code here and pushing to `main` **is** the deploy: the next scheduled or manual run
uses whatever is on `main`.

## How it runs

`.github/workflows/site.yml` (the workflow YAML **must** live in `.github/workflows/`
— GitHub requirement — but all the logic it calls lives here in `ci/`):

- **Trigger:** every 6h (`cron`), the "Run workflow" button (`workflow_dispatch`), and every push to `main`.
- **FlareSolverr** service starts (solves Cloudflare from the runner's IP).
- **`ci/refresh-data-ci.mjs`** pulls the TipRanks screener API through FlareSolverr and writes
  `src/data/stocks.json`, `src/data/seen.json`, `src/data/meta.json` (skipped on plain pushes;
  a blocked fetch fails the step but not the run — the site still deploys the last data).
- **Commit step** stages the refreshed data and commits `chore: refresh TipRanks snapshot [skip ci]`.
- **Build** (`npm run build`) with the Finnhub/TwelveData/FMP keys from repo secrets, then deploy to GitHub Pages.

`scripts/refresh-data.mjs` is the **local** manual equivalent (uses Playwright instead of
FlareSolverr) — a dev tool, not part of CI.

## How to change the pipeline (for humans and agents)

1. Edit the files in `ci/` and/or `.github/workflows/site.yml` **in the repo**.
2. Commit and push to `main`.
3. That's it — the next scheduled run, or a manual **Actions → Run workflow**, uses the new code.
   **Never** edit the workflow through the GitHub web UI; the repo is the source of truth.

## Pinned & sticky tickers ✅

The refresh isn't only the dynamic top-120 screener sorts. A ticker is also **kept**
(refreshed every run even when it falls out of those sorts) if it is either:

- **Pinned** — listed in `src/data/pinned.json` (a hand-edited array, e.g. `["AAPL","RIVN"]`).
  Pins never expire. Edit + commit + push this file; the next scheduled/manual run picks it up.
- **Sticky** — seen in the dynamic list within the last **365 days** (`KEEP_MAX_AGE_DAYS`
  in `ci/keep.mjs`). A ticker absent from the dynamic list for longer than that is dropped
  (unless pinned). `seen.json` now carries an `ls` (last-seen) timestamp per ticker to drive this.

Kept tickers missing from a run's screener pull are backfilled from the per-ticker
`getData` feed (`ci/keep.mjs` → `rowFromGetData`), **merging fresh fields over the ticker's
last-known row**. `getData` supplies price, targets, consensus, buy/hold/sell, smart score,
market cap and description — but **not** the AI-analyst score/rating/target or the sector name.
Backfill is capped per run (`BACKFILL_LIMIT`, default 300, most-stale-first) and per-ticker
failure-tolerant, so it can't blow the runtime or break the main refresh.

**AI-score / sector enrichment.** After backfill, any row still missing `ai` or `sec` — a
brand-new pin, or a **brand-new arrival** whose screener row lacked AI data — is enriched from
the per-ticker **stock-forecast** payload (`www.tipranks.com/stocks/<t>/stock-forecast/payload.json`
→ `ci/keep.mjs` `forecastFields`): AI score (0–100 → ÷10), AI rating, AI target, and the sector
name (slug → the app's PascalCase form). It fills blanks only (never overwrites real values),
does pins + new arrivals first, and is capped (`ENRICH_LIMIT`, default 300) and failure-tolerant.
Net effect: a freshly-pinned ticker AND a freshly-arrived ticker both end up fully populated —
no blank AI/sector columns. (Consensus strings use the app's compact vocab — `StrongBuy`, not
`Strong Buy` — because the UI substring-matches `strongbuy`; see `src/lib.ts`.)

The shared keep/expiry/mapping logic lives in `ci/keep.mjs` (used by both the CI and local
scripts) and has a built-in self-check: `node ci/keep.mjs`.

## Analyst forecasts — automated ✅

`ci/scrape-forecasts.mjs` refreshes `public/forecasts/<TICKER>.json` from TipRanks'
`getData` feed via FlareSolverr. `site.yml` runs it right after the data refresh (for
tickers **missing** a file; `LIMIT` caps per-run count, `ALL=1` re-scrapes everyone),
and the commit step now also stages `public/forecasts`.

- **Source (verified):** `https://www.tipranks.com/api/stocks/getData/?name=<T>` → `experts[]`.
  Mapping: `name`, `firm`, `rankings[].stars` (0–5), newest `ratings[0]` → `ratingId` 1/2/3 =
  Buy/Hold/Sell, `convertedPriceTarget` (→ `pt`), `convertedOldPriceTarget` (→ `opt`), `date` (→ `d`).
- **Output:** `[{ "n": analyst, "f": firm, "st": stars, "r": "Buy|Hold|Sell", "pt": target, "opt": prior|null, "d": "YYYY-MM-DD" }, …]`
- **Failure-tolerant:** per-ticker try/catch, only writes valid non-empty results, `continue-on-error`
  in CI — it can never break the main refresh. Tiny tickers with no ranked analysts simply get no file.

## Bulls Say / Bears Say — still manual ⚠️

`public/bullbear/<TICKER>.json` is a **static, hand-baked** scrape. The AI "Bulls Say /
Bears Say" prose is **not in TipRanks' free page HTML** (verified: the exact titles/bodies
aren't served on the free stock/stock-analysis pages) — it's a premium/GPT feature, so
there's no free endpoint to automate against. New tickers therefore still show
"not available" for this panel until a premium-access re-scrape. Options if we want it:
scrape with an authenticated TipRanks session, use a paid data source, or generate the
pros/cons ourselves from fundamentals. Shape to match:
`{ "bull": [{ "t": "title", "b": "body" }, …], "bear": [ … ] }`.
