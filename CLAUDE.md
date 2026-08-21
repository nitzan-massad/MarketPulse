# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev            # vite dev server (base "/")
npm run build          # tsc && vite build -> dist/ (base "/MarketPulse/")
npm run preview
npm test               # === node ci/run-tests.mjs — the same command CI runs
npx tsc --noEmit       # typecheck only (tests.yml runs this too)
```

Running one check:

```bash
node ci/test-keep.mjs          # any ci/test-*.mjs runs standalone
node ci/keep.mjs               # keep.mjs's built-in self-check
CHECK=1 node ci/scrape-sectors.mjs   # the sector parser's fixture self-check
# src/*.check.ts must be compiled first — each file's header comment carries its exact
# `npx tsc … && node /tmp/…` line; or just run `npm test`, which compiles all 7 in one pass.
```

**Node versions differ by task.** Tests/CI need **≥ 22.18** (`ci/test-consensus-direction.mjs`
imports `src/consensus.ts`, which needs native TS type stripping; on Node 20 it cannot run at
all). Both workflows pin **24** — keep them in step. The Vite **dev server** wants **20–22**;
Node 26 can crash `fsevents` on macOS (tests are fine on 26).

Keys for `npm run dev` live in `.env.local` (gitignored): `VITE_FINNHUB_KEY`,
`VITE_TWELVEDATA_KEY`, `VITE_FMP_KEY` (all optional — absent key degrades a feature, never
breaks the build). Production injects them from the `FINNHUB_KEY` / `TWELVEDATA_KEY` /
`FMP_KEY` Actions secrets.

## Architecture

A single-page React 18 + TS + Vite dashboard over a **point-in-time TipRanks snapshot**, plus
live quotes and per-user state. No backend of our own.

**Three layers, and the boundary between them matters:**

1. **Pipeline (`ci/`, Node ESM, no deps)** — scrapes TipRanks/Finviz through FlareSolverr and
   writes the data files. Runs in `.github/workflows/site.yml` every 5h. `ci/keep.mjs` is the
   shared brain (keep-set expiry, row mapping, enrich queue, scale guards); `scripts/refresh-data.mjs`
   is the *local* Playwright equivalent and **must stay in step** — the two held copies of this
   logic once, drifted, and silently re-introduced a fixed bug. `ci/test-enrich.mjs` fails if
   either re-inlines it.
2. **Data (bundled + fetched)** — `src/data/stocks.json` (~350 rows) is `import`ed, so it ships
   in the JS bundle; `src/data/{seen,meta,sectors,pinned}.json` likewise. Per-ticker payloads are
   too big to bundle and are **lazy-fetched from `public/`** at
   `${import.meta.env.BASE_URL}forecasts/<T>.json`, `bullbear/<T>.json`, plus `reviews-recent.json`
   and `desc.json`. Always route those fetches through `BASE_URL` — the production base is
   `/MarketPulse/`, not `/`.
3. **App (`src/`)** — `App.tsx` holds all filter/sort/nav state and feeds four sections
   (`StockTable`, `BestOfBest`, `NewArrivals`, `Watchlist`) plus `StockModal`. Pure logic sits in
   dependency-free modules with a paired `*.check.ts` (`lib`, `consensus`, `alertEngine`,
   `reviewAlerts`, `chartSession`, the pure exports of `useLiveQuotes`) — keep it that way, that
   pairing is what makes it testable without React or Firebase.

**Live data & per-user state.** `useLiveQuotes` holds one Finnhub WS (hard cap **50** symbols:
watchlist first, then on-screen rows) and only during US market hours. `StockModal` pulls chart
bars + fundamentals from Twelve Data, and FMP only for descriptions of off-universe tickers.
Watchlist, thumb marks, saved filters, notifications and review-seen sets persist to Firebase
RTDB under `<path>/<uid>` — every path is enumerated in `database.rules.json`, so **adding a new
RTDB path means adding a rule** (deployed by its own approval-gated workflow). The Firebase web
config in `src/watchlist.ts` is public by design. On localhost, `DEV_AUTH` swaps in a fake user
and localStorage — no real auth, no Firebase writes.

## Non-obvious rules

- **Pushing to `main` *is* the deploy.** The pipeline lives entirely in this repo; there is no
  external CI system. Never edit the workflow through the GitHub web UI. See `AGENTS.md`.
- **Never hand-edit** `src/data/*.json`, `public/forecasts/`, `public/bullbear/`,
  `public/reviews-recent.json` — CI overwrites them. `src/data/pinned.json` is the one exception
  (hand-maintained list of always-refreshed tickers).
- **Never key staleness off file mtime.** `actions/checkout` restamps every file, which froze all
  forecasts for 9 days while CI ran ~40 times. Age comes from the committed
  `public/forecasts/_asOf.json` sidecar, or the `asOf` field inside each bullbear file.
- **Rotation queues order by `ea`/`ba` (attempt stamps), never `ls`.** `ls` is deliberately frozen
  for exactly the off-pull tickers being rotated, so ordering on it re-picks the same rows forever.
- **`ai` is 0–100 on both sources — never rescale it.** A stray `/10` shipped two rows on the
  wrong scale for 58 commits. `ci/test-ai-scale.mjs` guards it and cannot be silenced by
  "being careful" with its `floor` argument (lowering `floor` *weakens* the check).
- **An explicit `null` from TipRanks is data, not a gap.** `ss: null` means "no Smart Score" and
  must render `—`; only an *absent* key means "payload reshaped, carry the previous value".
  Same shape of rule for `con: null` — such a row is kept by the filter and painted with no
  rating class, never as a Hold.
- **`site.yml` runs `npm test` twice on purpose.** The pre-scrape run gates the *code*; the
  post-scrape "DATA GATE" gates the snapshot this run just produced (the data checks read
  `src/data/*.json` off disk, so before the scrape they only vet the previous commit). Neither is
  `continue-on-error`; every scrape step above them is.
- **Tests are discovered by pattern** (`ci/test-*.mjs`, `src/*.check.ts`, `ci/keep.mjs`) — drop a
  file in and it runs, no runner edit. No test framework, no test dependency. A check that exits 0
  with no output, or has no assertion in its source, is reported **FAIL** — a gutted test is worse
  than none.
- Mark deliberate simplifications with a `ponytail:` comment naming the ceiling and the upgrade
  path (see `useLiveQuotes.ts` for the house style).
- CSS is one global `src/index.css`, tokens on `:root`. The palette is light "Steel Navy" —
  **`--gold` is navy `#1b3f73`**, not gold.

## Deeper reference

- `ci/README.md` — the pipeline in full: every source URL and verified payload shape, the
  keep/pin/sticky rules, the enrich queue's cost bound, the forecast paywall fallback, and the
  bug each guard exists to prevent. **Read it before touching `ci/`.**
- `ci/PLAN-ssr-merge.md` — designed, not built: merging SSR forecast rows into the JSON path.
- `docs/superpowers/` — specs + plans for shipped features (notification bell).
- `design/` — static HTML/SVG explorations (modals, icons). Not part of the build.
- `legacy/tipranks-top-stocks.html` — the original standalone dashboard this app was ported from.
