# Agent instructions — MarketPulse

## CI/CD is in the repo — edit here, push to deploy

The data-refresh & deploy pipeline lives **entirely in this repo**. There is **no separate
CI/CD system to log into or "upload" to** — pushing to `main` **is** the deploy.

- **Workflow:** `.github/workflows/site.yml` (must stay in `.github/workflows/` — GitHub requirement).
- **Pipeline code:** the `ci/` folder (e.g. `ci/refresh-data-ci.mjs`).
- **To change the pipeline:** edit `ci/` and/or `site.yml` **in the repo**, commit, and push to `main`.
  The next scheduled run (every 6h) or a manual **Actions → Run workflow** picks up the new code.
- **Never** edit the workflow via the GitHub web UI — the repo is the single source of truth.

Full details, data shapes, and the plan for the not-yet-automated bull/bear + forecasts
scrape are in [`ci/README.md`](./ci/README.md). Read it before touching the pipeline.

## Data files

- `src/data/{stocks,seen,meta}.json` — refreshed automatically by CI. Don't hand-edit.
- `public/bullbear/<T>.json`, `public/forecasts/<T>.json` — currently static/manual (see `ci/README.md`).
