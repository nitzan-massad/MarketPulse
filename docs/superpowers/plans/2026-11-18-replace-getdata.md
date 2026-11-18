# Replace TipRanks getData Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop depending on `tipranks.com/api/stocks/getData/` without losing data, and make CI fail fast and visibly instead of hanging 6h. Cloudflare has firewall-blocked that endpoint for everyone since between 04:33 and 16:02 UTC on 2026-11-17.

**Architecture:**
- **Replacing getData:** one full-universe screener call (plain fetch, FlareSolverr fallback) replaces the per-ticker getData backfill. The per-ticker `stock-aianalyst/payload.json` covers tickers the screener lacks and new "Track this stock" requests.
- **Analyst ratings:** `scrape-forecasts` uses the `stock-forecast` payload plus the forecast page. Stars come from the payload's analyst rank, and ratings we've already stored keep their firm and target.
- **Not losing data:** a keep-last-known merge, with an explicit "unknown vs empty" contract, and a data-loss gate replayed against 60 historical snapshot pairs.
- **Failing fast:** a shared fetch helper never retries a firewall block and has a per-endpoint breaker. A DRY_RUN switch lets us verify on real runners without committing or deploying.

**Tech Stack:** Node 24 ESM scripts in `ci/`, `node:assert` checks run by `npm test` (`ci/run-tests.mjs`, no framework), GitHub Actions, React/TS app (`src/`), Firebase RTDB.

**Spec:** No separate doc. The design comes from the 2026-11-18 investigation (13 read-only agents) and a 3-agent gap review. Facts that set requirements:
- Blocked for every IP, even with a cf_clearance cookie: getData and getNews.
- Still working, plain or via FlareSolverr: the screener, `stock-forecast/payload.json`, `stock-aianalyst/payload.json`, and the forecast page.
- **No-filter screener** (`pageSize=20000`): about 13.9k items, about 77 MB, 5s plain or 18s via FlareSolverr, peak memory about 1.5 GB. It covers 554/556 rows. Missing: ACH (delisted) and KPTI (now KPTIQ). Units match today's (`mc`: `marketCap/1e6`; `chg`/`up` ×100; all USD).
- **No coverage in the screener:** the whole `bestAnalystsConsensusData` / `bestPriceTargetData` object is `null` (5,904 items).
- **Sector:** the screener says `"General"` for some real-sector stocks (CDNS, BSX, COF, IRD).
- **`stock-aianalyst` payload:** in `models.stocks[_id==T]` (the row with `company`), it has `smartScore.value`, `marketCap.daily.marketCap` (USD), `company.{companyName,name,description,sector}`, `prices.daily.priceUSD`, `analystRatings.{all,best}` and `report`. It has **no stars**. `experts[].firm` is the analyst's *profile* firm, not the firm at rating time.
- **Stars are in the `stock-forecast` payload.** Stars = `5 × rank.rank`, the formula TipRanks' own CSV export uses (`(rankPercentile*5).toFixed(2)`). Read it from the expert record whose `_id === rating.expert.id` (the `analyst|<n>` record); fall back to the record whose `_id === rating.expert.uid`. On AAPL, 27/32 match the stored `st` exactly and none is more than 0.3 off (the payload is newer).
- **No rating history or per-rating firm anywhere.** Every payload has only the newest rating per analyst, and firm sits on the analyst's profile.
- **TipRanks retired getData on purpose (2026-11-18 10-agent search).** The current site never calls it, and the block is an edge rule on getData and getNews only. The `curl`-UA and `mobile.` routes that still answer, and other `/api/*` routes, are **out of scope**: using them gets around a deliberate block, and `robots.txt` disallows `/api/*`.
- **Expert lookup bug:** `forecastsFromPayload` keys experts by `_id`, but ratings reference `expert.uid` (Jack Zhou on AAPL is dropped).
- **Today's consensus basis is mixed:**
  - in-pull screener rows use best analysts;
  - getData-backfilled rows used **all** analysts for `con`/`b`/`h`/`s` (200/279 match `all`) but best for `pt`.
- **`pt`/`up` going to null is normal:** it happened in 17 of the last 59 runs (≤ 8 rows). `ss` going to null peaked at 5 per run.
- **Stuck run:** 44297382017 holds the `pages` concurrency group until about 17:44 UTC.

