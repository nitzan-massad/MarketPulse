# Part: CI / pipeline — Twelve Data → CNBC bars (`ci/scrape-pe.mjs`)

Scope: every Twelve Data (TD) use in `ci/`, `scripts/`, `.github/workflows/`. App-side TD
(`StockModal` chart, `chartSession.ts`) and the Worker are other parts. Probed 2026-10-22 from
a residential Mac. **Not probed from a GitHub runner**: that needs a workflow run, which this
planning pass was not allowed to start.

## 1. Current behavior

TD has exactly **one** CI consumer: the one-time 5Y weekly-closes backfill for the P/E chart.
`scripts/refresh-data.mjs`, `cf-budget.mjs` and `run-telemetry.mjs` don't touch TD. `cf-budget`
tracks Workers-AI neurons, so it doesn't apply here.

| Where | What |
|---|---|
| `MarketPulse/ci/scrape-pe.mjs:24` | `TD = TWELVEDATA_CI_KEY \|\| TWELVEDATA_KEY \|\| VITE_TWELVEDATA_KEY` |
| `MarketPulse/ci/scrape-pe.mjs:29` | `TD_GAP_MS = 8000` (8/min free tier) |
| `MarketPulse/ci/scrape-pe.mjs:37-42` | `thisMonday`: TD stamps weekly bars on **Monday**. Our own close gets the same stamp |
| `MarketPulse/ci/scrape-pe.mjs:44-53,61` | `DailyLimit`: matches "for the day" in a 429 body or JSON |
| `MarketPulse/ci/scrape-pe.mjs:57-67` | `weekly(t)`: `time_series?interval=1week&outputsize=262` → `[[YYYY-MM-DD(Mon), +close.toFixed(4)], …]` oldest first; 2 tries, 61 s sleep on per-minute 429 |
| `MarketPulse/ci/scrape-pe.mjs:99-103` | Called **only if** `hasEarnings && !c.closes?.length && TD && !stopTd`, so **once per ticker, ever**. On a DailyLimit, `stopTd` turns backfills off for the rest of the run. Any other TD error rethrows, and the whole ticker gets `err:true`, which also throws away the Finnhub EPS fetched just before |
| `MarketPulse/ci/scrape-pe.mjs:128` | `_asOf.json` entry gets `wait:true` while earnings exist but closes don't |
| `MarketPulse/ci/scrape-pe.mjs:151-157` | Each run, step 2 overwrites or appends the `thisMonday` bar with `stocks.json` `px` and keeps the last 262 bars. No API call |
| `MarketPulse/src/peHistory.ts:81-92` | `closeAt()` treats a bar's stamp as **Monday** and its close as Monday+4 (Friday). The stamp convention is load-bearing (BAC 2025-03-31 bug) |
| `MarketPulse/ci/track-requests.mjs:105-107` | Folds the lite run's `ci/cache/pe/<T>.json` (from RTDB `trackedPeCache`) "without re-spending its one Twelve Data call". The format passes through untouched |
| `MarketPulse/.github/workflows/site.yml:119-133` | "Refresh P/E history" step: env `FINNHUB_KEY`, `TWELVEDATA_KEY`, `TWELVEDATA_CI_KEY`, `LIMIT=200`, `continue-on-error` |
| `MarketPulse/.github/workflows/site.yml:234` | Build env `VITE_TWELVEDATA_KEY` (**app** chart, not CI; owned by the app part) |
| `MarketPulse/.github/workflows/track-requests.yml:69,77-79` | Lite run: same TD env for `ONLY=<new tickers>` scrape-pe |
| `MarketPulse/ci/README.md:19,816-825` | Docs: closes "from Twelve Data, fetched once per ticker"; rotation text still says `LIMIT=60` (stale; the workflow has 200) |

State today: 500 cache files, 443 with closes, 57 without. These are no-earnings or never-backfilled
tickers. `_asOf.json` has 231 `ok` and 269 not `ok`, with 0 `wait` and 0 `err`.

## 2. CNBC probe results (residential IP, browser UA)

