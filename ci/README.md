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

## Not yet automated: bull/bear & analyst forecasts

`public/bullbear/<TICKER>.json` and `public/forecasts/<TICKER>.json` power the modal's
"Bulls Say / Bears Say" and "Analyst Forecasts" panels. **They are static, hand-baked
TipRanks scrapes — no script here regenerates them.** So newly-ranked tickers appear in
the lists immediately but have no bull/bear or forecast files until a manual re-scrape,
which is why New Arrivals are disproportionately missing those panels.

### To automate it (planned `ci/scrape-analysis.mjs`)

For each ticker in `stocks.json` that is **missing** a file (batch-capped per run so
runtime stays bounded), fetch from TipRanks via the existing FlareSolverr helper and write:

- `public/bullbear/<T>.json` → `{ "bull": [{ "t": "title", "b": "body" }, …], "bear": [ … ] }`
- `public/forecasts/<T>.json` → `[{ "n": analyst, "f": firm, "st": stars 0–5, "r": "Buy|Hold|Sell", "pt": target, "opt": prior target|null, "d": "YYYY-MM-DD" }, …]`

Then in `site.yml`: run this step after `refresh-data-ci.mjs`, and extend the commit step's
`git add` / `git diff` to also include `public/bullbear public/forecasts`.

**Hard requirement:** the scrape must be strictly additive and per-ticker failure-tolerant
(wrapped in try/catch, validate JSON before writing) so it can **never** break the main
stocks/seen/meta refresh.

### Missing info needed to build it

- The exact **TipRanks endpoint URL + a sample JSON response** for **Bulls Say / Bears Say**
  (no known free endpoint — this was originally a manual/paywalled-preview scrape).
- Confirmation of the **forecasts** endpoint. Best guess: `https://www.tipranks.com/api/stocks/getData/?name=<TICKER>`
  → `experts[]` (name, firm, `rankings[].stars`, `ratings[]` with date/rating/priceTarget) — **unverified**.

Provide those (or say "best-effort, validate on CI") and the scraper can be written and wired in.