## Decisions

- **D1, consensus basis: keep today's behaviour exactly (user, 2026-11-18).** No row changes basis.
  - **In-pull rows** (top-120 sorts): `con`/`b`/`h`/`s` come from `bestAnalystsConsensusData` and `pt`/`up` from `bestPriceTargetData`, with no fallback, as `refresh-data-ci.mjs:65-73` does today.
  - **Every other row** (universe backfill, aianalyst payload, track requests): `con`/`b`/`h`/`s` come from **all analysts** (`analystsConsensusData` / `analystRatings.all`), and `pt`/`up` from **best**, falling back to all, matching what `rowFromGetData` produced.
- **D2, gate mode: blocking (user, 2026-11-18).** A bad update keeps yesterday's data. The thresholds are tuned so a replay over the last 60 snapshot pairs is green.
- **D3, settled with the user:**
  - **Firm and foreign-currency targets:** a rating already in a forecast file keeps its stored firm and target. A rating is the same when it has the same analyst and date, and its target can't change, so any difference is exchange-rate drift or profile-firm drift. Only brand-new ratings take the payload's current firm and USD target.
  - **KPTI:** remove just that ticker, with no new rule (Task 9).
  - **Remaining loss:** older ratings that aren't in any file yet. The payload has only each analyst's newest rating.

## Global Constraints

- Node `>=22.18`; workflows pin Node 24.
- Every price goes through `rndPx`. `mc` is stored in **millions**.
- Consensus vocab is `CON_NAME` in `ci/keep.mjs`.
- **Row contract:** a mapper returns `undefined` for a field it cannot see ("unknown → keep prev") and `null` only for an explicit "source says empty". Explicit-empty cases:
  - `ss`: `null` when the score object is present with a null value;
  - no coverage (both best and all consensus objects are `null`): `con:null, b:0, h:0, s:0, pt:null, up:null`.
- `sec: "General"` from the screener is `undefined` (the enrich pass fills real sectors).
- `scripts/refresh-data.mjs` must stay in step with `ci/refresh-data-ci.mjs` (CLAUDE.md). Its screener mapping runs inside `page.evaluate`, so it returns raw items and maps them in Node.
- **Tests:** plain `ci/test-*.mjs` with `node:assert/strict`. They must print output and contain an assertion. No network. Fixtures go in `ci/fixtures/`.
- **Scratch paths:** in the session scratchpad, never `/tmp` or the repo. Local dry runs must end with `git checkout -- src/data public/` and `git status --short` clean apart from code.
- **No pushes, workflow dispatches or run cancels** without the user's explicit per-action OK. Commits use `type: description` like the existing history.
- **Rollback:** revert to a commit **at or after Task 1**, never before it (that brings back the 6h hang).

## Review Focus

1. **Screener item with a missing parent object.** `aiAnalystData`, `bestPriceTargetData` or `description` absent means `undefined` (carry), not `null`. Otherwise the AI trio is wiped on about 287 rows. Test: Task 2.
2. **No coverage vs reshaped.** A null `best*` object (explicit, use the `all` fallback or empty) is different from a missing key (unknown). Test: Task 2.
3. **Every endpoint blocked.** Each loop stops after 3 blocks, the snapshot step finishes under its deadline, and the run ends red in about 15 min with yesterday's data intact. Test: Task 1 breaker plus Task 7 gate.
4. **Gate false reds.** Normal churn (`pt`/`up` nulls, `ss` withdrawals, expired tickers, a missing `DROPPED` file) must pass. Test: Task 5 replay.
5. **Payload failure in `scrape-forecasts`.** A ticker whose payload fails must not shrink its file. Carry every previous row. Test: Task 6.

---

### Task 1: Fail-fast fetch, step limits, DRY_RUN

**Files:**
- Create: `ci/tr-fetch.mjs`, `ci/test-tr-fetch.mjs`
- Modify:
  - `ci/refresh-data-ci.mjs:16-35`
  - `ci/scrape-forecasts.mjs:46-69`
  - `ci/track-requests.mjs:177-210`
  - `ci/scrape-bullbear.mjs` (its retry loop)