All 500 cached tickers were fetched as `1W/20210101000000/20261022235959/adjusted`: **500/500 HTTP 200**,
avg 0.63 s, no throttling at about 1 request every 0.8 s. Compared against the committed TD `closes`:

- **Shape:** `barData.priceBars[]` holds `{open,high,low,close: "123.4500" (string), volume, tradeTime:"YYYYMMDD000000", tradeTimeinMills}`,
  oldest first. `requestDetails.adjusted` echoes the mode.
- **Stamp: Sunday** (`20261018…`, the week starting Monday 10-19). With **+1 day**, every TD Monday
  stamp lines up: 0 one-side-only dates on AAPL/BAC/TSM/ONON/CTVA. The last bar is the
  in-progress week, and step 2 already overwrites it with `px`.
- **390/443 match within 1%.** The median difference is 0.0. The values are not dividend-adjusted, same as TD.
- **`adjusted` ≠ TD semantics.** CNBC `adjusted` also back-adjusts **spin-offs and special dividends**.
  TD (and Finnhub EPS) are split-adjusted only:
  - CTVA spin-off (2026-09): CNBC pre-spin closes are ×0.15. That makes every pre-spin P/E 6.7× too low.
    It also hides the step that `peHistory`'s spin-off guard keys on.
  - Smaller cases: COST (2.3% special dividend, 2023-12), DLO (4.9%), BNTX (1.3%), ORKA.
  - `unadjusted` (same URL with `/unadjusted/`) is raw. For example, NVDA shows 522 before its splits.
  - **Fix that works on all probed cases:** fetch both modes. `r_i = unadj_i / adj_i` steps at each
    corporate action. Walk backward from the newest bar. A step equal to a split ratio (n or 1/n,
    ±1.5%) is a split, so keep it adjusted. Any other step is a distribution, so leave it unadjusted.
    `closes_i = unadj_i / (product of later split steps)`. Results:

    | Ticker | Result vs TD |
    |---|---|
    | NVDA | 4:1 and 10:1 detected; matches TD |
    | CTVA | 6.67 classed as distribution; matches TD |
    | COST, DLO, BNTX | match TD |
    | TRNR | 5 reverse splits detected (1:40, 1:100, 1:10, 1:10, 1:7) |
- **About 18 tickers have stale TD caches. This is a real existing bug.** Closes are fetched once and then frozen.
  A split *after* the backfill leaves pre-split unadjusted history with post-split `px` appended after it.
  Divergence vs CNBC is the split factor:
  - LGVN 10×, TRNR 7×, GAME 8×, SKYE 8×, REAX 10×, NXXT 10×, OPTT 30×, PSQH 15×, CRIS 20×
  - DFLI 8×, DFNS 125×, BLRX 40×, GUTS 12×, SNAL 5×, QTTB 18×, PPBT 20×, EVAX 5×, DNTH 1/16

  Finnhub EPS *is* re-adjusted, so those charts are wrong before the split. CNBC has no quota, so it
  lets us refetch periodically. That fixes this whole class of bug.
- **Known CNBC data gap:** CNBC's daily feed is missing **2023-04-06** (Thursday before Good Friday).
  That week's weekly close is Wednesday's, ≤1% off (AAPL 163.76 vs 164.66). It affects 1 week out of 262, so accept it.
- **Coverage gaps:**
  - LMFA and QNCX: `200 {"status":"ERROR","statusMessage":"… Security Master not found"}` (renamed/delisted).
  - Short histories: AIB has 32 bars vs TD 232 (relisted). FWONK has 169 vs 262 (CNBC history starts 2023-07).
    Accept these. A ≥26-week P/E still works.
  - Dot tickers: `BRK.B` works and `BRK-B` errors. Our tickers already use dots (`stocks.json` has
    none with other punctuation).
  - A sibling probe saw a **403 HTML** for unknown `ZZZZQ`. I got a 200 ERROR, so the 403 is intermittent.
