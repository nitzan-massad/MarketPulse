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
Ordered pins → blanks → stalest carry, capped by `ENRICH_LIMIT` (default **40**), failure-tolerant.

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
and 9 sticky (2 pins + 7 with no AI report at all), worst-case AI staleness is **3 runs ≈ 15h**.
Raise `ENRICH_LIMIT` once the off-pull set passes ~120. Guard: `node ci/test-enrich.mjs`.

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

## Industry average P/E — automated ✅

Sector is coarse — 12 buckets for 315 tickers — so the benchmark is the stock's industry where
one exists. **The gain is coverage, not precision**, and that distinction was measured across
all 315 tickers rather than assumed:

- **Coverage: 300 → 315.** Every ticker now gets a benchmark. The 15 `sec:"General"` rows
  (TipRanks' catch-all, which has no sector average at all) all resolve to a real industry.
- **Accuracy: roughly a coin flip.** Of the 161 tickers with a usable forward P/E, the industry
  average is closer 88 times vs sector's 73 (54.7%); trailing is 71 vs 68 (51.1%). Median
  absolute gap improves 8.18 → 7.70 forward. 33 tickers flip the green/red colour.
- **Winners:** Industrials, BasicMaterials, ConsumerDefensive, Financial. **Losers:** Technology
  and Healthcare — which are 61% of the universe.

⚠️ **The obvious Healthcare justification is wrong, so don't repeat it.** Yes, 109 of the 135
Healthcare tickers are Biotechnology, and yes Biotechnology shows 45.44/37.33 against
Healthcare's 30.71/18.18. But only **31 of those 135 have a usable P/E at all**, so for the
other ~100 the benchmark has nothing to compare against and the change is invisible. Worse, the
31 that do render have a **median forward P/E of 17.29** — almost exactly the *sector* figure —
and sector was the closer benchmark for **20 of them**. The reason: Finviz's group figure is an
**aggregate, not a constituent median**. Biotechnology's 37.33 is 1.75× the median across its
own 593 members (21.34); Chemicals' 203.21 is 11.3× its median (18.06). The label
"Industry Avg P/E" is fair, but the number skews toward a few large richly-priced names.

- **`ci/scrape-industries.mjs`** → `src/data/industries.json`. Same Finviz page family as the
  sector scrape, `?g=industry` instead of `?g=sector`: one GET (~215 KB), **144 industries**,
  identical columns. Stores `{ n, pe, fpe }` per industry — `n` (constituent count) is what
  the consumer uses to decide whether the average means anything.
- **`ci/scrape-ticker-industry.mjs`** → `src/data/ticker-industry.json`. Which industry each
  ticker is in, from Finviz's screener: `screener.ashx?v=152&t=<20 tickers>&c=1,3,4`, where each
  row carries `data-boxover-ticker` and `data-boxover-industry`. 20 is the page size, so the
  ticker list is **chunked 20 at a time** (~16 GETs) rather than paginated — same cost, no
  paging logic. Kept as a separate `{T: industry}` map so `refresh-data-ci.mjs`/`keep.mjs`
  stay untouched. Current coverage: **314/315** (only LMFA is unknown to Finviz).

**Both sides come from Finviz on purpose.** TipRanks' payloads also carry an industry string,
but its vocabulary only joins to Finviz's for ~2/3 of tickers (`Chemicals - Specialty` vs
`Specialty Chemicals`; `Gambling, Resorts & Casinos` maps to *two* separate Finviz industries)
and would need a hand-maintained alias table with cases no table can resolve. Finnhub's
`profile2.finnhubIndustry` is worse — it files WDC/STX under a bucket literally named
`Technology`, and puts MU and NVDA in the same `Semiconductors` bucket anyway.

**Row detection differs from the sector scrape** and that difference is load-bearing: with no
`sectorName()` whitelist to lean on, rows are anchored on the `<No.>` rank cell
(`<rank><name><count>`) plus a name-shape guard. Matching on name-then-number instead would
also catch the header's **last** label, since `PEG` is followed by row 1's rank — the sector
scrape only dodges that because `sectorName("PEG")` returns null. Self-check:
`CHECK=1 node ci/scrape-industries.mjs` and `CHECK=1 node ci/scrape-ticker-industry.mjs`.

**Consumer.** `StockModal`'s stats grid shows `Fwd P/E` for the stock (from Finnhub's
`/stock/metric?metric=all`, already fetched on card open — `metric.forwardPE`, a key Finnhub
**omits entirely** for loss-makers, so read it as `?? null`) beside a split benchmark box
carrying Today | Fwd. The box uses the stock's **industry** average when it has one with
`n >= minConstituents` (10), else falls back to its **sector** average, and the label switches
between `Industry Avg P/E` and `Sector Avg P/E` accordingly with the bucket name in a `title`.
Today only WMT, HD and CEG fall back (industries of 9, 5 and 9 stocks) plus LMFA (no industry).
Fwd P/E renders green below the benchmark's **forward** figure and red above it — compare
forward to forward, or every stock looks cheap.

**The `n >= 10` threshold was swept, not guessed.** N=10 costs 3 of 314 tickers and is
accuracy-neutral while dropping the visibly meaningless rows (Real Estate - Diversified n=3,
Aluminum n=4). **At N≥20 trailing goes net-negative** (56 better vs 61 worse) and coverage bleeds
26–78 tickers. So: N=10, and do not raise it past 15.

⚠️ **An `n` threshold is not an outlier guard, and can't be.** `Chemicals` reads **203.21** off
17 constituents, `Shell Companies` 734 forward off 321 — both pass any sane N. Nothing is wrong
today because no ticker of ours maps into either, but the rows that *do* affect this universe and
skew worst are all large-n (Biotechnology n=593 at 3.1× its median, Aerospace & Defense n=90 at
76.71). A value-plausibility guard was measured and does not pay off: `val ≤ 70 AND ≤ 2.5× sector`
changes nothing at all, and the only variant that improves forward accuracy does so purely by
reverting Biotechnology to sector — i.e. by undoing the change.

**Known coverage gap:** LMFA is absent from Finviz's *screener* universe (`t=LMFA` → "1 Total"
with no row), though `quote.ashx?t=LMFA` does list it as Capital Markets. A per-ticker quote-page
fallback would recover it and any future screener miss. Not implemented — it's 1 of 315.

## Recent reviews feed (New Arrivals) — automated ✅

`ci/build-reviews-recent.mjs` reads the forecast files on disk and writes
`public/reviews-recent.json` — the newest analyst review per ticker whose date is within
`RECENT_DAYS` (default 7): `{ generatedAt, days, items: [{ t, n, f, r, pt, opt, d }] }`.
New Arrivals loads this one small file (instead of hundreds of forecast files) to surface
stocks with a fresh review. `site.yml` runs it after the scrapes and commits the JSON. The
`n|f|d|r|pt` fields match `reviewAlerts.reviewKey`, so clicking a review row opens the stock's
Analyst Forecasts and highlights that exact row.