- Modify `.github/workflows/site.yml`:
  - add `ids` to every scrape step;
  - `timeout-minutes`: snapshot `15`, earnings `10`, job `build-deploy` `220`;
  - new `workflow_dispatch` input `dry_run` (boolean, default false), with `if: ${{ !inputs.dry_run }}` on "Commit refreshed data", the deploy steps, "Mark requests tracked" and "Clear folded tracked rows".

**Interfaces:**
- Produces:
  - `isBlocked(s: string): boolean`. True for FlareSolverr's `Cloudflare has blocked this request` and for bodies containing `Sorry, you have been blocked` or `error code: 1020`. A challenge (`Just a moment`) is **not** blocked.
  - `class BlockedError extends Error`.
  - `makeBreaker(limit = 3): { open(): boolean, record(blocked: boolean): void }`. Opens after `limit` blocks in a row; a non-blocked result resets the count.
  - `async getText(url, { flareUrl, tries = 3, plain = true, ok = () => true, breaker }): Promise<string>`:
    - try plain `fetch` first (UA = `BROWSER_UA` from `worker/cnbc.js`);
    - on a challenge or 403, use FlareSolverr;
    - a blocked response calls `breaker?.record(true)` and throws `BlockedError` at once;
    - a challenge page or `!ok(body)` retries up to `tries` with an 8s sleep;
    - success calls `breaker?.record(false)`.
  - `health(msg: string): void`. Appends a line to `$RUNNER_TEMP/health`; a no-op without `RUNNER_TEMP`.

- [ ] **Step 1: Write the failing tests**:
  - `isBlocked` on the FlareSolverr "has blocked" message → true;
  - `"<title>Just a moment...</title>"` → false;
  - `"error code: 1020"` → true;
  - breaker: 2 blocks → closed, 3 → open, reset on success;
  - `getText` with a stubbed `fetch` returning FlareSolverr `{status:"error", message:"…Cloudflare has blocked this request…"}` (and `plain:false`) rejects with `BlockedError` after exactly **1** call;
  - `getText` with `ok: b => b.includes("x")` retries once on `"y"` and resolves on `"x"`;
  - `health("a")` with `RUNNER_TEMP` set to a scratchpad dir writes `a\n`.