- **Gating:** no UA → **403**. `curl/8` UA → **403**. Browser UA → 200. Headers `Akamai-GRN`,
  `X-Varnish`: Akamai bot management, so **datacenter-IP blocking is plausible.** The Worker
  (`MarketPulse/worker/index.js:31`, `quote.cnbc.com`, browser UA) shows Cloudflare egress gets
  through, but that is a different host, and GitHub runners use Azure IPs. **Unverified.**
- `ALL` history from 1980 returns 200 (357 KB for AAPL). Pass start = today − 5.3 y so we don't pull 45 years.

## 3. Replacement plan (exact changes)

### 3.1 New `ci/cnbc-bars.mjs` (no deps; injectable `fetchImpl` like `provider.mjs`)

```js
export const CNBC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
export class CnbcBlocked extends Error {}   // source-level: stop CNBC for the run
export class CnbcNoSymbol extends Error {}  // ticker-level: CNBC doesn't know it
const ymd = (d) => d.toISOString().slice(0, 10).replaceAll("-", "");
export const barsUrl = (sym, int, from, to, mode) =>
  `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/${int}/${ymd(from)}000000/${ymd(to)}235959/${mode}/EST5EDT.json`;
/** CNBC stamps a weekly bar on its Sunday; scrape-pe/peHistory use Monday. */
export const mondayOf = (tradeTime) => { /* YYYYMMDD → Date +1 day → YYYY-MM-DD */ };
/** Pure: [[mon, close]] split-adjusted only (spin-offs/special dividends NOT applied). */
export function splitOnlyCloses(adjBars, unadjBars) { /* §2 algorithm; drop non-finite/≤0, dedupe, strictly increasing */ }
export async function weeklyCloses(sym, { fetchImpl = fetch, years = 5.3, now = new Date() } = {}) {
  // GET adjusted + unadjusted (sequential), headers { "user-agent": CNBC_UA, accept: "application/json" },
  // AbortSignal.timeout(20000); return splitOnlyCloses(...).slice(-262)
}
```

Response classification for each GET:

| Response | Action |
|---|---|
| 200 + `priceBars` array | Data. |
| 200 + `status:"ERROR"` or empty `priceBars` | `CnbcNoSymbol`. |
| 403 / 401 / non-JSON HTML | Ambiguous: a block *or* an unknown symbol. Re-ask a **canary** (`AAPL`) once per run. Canary 403 → `CnbcBlocked`. Canary OK → `CnbcNoSymbol`. |
| 429 / 5xx / network / timeout | Retry ×2 with 2 s then 8 s backoff. Still failing → plain `Error` (ticker-level). Three consecutive tickers ending in network/5xx → `CnbcBlocked`, so we stop hammering. This is the same posture as the Worker's `failedUntil`. |

### 3.2 `ci/scrape-pe.mjs`

1. Replace lines 22-29 constants:

   ```js
   CNBC_GAP_MS = 300
   CLOSES_DAYS = Number(process.env.CLOSES_DAYS || 7)
   TD = …   // keep, fallback only (phase 1); delete in phase 2
   ```

2. Replace `weekly()` (57-67) with `prices(t)`:
   1. `weeklyCloses(t)`, paced at `CNBC_GAP_MS`.
   2. On `CnbcNoSymbol` or `CnbcBlocked`, fall back to the existing TD `weekly(t)` if `TD && !stopTd` (phase 1 only).
   3. `CnbcBlocked` sets `stopCnbc = true` and logs one line, like the `DailyLimit` handling.
3. Lines 99-103 condition becomes **refresh, not once**:

   ```js
   if (hasEarnings && !stopAll && (!c.closes?.length || !c.ca || now - Date.parse(c.ca) > CLOSES_DAYS*DAY)) {
     try { c.closes = await prices(t); c.ca = new Date().toISOString(); cnbcCalls += 2; }
     catch (e) { if (blocked/limit) stop…; else if (!c.closes?.length) throw e; /* keep old closes on a refresh failure */ }
   }
   ```

   - A refetch **replaces** `closes` wholesale. The series is re-anchored to the latest split, which fixes
     the ~18 stale tickers.
   - A failed *refresh* of a ticker that already has closes must not set `err`. It keeps the old series.
     A failed *first* fetch keeps today's `err`/backoff path.
   - **New cache field `ca`** (closes-at ISO). Missing means due, so the migration is automatic.
