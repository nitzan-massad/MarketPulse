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

⚠️ **`ss: null` from TipRanks is an answer, not a gap.** `getData` returns the full
`tipranksStockScore` object with `"score": null` for a stock that simply **has no Smart
Score** (verified live on **ASTI** and **BCDA**; GOOGL comes back 10 and DNLI 6 from the
identical shape). `rowFromGetData` used to write `j.tipranksStockScore?.score ?? prev.ss`,
which cannot tell "TipRanks says there is no score" from "the payload reshaped" — so a real
null resurrected the last number and served it as fresh. ASTI was stuck at `ss 2` from
2026-07-23 across 7 market-moving runs and could not recover to `—` while it stayed off the
screener list. `ssFromGetData` now keys off **presence of the `score` key**: present (even
`null`) → trust it and let null through → the UI renders `—`; object/key absent → payload
reshaped, carry `prev.ss`. That matches the screener path, which has always used `?? null`
(`refresh-data-ci.mjs:73`) — which is why *on-list* no-score tickers like BCDA already showed
`—`. The deliberate trade-off: if `tipranksStockScore` ever disappears wholesale, every
keep-path ticker freezes on its previous `ss` (current behaviour, and the safe side — a
vanished field is our parse bug, not news). Backstops: `if (row.t)` rejects a garbage
per-ticker response and carries the whole previous row, and the ≥50-row guard
(`refresh-data-ci.mjs:83-86`) aborts before writing on a total screener failure. Covered by
`node ci/keep.mjs` (explicit null beats `prev`; missing object / missing key carry it; a real
score and a literal `0` still win).