- [ ] **Step 2:** `node ci/test-tr-fetch.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement `ci/tr-fetch.mjs`.
- [ ] **Step 4:** `node ci/test-tr-fetch.mjs` → PASS.
- [ ] **Step 5: Wire it in.** Replace the 4 local retry loops with `getText`, passing each call's existing `ok` predicate and `tries`. Use one breaker per endpoint per script. While a breaker is open, skip that endpoint (rows carry; forecast files stay untouched) and call `health("breaker open: <endpoint>")` once.
- [ ] **Step 6:** `npm test` → PASS. Check that `grep -n "sleep(8000)\|sleep(6000)" ci/refresh-data-ci.mjs ci/scrape-forecasts.mjs ci/track-requests.mjs ci/scrape-bullbear.mjs` finds no hits.
- [ ] **Step 7: Commit** `fix: never retry a Cloudflare firewall block; breakers, step timeouts, dry_run`

> Ships alone. With getData still blocked, each scraper fails over within 3 requests and the run finishes; data stays as of 2026-11-17 until Tasks 2–6 land.

### Task 2: Row mappers + keep-last-known merge

**Files:**
- Modify: `ci/keep.mjs` (add `ROW_KEYS`, `rowFromScreener`, `rowFromAiAnalyst` and `mergeRow`; `rowFromGetData` stays until Task 4)
- Modify: `ci/refresh-data-ci.mjs:61-79`: every row goes through `mergeRow(prevRows.get(t), rowFromScreener(it, { inPull: true }))`
- Modify: `scripts/refresh-data.mjs:~21-45`: `page.evaluate` returns raw `items`; mapping happens in Node through the same two functions
- Create:
  - fixtures `ci/fixtures/screener-items.json` (AAPL; a no-coverage item; an item missing `aiAnalystData`; a `"General"` item; an item with `tipRanksSmartScoreData: {tipRanksSmartScore: null}`)
  - fixtures `ci/fixtures/aianalyst-aapl.json` and `aianalyst-nnnn.json`, trimmed from the scratchpad `a3/` and `a10/p/` dumps
  - `ci/test-row-mappers.mjs`

**Interfaces:**
- Produces:
  - `ROW_KEYS`: the 17 keys `t,n,sec,px,chg,pt,up,con,b,h,s,ss,ai,air,aipt,mc,desc`.
  - `rowFromScreener(item, { inPull }: { inPull: boolean }): Row`. Same field sources as `refresh-data-ci.mjs:61-79`, with these changes:
    - the contract above (missing parent → `undefined`);
    - consensus basis per D1:
      - `inPull: true`: best only, exactly as today;
      - `inPull: false`: `con`/`b`/`h`/`s` from `analystsConsensusData`, `pt`/`up` from `bestPriceTargetData ?? priceTargetData`;
    - `mc` from `t.marketCap ?? t.marketCapUSD`;
    - `"General"` → `undefined`.
  - `rowFromAiAnalyst(fj, ticker): Row | null`. Returns `null` when there is no matching row. Fields:

| Row field | Source in the payload |
|---|---|
| `n` | `company.companyName ?? company.name` |
| `sec` | `sectorName(company.sector)` |
| `px` | `rndPx(prices.daily.priceUSD)` |
| `chg` | `prices.daily.gain*100` |
| `con` / `b` / `h` / `s` | `analystRatings.all` (D1, as getData did). Null → explicit empty |
| `pt` / `up` | `analystRatings.best ?? analystRatings.all` (D1). Both null → explicit empty |
| `ss` | `smartScore.value` |
| `ai` / `air` / `aipt` | as in `forecastFields` |
| `mc` | `Math.round(marketCap.daily.marketCap/1e6)` |
| `desc` | `company.description` |

  - `mergeRow(prev: Row | undefined, next: Row | null): Row`:
    - `next == null` → `prev` unchanged;
    - otherwise per `ROW_KEYS`: `next[k] === undefined || NaN` → `prev?.[k] ?? null`; else `next[k]`;
    - never returns `undefined` values.

- [ ] **Step 1: Write the failing tests**:
  - **AAPL screener item:** produces the same row the old inline code produced. Compute the expected value from the fixture by hand.
  - **D1, same behaviour as today:**
    - **AAPL, `inPull:true`:** best counts (11/6/5).
    - **AAPL, `inPull:false`:** all-analyst counts from `analystsConsensusData` (15/8/6), with `pt` still the best target.
    - **No-coverage item, `inPull:true`:** `con:null, b:0, pt:null`, as today.
    - **Item with only best null, `inPull:false`:** counts from `analystsConsensusData`.
  - **aianalyst AAPL:** `con` and `b`/`h`/`s` come from `analystRatings.all` (15/8/6), and `pt` from `analystRatings.best`.
  - **Item missing `aiAnalystData`:** `ai`, `air` and `aipt` are `undefined`, and `mergeRow({ai:70,air:"Neutral",aipt:5}, row)` keeps all three.
  - **`"General"` item:** `sec === undefined`.
  - **Explicit-null score:** `ss === null`, and it survives `mergeRow({ss:7}, row)` as `null`.
  - **aianalyst AAPL:** `{ss:7, mc:5114027}`.
  - **aianalyst NNNN:** has `n` and `px`, `con:null`, `b+h+s === 0`.
  - **Wrong ticker:** `rowFromAiAnalyst(aapl,"MSFT") === null`, and `mergeRow({px:1}, null).px === 1`.
  - **Full shape:** `mergeRow(undefined, row)` has every `ROW_KEYS` key, none of them `undefined`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npm test` → PASS. Also run `node ci/test-enrich.mjs`, which fails if the refresh scripts re-inline keep logic.
- [ ] **Step 5: Commit** `refactor: shared screener/aianalyst mappers with keep-last-known merge`

### Task 3: Data-loss gate (built before the risky swap, so Task 4 is verified by it)