4. Line 37 comment: "weekly bars are stamped Monday (CNBC's Sunday +1)". The `thisMonday` logic is unchanged.
5. Last line telemetry: `done: … (${cnbcCalls} cnbc, ${tdCalls} td fallback${stopCnbc?", CNBC BLOCKED":""})`.
   Grep this line in the run log during the watch phase.

### 3.3 Cost / rate bound

- **Steady state:** 500 tickers / 7 days ≈ 72 refetches/day ≈ 15 a run (5 h cron), × 2 calls = **~30 CNBC calls a run**.
  The 200-ticker Finnhub rotation still drives runtime: 200 × 1.1 s ≈ 3.7 min. CNBC adds ~15 × 1.6 s ≈ 25 s.
- **Migration** (no cache has `ca`): every rotated ticker refetches. LIMIT=200 means 400 calls a run, about +5 min
  for ~2.5 runs, then steady state.
- To keep the step short, cap refetches per run with `CNBC_MAX=60` (oldest `ca` first). That limits it to
  ≤120 calls / ~1.5 min, and the migration spreads over about 8 runs (~2 days). **Recommended.**
- The lite `track-requests` run uses `ONLY` with a handful of tickers, so ~2 calls each.
- No quota is known. Keep `CNBC_GAP_MS ≥ 300` and a single in-flight request (undocumented API: be polite).

## 4. Output compatibility

- `public/pe/<T>.json` and `_asOf.json`: **format unchanged.** They are derived from the cache by the same
  `peSeries`. `_asOf` semantics are unchanged:
  - `wait` now means "CNBC blocked/unknown and no TD fallback" instead of "TD quota".
  - `err` stays first-fetch only.

  The app (`MarketPulse/src/components/StockModal.tsx:104-110`, `PeHistory.tsx:46`) needs no change.
- `ci/cache/pe/<T>.json`: `closes` keeps the same `[Monday ISO, number(≤4dp)]` shape, and one additive `ca` field is added.
  `track-requests.mjs` passes cache files through opaquely, so it is compatible.
- **Not byte-identical by design** for:

  | Ticker set | What changes |
  |---|---|
  | ~18 split-stale tickers | Corrected; their P/E charts change, which is the point |
  | Tickers with special dividends | Unchanged, because of split-only reconstruction |
  | All tickers, week of 2023-04-03 | ≤1% |
  | Micro-caps where TD prices were coarse | ±1-3% on some weeks (ABEO, AGEN) |

  Expect a one-time large `ci/cache/pe` diff spread over the migration runs. The diff is gated by `test-pe-files.mjs` as today.
- Optional golden check before shipping (0 TD calls): run CNBC `splitOnlyCloses` against committed TD closes
  for all 443 tickers. Pass = only the known categories above. This is `test-data-ci.md` §3.2.

## 5. Tests (auto-discovered, `ci/test-*.mjs`)

- **`ci/test-cnbc-bars.mjs`** with trimmed real fixtures in `ci/fixtures/cnbc/` (both modes):

  | Case | Assertion |
  |---|---|
  | AAPL | Sunday → Monday stamps |
  | NVDA | 4:1 and 10:1 splits = adjusted |
  | CTVA | Spin-off kept unadjusted (78.52 → 11.92 step preserved) |
  | COST | Special dividend not applied |
  | TRNR | Chained reverse splits incl. 1:7 |
  | ERROR / empty | → `CnbcNoSymbol` |
  | 403 + canary 403 | → `CnbcBlocked`; 403 + canary 200 → `CnbcNoSymbol` |
  | Retries | 5xx retried, then error |
  | Malformed close | `"0.0000"` or `"--"` dropped; output strictly increasing |

  Uses the injectable `fetchImpl`. No network in tests.
