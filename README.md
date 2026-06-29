# MarketPulse

A single-page stock dashboard that surfaces the Street's highest-conviction calls — every name,
price target and rating — across three ranked views:

- **Analyst Top** — ranked by upside to the top-analyst consensus price target.
- **Top Smart Score** — ranked by TipRanks' 1–10 Smart Score quant model.
- **AI Analyst Top** — ranked by the TipRanks AI Analyst 0–100 model score.

Live search, sector / consensus filters, market-cap floor, and click-to-sort columns. This is a
Vite + React + TypeScript port of a standalone HTML dashboard; the original lives in
[`legacy/tipranks-top-stocks.html`](legacy/tipranks-top-stocks.html) for reference.

## Getting started

```bash
npm install
npm run dev      # start the dev server
npm run build    # type-check + production build into dist/
npm run preview  # preview the production build
```

> **Node version:** use Node 20–22. Newer Node (e.g. 26) can crash Vite's `fsevents` file watcher
> on macOS. With nvm: `nvm use 22` (or `nvm use 21`).

## Data is a point-in-time snapshot, not live

The dataset is **bundled** at `src/data/stocks.json` (273 rows captured Jun 29, 2026). The app does
**not** fetch live data: TipRanks' screener endpoint is behind Cloudflare and blocks cross-origin
browser requests (CORS), so a client-side fetch can't reach it. "Refreshing" the data means
regenerating `src/data/stocks.json` from a fresh capture and rebuilding — the numbers shown are
historical and are **not investment advice**.