**Files:**
- Create: `ci/data-loss.mjs`, `ci/test-no-data-loss.mjs`, `ci/replay-data-loss.mjs` (a dev tool, not a test)
- Modify:
  - `ci/refresh-data-ci.mjs`: write `dropped` to `process.env.DROPPED` when set.
  - `.github/workflows/site.yml`: after "Fold lite-run tracked rows", `cp src/data/stocks.json "$RUNNER_TEMP/prev-stocks.json"; cp src/data/seen.json "$RUNNER_TEMP/prev-seen.json"; cp -r public/forecasts "$RUNNER_TEMP/prev-forecasts"`. Pass `PREV_DIR=${{ runner.temp }}` and `DROPPED=${{ runner.temp }}/dropped.json` to the refresh step and to "Re-check the refreshed data (THE DATA GATE)".

**Interfaces:**
- Produces `lossReport({prevRows, nextRows, prevSeen, nextSeen, prevFc, nextFc, dropped}): string[]`. `prevFc` and `nextFc` map each ticker to its row count. Violations:
  - **Tickers:** a ticker present before and gone now, unless it's in `dropped`.
  - **Strict fields** `n, px, mc, desc, sec`: a value that was non-null and is now null.
  - **Threshold fields:** more than `LIMITS = {pt: 15, up: 15, con: 15, ss: 15}` rows going from a value to null in one run. The limits are tuned in Step 5.
  - **seen.json:** a key gone without being in `dropped`, or a `d` that changed.
  - **Forecasts:** a file deleted, or a file with at least 5 rows shrinking by more than 20%.
- `DROPPED` missing → `[]`. `PREV_DIR` unset → the check compares HEAD with itself and prints so.

- [ ] **Step 1: Write the failing tests**, one per violation type and one per allowed case:
  - a listed dropped ticker → OK;
  - `mc` 5 → null → 1 violation;
  - 15 `pt` nulls → OK, 16 → 1 violation;
  - a `d` change → violation;
  - a forecast file going 10 → 7 rows → violation, 10 → 9 → OK;
  - a missing `DROPPED` → OK.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Replay.** `node ci/replay-data-loss.mjs 60` walks the last 60 data commits (`git log -60 --format=%H -- src/data/stocks.json`) and runs `lossReport` on each consecutive pair. It must report **0 violations** apart from ones you've checked by hand. Adjust `LIMITS` until it does, and record the observed max per field in a comment beside `LIMITS`.
- [ ] **Step 6: Commit** `test: data-loss gate replay-tuned on 60 snapshots`

### Task 4: Universe pull replaces the getData backfill

**Files:**
- Modify:
  - `ci/refresh-data-ci.mjs:104-139`
  - `scripts/refresh-data.mjs:60-75,140-150`
  - `ci/keep.mjs`: delete `rowFromGetData` and `ssFromGetData`, plus their part of the self-check at `ci/keep.mjs:343-375`
  - `ci/test-keep.mjs`: delete the `rowFromGetData` blocks; keep the `forecastFields`, keep and expiry coverage
  - `ci/README.md`: in the source list, mark getData blocked since 2026-11-17 and add the universe URL and `stock-aianalyst` with their shapes
- Create: `ci/test-backfill-plan.mjs`

**Interfaces:**
- Consumes: `getText`, `makeBreaker` and `health` (Task 1); the mappers and `mergeRow` (Task 2); `DROPPED` (Task 3).
- Produces:
  - `UNIVERSE_URL = "https://www.tipranks.com/api/apps/stock/screener?country=us&method=screener&page=1&pageSize=20000&sortDir=2"`
  - `universeMap(items): Map<string, item>`. Prefers `stockListingIsPrimaryMarket === true` on duplicates.
  - `planBackfill(missing: string[], universe: Map): { fromUniverse: string[], needPayload: string[] }`
- Behaviour:
  1. The 3 sorted calls are unchanged. They own `inPull`, `membership` and expiry.
  2. Fetch the universe once. If that fails or won't parse, call `health("universe pull failed")` and use an empty map.
  3. `fromUniverse` → `mergeRow(prev, rowFromScreener(item, { inPull: false }))`. The 3 sorted calls use `{ inPull: true }`.
  4. `needPayload` (≤ `BACKFILL_LIMIT`, with a deadline of `Date.now() + 10 min`) → `mergeRow(prev, rowFromAiAnalyst(await getText(".../stocks/<t>/stock-aianalyst/payload.json"), t))`.
  5. Past the deadline or on failure, carry `prev`.
  6. Stamp `ba` as today.
  7. Log `backfill: U universe, P payload, C carried`, and call `health()` when C > 30% of `missing`.
  8. Write `stocks.json` **and** `seen.json` even when the deadline was hit.

