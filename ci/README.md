# CI/CD — data refresh & deploy

This folder holds the code the automated pipeline runs. **The pipeline lives entirely
in this repo** — there is no separate system to log into or "upload" to. Editing the
code here and pushing to `main` **is** the deploy: the next scheduled or manual run
uses whatever is on `main`.

## How it runs

`.github/workflows/site.yml` (the workflow YAML **must** live in `.github/workflows/`
— GitHub requirement — but all the logic it calls lives here in `ci/`):

- **Trigger:** every 5h (`cron`), the "Run workflow" button (`workflow_dispatch`), and every push to `main`.
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
`getData` feed via FlareSolverr. `site.yml` runs it right after the data refresh, and
the commit step also stages `public/forecasts`.

- **Selection:** a ticker is scraped if it's **missing a file OR its file is older than
  `STALE_DAYS`** (default 3), processed **stalest-first** (missing = age 0 = front of queue,
  so new arrivals are always picked up on the very next run). `LIMIT` caps the per-run count
  (default 90); `ALL=1` forces everyone. With ~300 tickers and ~5 runs/day, `LIMIT=90`
  rotates through the whole universe in under a day, and no file exceeds ~`STALE_DAYS` old.

- **Source (verified):** `https://www.tipranks.com/api/stocks/getData/?name=<T>` → `experts[]`.
  Mapping: `name`, `firm`, `rankings[].stars` (0–5), newest `ratings[0]` → `ratingId` 1/2/3 =
  Buy/Hold/Sell, `convertedPriceTarget` (→ `pt`), `convertedOldPriceTarget` (→ `opt`), `date` (→ `d`).
- **Output:** `[{ "n": analyst, "f": firm, "st": stars, "r": "Buy|Hold|Sell", "pt": target, "opt": prior|null, "d": "YYYY-MM-DD" }, …]`
- **Failure-tolerant:** per-ticker try/catch, only writes valid non-empty results, `continue-on-error`
  in CI — it can never break the main refresh. Tiny tickers with no ranked analysts simply get no file.

## Bulls Say / Bears Say — automated ✅

`ci/scrape-bullbear.mjs` refreshes `public/bullbear/<TICKER>.json` (the AI Bulls Say /
Bears Say thesis) from TipRanks' **stock-analysis** payload via FlareSolverr, using the
**same selection logic as the forecast scrape** — missing-first + `STALE_DAYS` staleness,
stalest-first, `LIMIT` (default 90), `ALL=1` to force everyone. `site.yml` runs it right
after the forecast backfill, and the commit step stages `public/bullbear`. (The old "no
free endpoint / still manual" note was wrong — the data is free and unauthenticated.)

- **Source (verified live on AAPL, AMD, ACAD, RIVN, NVDA):**
  `https://www.tipranks.com/stocks/<t-lowercase>/stock-analysis/payload.json` — no auth, no key.
  Unlike `getData` this path isn't even Cloudflare-gated (plain `fetch` returns 200), but CI goes
  through the existing FlareSolverr for runner-IP safety. Same `payload.json` family as the
  AI-score enrichment above, different subpage (`stock-analysis`, not `stock-forecast`).
- **JSON path:** `models.stocks_extra[0].aiAnalysis.keyPoints[]` → `{ sentiment: "bullish"|"bearish", title, description }` (typically 3 bull + 3 bear).
- **Output shape:** `{ "bull": [{ "t": "title", "b": "body" }, …], "bear": [ … ], "asOf": "YYYY-MM-DD" }`
  (`asOf` = the date we last refreshed the ticker, shown next to the panel headline; the payload
  carries no content date of its own).
- **Failure-tolerant:** per-ticker try/catch, only writes non-empty results, `continue-on-error`
  in CI — never blocks the deploy. Tickers with no AI analysis simply get no file (retried next run).

## Sector average P/E — automated ✅

`ci/scrape-sectors.mjs` writes `src/data/sectors.json` — the average **trailing and forward**
P/E per sector — from Finviz's sector groups table. `site.yml` runs it after the reviews feed;
the commit step's existing `src/data` glob already stages it.

- **Source (verified):** `https://finviz.com/groups.ashx?g=sector&v=110&o=name` — one
  unauthenticated GET per run (~60 KB), no key. Finviz is Cloudflare-fronted, so CI routes it
  through the existing FlareSolverr for runner-IP safety; plain `fetch` works locally
  (`node ci/scrape-sectors.mjs`).
- **Taxonomy is free.** Finviz's sector names normalize onto the app's own vocab through
  `keep.mjs`'s `sectorName()` with no mapping table — `Real Estate` → `RealEstate`,
  `Consumer Cyclical` → `ConsumerCyclical`, all 11 map. TipRanks' **`General`** catch-all
  (~15 tickers) has no Finviz counterpart and gets no entry; `StockModal` renders "—".
- **Output:** `{ "asOf": "YYYY-MM-DD", "sectors": { "Technology": { "pe": 34.77, "fpe": 25.53 }, … } }`
- **Parsing is header-anchored,** not fixed-offset: the script finds the `No. | Name | Stocks`
  header run and reads P/E and Fwd P/E at whatever offset the header says, so a Finviz column
  reshuffle moves the reads with it. It anchors on that run specifically because the page's
  filter dropdowns also contain bare `Name` / `P/E` options that a plain `indexOf` hits first.
- **Failure-tolerant:** a run parsing fewer than 8 sectors throws instead of writing, results
  merge over the previous file (a fetch occasionally returns without the first data row), and
  the step is `continue-on-error` — it can never block the deploy.
- **Self-check:** `CHECK=1 node ci/scrape-sectors.mjs` exercises the parse against a fixture
  (column offsets, header reshuffle, `-` → `null`, dropdown decoys). No test framework, same
  posture as `node ci/keep.mjs`.

**Consumer.** `StockModal`'s stats grid shows `Fwd P/E` for the stock (from Finnhub's
`/stock/metric?metric=all`, already fetched on card open — `metric.forwardPE`, a key Finnhub
**omits entirely** for loss-makers, so read it as `?? null`) beside a split `Sector Avg P/E`
box carrying Today | Fwd. Fwd P/E renders green below the sector's **forward** average and red
above it — compare forward to forward, or every stock looks cheap.

## Recent reviews feed (New Arrivals) — automated ✅

`ci/build-reviews-recent.mjs` reads the forecast files on disk and writes
`public/reviews-recent.json` — the newest analyst review per ticker whose date is within
`RECENT_DAYS` (default 7): `{ generatedAt, days, items: [{ t, n, f, r, pt, opt, d }] }`.
New Arrivals loads this one small file (instead of hundreds of forecast files) to surface
stocks with a fresh review. `site.yml` runs it after the scrapes and commits the JSON. The
`n|f|d|r|pt` fields match `reviewAlerts.reviewKey`, so clicking a review row opens the stock's
Analyst Forecasts and highlights that exact row.