- **Cache-shape guard** (in the same file, or extend `test-pe-files.mjs`): every `ci/cache/pe/*.json`
  `closes` date is a **Monday** and strictly increasing. This catches a forgotten +1 day, which would
  silently shift `closeAt`'s Friday by one day.
- `test-pe-files.mjs` and `test-track-requests.mjs` stay unchanged. Fix the comment at
  `MarketPulse/ci/test-track-requests.mjs` only if it mentions TD (it doesn't today).
- The `track-requests.yml` DATA GATE regex (line 103) needs no change: the new test is a code test, not a data gate.

## 6. If CNBC blocks GitHub runners

Fallback ladder, cheapest first:

1. **Phase 1 keeps TD** as automatic fallback, so a block degrades to today's behavior.
2. **FlareSolverr** is already a service in `site.yml`, and the lite run starts it in the background.
   GET the bars URL through it and parse the JSON out of `solution.response` (`<pre>…</pre>`).
   The scrapers already do this for TipRanks and Finviz.
3. **Worker `/bars` relay** (Cloudflare egress already reaches CNBC). The Worker is app-origin-only
   and deployed by hand, so this needs a CI auth header. Coordinate with `td-worker.md` if it adds a
   `/bars` route for the app anyway. CI could reuse it with a shared secret.

   **Verification needed before phase 2:** a branch-only probe workflow with no secrets that curls
   3 tickers in both modes, plus a canary 403 check (spec in `test-data-ci.md`). Needs the user's go-ahead.

## 7. Rollout + secrets cleanup order

1. **PR 1:** `cnbc-bars.mjs`, scrape-pe CNBC-first with TD fallback, tests, docs. Workflows are untouched,
   so the TD env stays available as fallback.
2. **Probe** CNBC from a runner (§6). If it's blocked, switch PR 1's transport to FlareSolverr before merging.
3. **Watch** ~10 scheduled runs (2 days). Expect `0 td fallback` except for real `CnbcNoSymbol`, never
   `CNBC BLOCKED`, and the migration to finish (every cache entry has `ca`).
4. **PR 2:** delete the TD path from `scrape-pe.mjs` (`TD`, `TD_GAP_MS`, `DailyLimit`, `weekly`, `stopTd`).
   Drop `TWELVEDATA_KEY` / `TWELVEDATA_CI_KEY` from `site.yml:130-131` and `track-requests.yml:78-79`.
5. **After PR 2 runs green on main:** delete the repo secret **`TWELVEDATA_CI_KEY`** (CI-only).
6. **`TWELVEDATA_KEY` stays** until the app part removes TD from `StockModal`, because `site.yml:234` builds it into the bundle.
   Then remove line 234, `VITE_TWELVEDATA_KEY` from `src/vite-env.d.ts` and `.env.local`, then delete the secret.
   Always remove the code reference first and the secret last.

## 8. Docs to update (same PRs)

| File | Change |
|---|---|
| `MarketPulse/ci/scrape-pe.mjs:5-9,23-24,37` | Header: closes from CNBC, refreshed every `CLOSES_DAYS`, split-only reconstruction |
| `MarketPulse/ci/README.md:816-825` | Closes bullet (source, UA requirement, Sunday+1, adjusted vs unadjusted rationale with CTVA/COST, refresh clock, `ca` field, Good-Friday-2023 gap, block fallback). Fix stale `LIMIT=60` → 200 |
| `MarketPulse/ci/README.md:19` | Build keys (PR 2/app part) |
| `MarketPulse/.github/workflows/site.yml:119-123,132` | Step comments |
| `MarketPulse/.github/workflows/track-requests.yml:69` | Comment |
| `MarketPulse/ci/track-requests.mjs:105-106` | Comment "one Twelve Data call" → "its CNBC closes" |
| `MarketPulse/src/peHistory.ts:81` | "Twelve Data stamps a weekly bar with its Monday" → "weekly bars are Monday-stamped (CNBC's Sunday stamp +1 in ci/cnbc-bars.mjs)" |
| `MarketPulse/CLAUDE.md:30-33` | Secrets list, after step 6 |