- [ ] **Step 1: Write the failing tests**:
  - `planBackfill(["AAPL","ACH"], new Map([["AAPL",{}]]))` → `{fromUniverse:["AAPL"], needPayload:["ACH"]}`;
  - `universeMap` keeps the primary listing of a duplicate;
  - `planBackfill(x, new Map())` → everything in `needPayload`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Local dry run against the last good snapshot.** `node ci/refresh-data-ci.mjs` with `PREV_DIR` set to a scratchpad copy of `c242d0cc4`'s `src/data/{stocks,seen}.json` and `DROPPED` set, then `node ci/test-no-data-loss.mjs` → PASS. The log should show C ≤ 2. Finish with `git checkout -- src/data public/`.
- [ ] **Step 6:** `grep -rn "api/stocks/getData" ci/refresh-data-ci.mjs scripts/refresh-data.mjs` → no hits.
- [ ] **Step 7: Commit** `feat: full-universe screener + aianalyst payload replace getData backfill`

### Task 5: Stars from the payload, and stored ratings kept

**Files:**
- Modify: `ci/forecast-merge.mjs:124-160`: `forecastsFromPayload` emits `st`.
- Modify: `ci/forecast-merge.mjs`: add `keepPrevRating`, which replaces `keepPrevTarget`; update its callers.
- Create: `ci/fixtures/stock-forecast-aapl.json`, trimmed from the scratchpad `e7/r/` or `a10/p/stock-forecast.json`.
- Modify: `ci/test-forecast-merge.mjs`.

**Interfaces:**
- Produces:
  - `forecastsFromPayload(fj, t, null)` rows gain `st`. The value is `round(5 * e.rank.rank, 1)` from the expert record with `_id === r.expert.id`, falling back to the record with `_id === r.expert.uid`, and `null` when neither has `rank.rank`.
  - `keepPrevRating(rows: Fc[], prev: Fc[] | null): Fc[]`. When a row has the same `analystKey` and `d` as a `prev` row, it keeps the prev row's `f`, `pt` and `opt` and takes the other fields from the new row.