**AI-score / sector enrichment.** After backfill, a row is enriched from the per-ticker
**stock-forecast** payload (`www.tipranks.com/stocks/<t>/stock-forecast/payload.json`
→ `ci/keep.mjs` `forecastFields`) if it is still missing `ai`/`sec` **or if it is off-pull**:
AI score, AI rating, AI target, and the sector name (slug → the app's PascalCase form).
Ordered stale-pins → blanks → stalest carry, failure-tolerant. `ENRICH_LIMIT` is **derived**
(`max(40, ceil(eligible / 3))`) so full rotation stays inside 3 runs as the off-pull set grows —
a fixed 40 let the bound decay from ~15h to ~50h within six weeks. An explicit env var wins.

`sec` and the rest are fill-only, but **the AI trio (`ai`/`air`/`aipt`) OVERWRITES** — and must,
because `getData` carries no AI-analyst data (`ci/keep.mjs` carries the trio from the previous
row), and `fillNulls` can never correct a stale non-null. Before this, an off-pull ticker's AI
score/rating was frozen indefinitely: **UNP displayed "Outperform"/74 for ~10 days / ~46 runs**
after TipRanks downgraded it to Neutral/69. Only a value actually present in the payload
overwrites — a null never blanks a good one.

**⚠️ The rotation is ordered by `ea` (enriched-at, stamped into `seen.json`), NOT by `ls`.**
`ls` is frozen while a ticker is off-pull, so ordering on it would re-pick the same 40 tickers
every run and staleness would stay unbounded — the identical trap as keying forecast staleness
off file mtime (see the Analyst forecasts section). `ea` is stamped on *attempt*, not success,
so a ticker whose payload never parses can't camp at the queue head. With ~73 off-pull tickers
worst-case AI staleness is **3 runs ≈ 15h**, and stays there because the cap scales. A pin is
prioritised only when actually stale (>3d), so pins no longer re-cost a fetch every run and
sticky slots can't crowd out rotation. The AI trio is applied **atomically** — a payload with
`score` but no `ratingId` would otherwise ship a fresh score beside a stale rating, the very
symptom this pass exists to fix. An empty result is logged and counted (`N with no report`)
rather than silently counting as enriched.

**The keep-set backfill queue has the identical hazard and the identical fix**: it is ordered
by `ba` (backfilled-at), not `ls`, because every candidate is off-pull and `ls` is frozen for
exactly those. Without it, the tail past `BACKFILL_LIMIT` would never be fetched and those rows
would serve stale *prices*, not just stale AI data. Both stamps are written on **attempt**, so a
permanently-dead ticker rotates away instead of camping at the queue head.

`scripts/refresh-data.mjs` mirrors all of this. It diverged once and silently reproduced the
bug CI had already fixed — keep the two in step. Guard: `node ci/test-enrich.mjs`.

Net effect: freshly-pinned and freshly-arrived tickers end up fully populated, and off-pull
tickers no longer serve stale AI data. (Consensus strings use the app's compact vocab —
`StrongBuy`, not `Strong Buy` — because the UI substring-matches `strongbuy`; see `src/lib.ts`.)

⚠️ **`ai` is 0–100 on BOTH sources — never rescale it.** This doc used to say the forecast
score is "0–100 → ÷10", and `forecastFields` did divide. That was wrong on both counts. The
screener writes `aiAnalystData.overallScore` undivided (live spread **39–85**), the forecast
payload's `report.score` is the same scale (verified live: TER 71, AAPL 75, NVDA 79), and the
app expects 0–100 — `scoreColor(s.ai, 100)` in the tables and a literal `/100` in `StockModal`.
Because the enrich path only ever ran for the two **pinned** tickers, exactly 2 of 344 rows
shipped on a 0–10 scale (TER 7.8 for a real 71, stuck for 58 commits and painted deep red in
every table) while the other 342 were fine — which is why nothing looked broken. `aipt` on the
same path is a **dollar** price target, not a score (TER 406 against a 367.69 price), and is
correct as-is. Corrupt rows do **not** self-heal: `fillNulls` only fills nulls.

- **Guard: `node ci/test-ai-scale.mjs`.** Fails if `src/data/stocks.json` mixes scales — some
  non-null `ai` ≤ 10 while others are > 10 (impossible in one column: a real 0–10 column would
  have *every* value ≤ 10) — or if the whole column is ≤ 10 over a 20+ row sample. It names the
  offending tickers, and also re-asserts that `forecastFields` maps 78 → 78. The assumption,
  stated in `aiScaleError` in `keep.mjs`, is that **no ticker legitimately scores ≤ 10 on 0–100**
  (1st percentile of the live 344 is 41, nothing under 30). A bare `max/min` ratio was rejected:
  it false-positives on any legitimately wide spread. **Not yet a step in `site.yml`** — same
  manual posture as `test-staleness.mjs` / `test-forecast-html.mjs`; worth adding as one.

The shared keep/expiry/mapping logic lives in `ci/keep.mjs` (used by both the CI and local
scripts) and has a built-in self-check: `node ci/keep.mjs`.

## Analyst forecasts — automated ✅

`ci/scrape-forecasts.mjs` refreshes `public/forecasts/<TICKER>.json` from TipRanks'
`getData` feed via FlareSolverr. `site.yml` runs it right after the data refresh, and
the commit step also stages `public/forecasts`.

- **Selection:** a ticker is scraped if we **last fetched it more than `STALE_DAYS` ago**
  (default 3), processed **stalest-first** (never-fetched = age 0 = front of queue, so new
  arrivals are always picked up on the very next run). `LIMIT` caps the per-run count
  (default 90); `ALL=1` forces everyone. With ~300 tickers and ~5 runs/day, `LIMIT=90`
  rotates through the whole universe in under a day, and no file exceeds ~`STALE_DAYS` old.

- **⚠️ Age comes from `public/forecasts/_asOf.json`, never from a file's mtime.** Git stores
  no mtimes, so `actions/checkout` stamps every file with the checkout time — an mtime-based
  check makes all 300+ files look seconds old, so nothing is ever refreshed and only
  brand-new tickers get fetched. That silently froze every forecast between 2026-07-24 and
  2026-08-02 while CI ran ~40 times. The `_asOf.json` sidecar (`{ticker: ISO}`, stamped on
  success *and* on an empty result, not on failure) is committed, so it survives checkout.
  `ci/build-reviews-recent.mjs` skips it — it's an object, not an array.
  Guarded by `node ci/test-staleness.mjs`.

- **Source (verified):** `https://www.tipranks.com/api/stocks/getData/?name=<T>` → `experts[]`.
  Mapping: `name`, `firm`, `rankings[].stars` (0–5), newest `ratings[0]` → `ratingId` 1/2/3 =
  Buy/Hold/Sell, `convertedPriceTarget` (→ `pt`), `convertedOldPriceTarget` (→ `opt`), `date` (→ `d`).
- **Output:** `[{ "n": analyst, "f": firm, "st": stars, "r": "Buy|Hold|Sell", "pt": target, "opt": prior|null, "d": "YYYY-MM-DD" }, …]`
- **Failure-tolerant:** per-ticker try/catch, only writes valid non-empty results, `continue-on-error`
  in CI — it can never break the main refresh. Tiny tickers with no ranked analysts simply get no file.

- **⚠️ Paywall fallback — `ci/forecast-html.mjs`.** The `getData` API anonymizes a fixed teaser
  window of rows: 6 AI-model rows plus **up to 4 real brokers**. An anonymized row keeps `firm`,
  `date`, `ratingId` and `stars` but has `name: null` and every price-target field nulled, so
  `toForecasts()` drops it on the `!e.name` guard. On AAPL (194 experts) losing 4 is noise. On a
  micro cap whose entire coverage is 3–4 ratings it swallows **100%** of it — which is how ~49
  tickers wrote `[]` and showed "No analyst forecasts" while tipranks.com plainly listed them.
  Relaxing the guards recovers **nothing**; the targets are absent from the JSON. So when
  `fc.length === 0 && data.expertRatingsFilteredCount > 0` we scrape the SSR page
  `tipranks.com/stocks/<t>/forecast`, which renders names and targets in full, and join `stars`
  back from the API on firm+date.

  **A revised target renders as two cells joined by an arrow — `"$15" "→" "$0.9"` — and the NEW
  target is the LAST one.** Taking the first `$` publishes the pre-revision figure: that bug
  shipped briefly and wrote `pt=15` for VTGN, a $0.24 stock whose real target is $0.9, i.e.
  +6100% upside on screen. Verified against the API on 35 revised rows: last `$` === `priceTarget`
  35/35, first `$` === `oldPriceTarget` 35/35 — so `opt` comes from the page too, and the first
  fixture (ADCT) had no revised row, which is why the original test passed. `ci/fixtures/vtgn-forecast.html`
  now covers the revised case; keep both.

  **Stage 2, planned but NOT built: merge SSR rows into the JSON path instead of only falling
  back.** The teaser window covers the *freshest* ratings, so JSON-path tickers systematically
  miss the newest analyst action — 8 of 8 sampled large caps did, ALGS by 4 months, and the union
  was +24% rows. Because the forecast scrape already rotates (`LIMIT=90`), the merge costs
  ~90 extra HTML fetches per run rather than 351. See [`PLAN-ssr-merge.md`](./PLAN-ssr-merge.md)
  for the merge/precedence rules, the phased rollout, and the notification-blast risk that has
  to be settled first.

  `expertRatingsFilteredCount` equals the count of name-null experts (verified across 21
  payloads, zero mismatches) — it is both the gate and the alarm: **if it ever exceeds 4 real
  brokers, the teaser window has widened and will start eating mid-caps.** Gating on it keeps
  the 260 KB page fetch and the brittle HTML parsing away from the ~300 healthy tickers.
  The parser anchors on the analyst-profile slug and on column order, never on class names
  (TipRanks ships obfuscated per-build hashes). Guarded by `node ci/test-forecast-html.mjs`
  against a real trimmed ADCT page; if the markup moves, that test fails and the parser
  returns `[]` — a stale file, never a corrupt one.

## Bulls Say / Bears Say — automated ✅

`ci/scrape-bullbear.mjs` refreshes `public/bullbear/<TICKER>.json` (the AI Bulls Say /
Bears Say thesis) from TipRanks' **stock-analysis** payload via FlareSolverr, using the
**same selection logic as the forecast scrape** — `STALE_DAYS` staleness, stalest-first,
`LIMIT` (default 90), `ALL=1` to force everyone. Age comes from the `asOf` field already
stored **inside** each `<T>.json` (no sidecar needed here), never from mtime — see the
warning under Analyst forecasts for why. `site.yml` runs it right
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

## Recent reviews feed (New Arrivals) — automated ✅

`ci/build-reviews-recent.mjs` reads the forecast files on disk and writes
`public/reviews-recent.json` — the newest analyst review per ticker whose date is within
`RECENT_DAYS` (default 7): `{ generatedAt, days, items: [{ t, n, f, r, pt, opt, d }] }`.
New Arrivals loads this one small file (instead of hundreds of forecast files) to surface
stocks with a fresh review. `site.yml` runs it after the scrapes and commits the JSON. The
`n|f|d|r|pt` fields match `reviewAlerts.reviewKey`, so clicking a review row opens the stock's
Analyst Forecasts and highlights that exact row.

<!-- BEGIN: Tests (ci/run-tests.mjs + .github/workflows/tests.yml) -->

## Tests — run on every push ✅

**One command, the same one CI runs:**

```
npm test          # === node ci/run-tests.mjs
```

Needs **Node ≥ 22.18** locally (see *Node version* below). No test framework and no test
dependency — every check is a plain script that asserts with `node:assert` (or a local
`eq()` helper) and exits non-zero when unhappy. `ci/run-tests.mjs` only finds them, runs
each in its own child process, and turns "one exited 1" into "the job is red". Nothing
touches the network; the only writes are to `node_modules/.tmp/checks/`.

### What it discovers

Discovery is by **pattern, never a hardcoded list** — drop in a new check and it runs, with
no edit to the runner:

| Pattern | How it runs |
|---|---|
| `ci/test-*.mjs` | directly, on the current Node |
| `src/*.check.ts` | one `tsc` pass into `node_modules/.tmp/checks/` first, then the emitted `.js` |
| `ci/keep.mjs` | the self-check behind its `import.meta.url === file://${process.argv[1]}` guard |

`src/*.check.ts` needs the compile step (not just Node's type stripping) because those files
import their subject **without a file extension** (`from "./lib"`) and one pulls in React +
JSX — Node's resolver cannot do either. The runner uses the repo's existing `typescript`
devDependency with the same flags as the `npx tsc …` line in each file's header comment, plus
a `{ "type": "commonjs" }` marker in the out-dir (the repo root is `"type": "module"`, so
without it Node would parse the CommonJS output as ESM and die on `exports`).

### Two rules beyond pass/fail

1. **A vacuous check is a failing check.** Exit 0 with no output at all, or a source file
   with no assertion in it (commented-out assertions don't count), is reported `FAIL` — a
   gutted test that reads green forever is worse than no test. Exiting 0 with output but no
   `ok`/`pass` line is a softer *suspicious* note, listed in the summary.
2. **A check that cannot execute is not a pass.** See below.

The runner keeps going after the first failure, so one run reports everything that is broken,
and prints a `PASS`/`FAIL` line per file (with assertion count) plus a final tally.

### Node version — why the workflows pin 24, not 20

`ci/test-consensus-direction.mjs` imports `../src/consensus.ts`. Importing `.ts` needs Node's
native type stripping, which shipped **unflagged in 22.18**; on Node 20 the check dies with
`ERR_UNKNOWN_FILE_EXTENSION` and cannot run at all. Both workflows therefore pin
`node-version: 24` (current LTS) — verified: `npm ci`, `npm test`, `npx tsc --noEmit` and
`npm run build` all pass on 24.16.0. Keep the two workflows in step.

On an older local Node the runner detects this via `process.features.typescript` and prints one
actionable line naming the version instead of leaking a resolver stack trace — and **fails**,
rather than quietly skipping the check.

### Where it runs, and what actually blocks a bad deploy

`site.yml` runs `npm test` **twice**, and the two runs guard different things. This is not
belt-and-braces; skip either one and something real gets through.

| Step | When | What it can actually catch |
|---|---|---|
| `tests.yml` | every branch + PR (`main` excluded) | logic regressions, as a red X on the commit — the only coverage branches and PRs get, since `site.yml` only triggers on pushes to `main` |
| `site.yml` → "Run all checks (npm test)" | after `npm ci`, **before** the scrapes | broken *code*, before it is allowed to touch the network |
| `site.yml` → "Re-check the refreshed data (THE DATA GATE)" | after the scrapes, **before** the commit and the deploy | broken *data* — the snapshot this run just produced |

The ordering is the whole point. The data checks (`test-ai-scale.mjs`,
`test-consensus-direction.mjs`) read `src/data/*.json` **off disk**, so in the pre-scrape run
they are validating the *previous* commit's snapshot. On their own they would have let a
repeat of the ÷10 AI-scale bug be committed to `main` and deployed, going red only on the
next cron run five hours later — with the bad data already live. The refresh commit also
carries `[skip ci]`, so `tests.yml` never sees it either.

Neither `npm test` step has `continue-on-error`, unlike the refresh steps above, which are
deliberately failure-tolerant. Failing the data gate aborts before the commit and before the
Pages deploy, so nothing is written and the last good deploy stays up.

`main` is excluded from `tests.yml` because `site.yml` runs the identical command on every
push to it — that exclusion is a duplicate-job saving, not a coverage gap.

<!-- END: Tests -->

## Enrich — the AI trio, the queue, and the cost bound

Where `ci/refresh-data-ci.mjs` (and its local mirror `scripts/refresh-data.mjs`) top up rows
from the per-ticker `stock-forecast` payload. This is the only per-ticker source for the
AI-analyst score/rating/target and the sector name — `getData` exposes neither.

**Why the AI trio overwrites instead of filling.** Rows outside a run's screener pull are
built by `rowFromGetData`, which carries `ai`/`air`/`aipt`/`chg` verbatim from the previous
row (`getData` genuinely has no AI-analyst fields, so carrying beats blanking). Nothing else
ever re-checks them. Selecting only rows that "need a null filled" made that permanent: a
carried row has both non-null, so it could never be picked, and `fillNulls` cannot overwrite
a non-null anyway. UNP showed "Outperform"/74 for ~10 days (~46 runs) after TipRanks
downgraded it to Neutral/69. Hence `|| !inPull.has(t)` in the eligibility filter.

`chg` belongs in that set for the same reason and was the field the first pass forgot: it is
Day %, the most time-sensitive column in the table, frozen on every off-pull row. Sampled
12/12 wrong, sign wrong in 8 — TER showed +12.07 against a live +0.60, ARTV +9.29 against
−3.16. The payload we already fetch carries it, so repairing it costs no extra request.

**Atomicity.** The trio lands whole or not at all. Field-by-field, a payload with `score` but
no `ratingId` ships a fresh 69 beside a stale "Outperform" — the exact UNP symptom, at half
scale. `chg` is independent of the AI report and so is applied separately.

**Scale.** The overwrite depends on `forecastFields` emitting `ai` on the screener's 0–100
scale. Reinstate the old `/10` and the overwrite drags every off-pull row onto 0–10, where
the UI's `scoreColor(s.ai, 100)` paints them dark — the fill path already stranded AAPL at
8.2 and TER at 7.8 that way. `ci/test-ai-scale.mjs` guards it; see *AI score scale* below.

**Rotation and the cost bound.** Queue order is oldest-AI-first, and `ea` (enriched-at) is
stamped on **attempt, not success**, so a permanently-dead ticker goes to the back instead of
camping at the head. `ls` cannot serve as that clock — `nextLastSeen` deliberately freezes it
for exactly the off-pull tickers being rotated. `ba` does the same job for the backfill queue.
Worst-case staleness is `ceil(eligible / (ENRICH_LIMIT − sticky))` runs × the 5h cron.
Measured 2026-08-03: 73 off-pull with 9 sticky slots (2 pins by design, 7 rows whose payload
carries no AI report at all) → 31 fresh slots/run → 3 runs ≈ 15h, inside a news cycle.

`ENRICH_LIMIT` is **derived**, not fixed: a fixed 40 could not bound a set growing ~5.7/day,
and the 15h worst case would decay to ~50h within six weeks. Floor 40 for small sets, ceiling
`ENRICH_MAX` (120) because every unit is one FlareSolverr fetch on top of `BACKFILL_LIMIT`.

The ceiling does a second job: it is what makes the staleness `WARNING` reachable. While the
cap was purely `eligible / ENRICH_TARGET_RUNS`, the condition `eligible > cap * runs` was
arithmetically unsatisfiable — a guard that read as protection and was dead code. With the
ceiling it fires above 360 eligible rows, i.e. when rotation really has slipped past target.
`ci/test-enrich.mjs` asserts both the bound and that regression.

## Smart Score — why an explicit `null` is data, not a miss

TipRanks emits `score: null` as a **real value** meaning "this stock has no Smart Score".
Verified live: ASTI and BCDA both return the full `tipranksStockScore` object
(`returnOnAssets`, `momentum`, `assetGrowth`, …) with `"score": null`, while GOOGL comes back
10 and DNLI 6 from the very same shape. So `ssFromGetData` keys off the **presence of the
key**, not the nullness of the value.

A plain `?? prev.ss` collapses "no score" and "payload reshaped" into a single "carry", which
resurrects the last known number and serves it as if freshly read. ASTI stayed frozen at
`ss: 2` from 2026-07-23 across 7 market-moving runs and could never recover to "—" while it
stayed off the screener list.

**The trade-off, stated deliberately.** If TipRanks ever drops `tipranksStockScore` entirely
or renames `score`, every keep-path ticker silently holds its previous `ss`. That is the safe
side of the line: a vanished field is a *scraper bug*, not a data change, and freezing beats
blanking 350 rows on our own parse error. An explicit null is the opposite — it *is* the data,
so we fail visibly and render "—". An explicitly `null` *object* is lumped in with absent
(unobserved in the wild; carrying is the conservative reading).

This is also what makes the two write paths agree rather than disagree: the screener path uses
`?? null`, which is why on-list no-score tickers like BCDA already render "—". A wholesale
screener failure cannot quietly blank the file either — the row-count guard in
`refresh-data-ci.mjs` aborts before anything is written — and a garbage per-ticker response
cannot reach the mapper, since both callers accept the mapped row only `if (row.t)` and
otherwise carry the whole previous row.

## AI score scale

`ai` is 0–100 on **both** sources. `report.score` verified live at TER 71 / AAPL 75 / NVDA 79,
the same scale as the screener's `aiAnalystData.overallScore` (live spread 39–85). `aipt` is a
price target in dollars, not a score — TER 406 vs px 367.69, AAPL 348 vs 308.91, NVDA 223 vs
200.75. Neither is rescaled.

A `/10` in `forecastFields` once wrote the two pinned rows on a 0–10 scale (TER 7.8 for a real
71) and went unnoticed for 58 commits, because that path only ever ran for pins — exactly two
rows of 344 — and one small number in isolation is indistinguishable from a genuinely low
score. `fillNulls` could not self-heal them either, since it never overwrites a non-null; the
enrich overwrite pass is what repaired them.

`aiScaleError` encodes the detectable signal — the **mixture** — with one stated assumption:
**no ticker legitimately scores ≤ 10 on the 0–100 scale.** Of 344 non-null rows the real
spread is 39–85 and the 1st percentile is 41; nothing has ever come in under 30. If TipRanks
ever publishes a genuine single-digit score this trips. That is the deliberate cost of a check
that cannot be fooled.

Two rejected alternatives, so they don't get re-proposed:

- **A max/min ratio.** False-positives on any legitimately wide spread — 8 → 85 is a ratio of
  10.6 and perfectly valid data.
- **Lowering the `floor` argument "to be careful."** It is the low/high split point, so
  lowering it *silences* the guard: at `floor: 5`, 7.8 and 8.2 count as high and the original
  bug passes. Raising it tightens. `ci/test-keep.mjs` pins this footgun with explicit
  assertions.

`ci/test-ai-scale.mjs` points the guard at the data we actually ship, and carries a positive
control derived from the shipped rows — rescale one by `/10` and the guard must name it — so
neutering `aiScaleError` to `return null` cannot make the file pass silently.