- [ ] **Step 1: Write the failing tests**:
  - On the AAPL fixture, Martin Yang → `st` = `round(5 × his analyst| record's rank.rank, 1)`, and every `st` is in `[0, 5]`.
  - `keepPrevRating([{n:"Ives",d:"2026-11-01",f:"Wedbush",pt:300}], [{n:"Ives",d:"2026-11-01",f:"Yorkville",pt:310}])` → `f:"Yorkville", pt:310`.
  - The same call with a new date `d:"2026-11-10"` → `f:"Wedbush", pt:300`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: analyst stars from payload rank; stored ratings keep firm and target`

### Task 6: scrape-forecasts without getData

**Files:**
- Modify: `ci/forecast-merge.mjs:124-160`. In `forecastsFromPayload`, index experts by both `_id` and `uid`, and resolve a rating's expert by `r.expert.uid ?? r.expert.id`.
- Modify: `ci/forecast-merge.mjs`. Add `carryStars`, `carryRecentPrev` and `hiddenTargets`. Delete `carryForward`, `carryMissing`, `missingFirms`, `pickSource` and `shouldFetchPage`.
- Modify: `ci/forecast-html.mjs:128`. `withStars(rows, data)` becomes `withStars(rows)`: it only normalises and sorts, and keeps `st`.
- Modify: `ci/scrape-forecasts.mjs:86-249`.
- Modify: `ci/test-forecast-merge.mjs:226-310` (replace the deleted functions' blocks) and `ci/test-forecast-gate.mjs:24,172-187` (drop the `pickSource` import; rewrite its source-line assertions to the new pipeline lines below).
- Delete: `ci/getdata-cache.mjs`, `ci/test-getdata-cache.mjs`, and the `GETDATA_CACHE` env lines in `site.yml`.

**Interfaces:**
- Produces:
  - `carryStars(rows, prev): Fc[]`. Fills `st == null` from `prev` by `analystKey`.
  - `hiddenTargets(fj, ticker, fileRows): string[]`. Analysts whose newest payload rating has `priceTarget == null` and is newer than their row in `fileRows`; these need the page.
  - `carryRecentPrev(rows, prev, { now = Date.now(), days = 92, all = false }): Fc[]`. Adds `prev` rows whose analyst is absent from `rows`, within `days`, or every one of them when `all` is true.
- `scrape(t)` pipeline (the gate test asserts these lines exist):
  1. `fj = await getText(payloadUrl, {plain:true, breaker})`, then `src = forecastsFromPayload(fj, t, null)`. On failure, `src = null`.
  2. `fc = carryStars(src ?? [], prev)`.
  3. `needPage = src === null || hiddenTargets(fj, t, prev ?? []).length > 0`. Stars come from the payload (Task 5), so a missing star never triggers a page fetch.
  4. If `needPage` and the page breaker is closed: `page = parseForecastHtml(await getText(pageUrl, {plain:false, ok: h => usablePage(h, 1)}))`.
     - **Payload ok:** `fc = mergeForecasts(fc, topUpRows(withStars(page), missingOf(fc, page)))`. Payload targets keep priority, so the bell isn't re-rung. The page adds only analysts or ratings the payload lacks, and fills `st` by `analystKey`.
     - **Payload failed:** `fc = withStars(page)`.
  5. Then `fc = keepPrevRating(fc, prev)`, `fc = carryRecentPrev(fc, prev, { all: src === null })`, `fc = keepNewerPrev(fc, prev)` and `fc = latestPerAnalyst(fc)`.

- [ ] **Step 1: Write the failing tests**:
  - **uid regression:** an expert `{_id:"x", uid:"u1", name:"Jack Zhou"}` with a rating `{expert:{uid:"u1"}}` → included.
  - **`carryStars`:** fills 1.3 and leaves a non-null value alone.
  - **`hiddenTargets`:** returns Samik when his newest payload rating (11-15) has no target and his file row is from 10-01.
  - **`carryRecentPrev`:**
    - keeps a 30-day row and drops a 100-day row;
    - with `all:true`, keeps the 100-day row;
    - never duplicates an analyst already present.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Local check.**
  1. Start a local FlareSolverr on 8191.
  2. Copy `public/forecasts/{AAPL,TWLO,UBER}.json` into a scratchpad `OUT` dir.
  3. Run `ONLY=AAPL,TWLO,UBER,NNNN OUT=<that dir> node ci/scrape-forecasts.mjs`.
  4. Expect: each file's row count ≥ its copy; AAPL contains Jack Zhou; `st` nulls ≤ 2 per file; no crash on NNNN.
- [ ] **Step 6: Commit** `feat: forecasts from payload + page, stars carried/parsed; fix uid lookup`

### Task 7: "Track this stock" via aianalyst, failures visible

**Files:**
- Modify `ci/track-requests.mjs`:
  - `fetch` mode (`:349-367`): `row = mergeRow(undefined, rowFromAiAnalyst(json, t))`. A null row, or one with no `n` or no `px`, is a failure. Drop the stock-forecast `fillNulls`.
  - new `fail` mode;
  - `planMarks` also clears `err`;
  - `planUnrequest` clears requests with `err.at` older than 24h.
- Modify `.github/workflows/track-requests.yml`: a last step, `if: always()`, runs `node ci/track-requests.mjs fail`. It reads `FAILED` (from `steps.fetch.outputs.failed`) and also treats any ticker in `steps.fetch.outputs.tickers` that isn't in RTDB `trackedRows` as failed (this covers a red data gate). It exits 1 when anything failed.
- Modify `src/watchlist.ts:442,476-498`: `TrackRequestState` adds `"failed"`, which applies only when `!val.tracked && val.err`. Tracked wins.
- Modify `src/components/StockModal.tsx:1131-1160`: copy below. The failed state offers **no** retry button, because the RTDB rule is create-only.
- Modify `ci/test-track-requests.mjs`.

**Interfaces:**
- Produces:
  - `planFail(failed: string[], requests, now): Record<path, value>`. Returns `{"trackRequests/<KEY>/err": {at: now, msg: "fetch failed"}}` for pending requests only.
  - `fetch` writes `failed=…` to `$GITHUB_OUTPUT`.
- App copy, exact:
  - failed: **"Couldn't fetch data for {T} yet — we'll keep trying"**. Pending requests are retried by every 3h run until the 24h clear.
  - covered row with `con`, `pt` and `ai` all null: **"No analyst coverage yet"**.

- [ ] **Step 1: Write the failing tests**:
  - `planFail(["NNNN"], {NNNN:{tracked:false}}, 1)` → `{"trackRequests/NNNN/err": {at:1, msg:"fetch failed"}}`; a tracked request → `{}`;
  - `planMarks` output includes `trackRequests/NNNN/err: null`;
  - `planUnrequest` clears an `err.at` from 25h ago and keeps one from 1h ago.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement the CI side.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Implement the app side. Then `npx tsc --noEmit` → clean. In `npm run dev` (Node 20–22, `DEV_AUTH`), stub a dev request with `err` and check the failed copy shows with no button. Open the NNNN modal after a local track and check "No analyst coverage yet" shows.
- [ ] **Step 6: Commit** `feat: track requests via aianalyst payload; surface failures to the user`

### Task 8: Health gate

**Files:**
- Modify `.github/workflows/site.yml`: a new final step `Health gate`, `if: always()`, with no `continue-on-error`. It fails when `$RUNNER_TEMP/health` is non-empty **or** any step with an id (`snapshot`, `backfill`, `earnings`, …) has `outcome != 'success'`. Any of those makes it print what tripped and `exit 1`.
- Modify `ci/scrape-forecasts.mjs`: call `health()` when `fail > 10%` of targets.

- [ ] **Step 1:** Write the step (YAML only, since `health()` is tested in Task 1). Run `npx --yes @action-validator/cli .github/workflows/site.yml`, or run `actionlint` if it's installed, and expect no errors. If neither is available, re-read the step against the GitHub `steps.<id>.outcome` docs.
- [ ] **Step 2: Commit** `ci: health gate — data ships, run goes red when a source or step degrades`

### Task 9: Rollout, verification, NNNN

- [ ] **Step 1:** `npm test` → PASS, `npx tsc --noEmit` → clean, and `git status --short` shows no data files.
- [ ] **Step 2: Ask the user** before each action:
  1. cancel the stuck run 44297382017 (it loses nothing; `trackedRows` stay in RTDB);
  2. push the branch;
  3. `gh workflow run site.yml --ref <branch> -f dry_run=true`.
- [ ] **Step 3: Dry-run acceptance.** Check `gh run view --log`:
  - the universe pull succeeded, and whether it needed FlareSolverr;
  - `backfill:` C ≤ 2;
  - the data gate is green;
  - the health gate is green;
  - the snapshot step took under 3 min and the whole run 35 min or less;
  - nothing was committed or deployed.
- [ ] **Step 4:** With the user's OK, merge to `main`. That push deploys the code; the refresh runs on the next schedule.
- [ ] **Step 4b: Drop KPTI only.** `keepalive.json` lists it, so a user watches or recently viewed it. Read RTDB `watchlist` and `views` to find out which.
  - **Viewed only:** a view doesn't add a ticker to the keep set. Remove `KPTI` from `src/data/seen.json` and `src/data/stocks.json`, and delete `public/forecasts/KPTI.json` and `public/bullbear/KPTI.json`, in one commit `chore: drop delisted KPTI (now KPTIQ)`. This is a one-off hand edit, approved by the user.
  - **On someone's watchlist:** that re-adds KPTI every run. Stop and tell the user; it's their call whether to touch another user's watchlist.
- [ ] **Step 5:** With the user's OK, `gh workflow run track-requests.yml`. Expect green, with the log showing `fetched rows: 1: NNNN`. The app shows NNNN with "No analyst coverage yet".
- [ ] **Step 6:** Watch the first scheduled `site.yml` on `main`, with the same acceptance as Step 3, plus the commit landing and Firebase deploying.
