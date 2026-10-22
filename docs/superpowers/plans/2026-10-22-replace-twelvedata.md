# Replace Twelve Data with CNBC (app chart, Volume, P/E history, CI)

Status: planned, not started. Branch base: `feat/cnbc-quotes`.
Detail lives in `parts/` — this file is the index, the decisions that reconcile the parts, and the order of work.

| Part | File |
|---|---|
| Worker `GET /bars` endpoint | [parts/td-worker.md](parts/td-worker.md) |
| App chart (all ranges, 1D session logic) | [parts/td-app-chart.md](parts/td-app-chart.md) |
| App Volume stat + P/E history overlay + env cleanup | [parts/td-app-volume-pe.md](parts/td-app-volume-pe.md) |
| CI `ci/scrape-pe.mjs` + workflows + secrets | [parts/td-ci.md](parts/td-ci.md) |
| Test plan — unit / contract | [parts/test-unit.md](parts/test-unit.md) |
| Test plan — browser E2E, no-degradation gate | [parts/test-e2e.md](parts/test-e2e.md) |
| Test plan — data accuracy + CI verification + monitoring | [parts/test-data-ci.md](parts/test-data-ci.md) |

## Where Twelve Data is used today

1. Modal chart, every range 1D…ALL (`src/components/StockModal.tsx` `fetchSeries`).
2. Modal "Volume" stat — last bar of the *selected range* (on 1D a single 5-min bar: wrong today).
3. P/E history overlay, live path for off-universe tickers (`fetchSeries(t, "5Y")`).
4. CI `ci/scrape-pe.mjs` — one-time 5-year weekly-closes backfill per ticker, from `site.yml` and `track-requests.yml`.
Shared free key: 8 calls/min, 800/day for every visitor, and it ships inside the public JS bundle.

## CNBC source (verified by probes, 2026-10-22)

`https://ts-api.cnbc.com/harmony/app/bars/{SYM}/{INT}/{start}/{end}/{adjusted|unadjusted}/EST5EDT.json`,
INT 5M/30M/1D/1W/1MO. No key, CORS open, needs a browser User-Agent, undocumented.
Accuracy vs Twelve Data: daily closes identical (AAPL, BRK.B), 261/261 weeks present for 34 tickers, splits identical.

## Decisions reconciling the parts

| Topic | Decision | Why |
|---|---|---|
| Endpoint | `GET /bars?symbol=&range=` on the existing Worker; the server computes the window (the client never sends dates) | CNBC doesn't cap windows (a 2 MB answer for 5M since Jan 1) |
| Response | `{s,r,i,asOf,t[],c[],v[]}`, closes only, Twelve-Data-style stamps | chart/session/P/E code keeps its shape; 0.3–6.4 KB gzipped |
| Pre/post bars | trimmed on the server (09:30–16:00 ET) for 1D/1W | same 78 bars/day Twelve Data gave |
| 1D window | the last 5 calendar days, client picks the latest session | pre-market/weekend/holiday still show the prior session + its prev close |
| Weekly stamps | the server shifts Sunday → Monday | `peHistory.ts` and the CI cache expect Monday |
| Today on daily+ ranges | client `withLive`: append/patch today's bar from the CNBC quote | CNBC daily bars stop at yesterday |
| Adjustment | chart: `adjusted`. P/E (app live path + CI): **split-only** = combine `adjusted` + `unadjusted` | CNBC `adjusted` also removes spin-offs/special dividends (CTVA ×0.15) — P/E would be wrong |
| Volume stat | the session total from the CNBC quote (`volume`, add to `parseQuote`); `—` if no/stale quote | never sum intraday bars (the 16:00 auction bar alone is 3× the day) |
| Errors | CNBC `200 + status:"ERROR"` → Worker 404 (cached 1 h); outage → 502 remembered 30 s | separate failure memory from `/quotes` |
| Cache | byte-bounded (8 MB), TTL 1D 60 s · 1W 5 min · 1M–5Y 1 h · ALL 6 h, in-flight coalescing, 5 s timeout | ~300 Worker req/day ≈ 0.3% of the free quota |
| Module names | `worker/bars.js` (pure), `src/chartBars.ts` (pure, `.check.ts`) | one shared parser for chart + P/E |
| Fallback | keep Twelve Data as an automatic fallback for one release (app and CI), then remove | CNBC is undocumented; GitHub-runner reachability untested |
| Secrets | remove code + workflow env → one green scheduled run → delete `TWELVEDATA_*` secrets → **revoke the key** (it shipped publicly) | safe order |

## Order of work

1. **Worker** `/bars` + `worker/bars.js` + tests (parts/td-worker.md §1–8). Deploy to the Worker (non-breaking: new route).
2. **Quote volume**: add `vol` back to `parseQuote` (session total) + test.
3. **App chart**: `src/chartBars.ts` + `.check.ts`; `fetchSeries` → `/bars` with Twelve Data fallback; `withLive`; 1D session table (parts/td-app-chart.md).
4. **Volume stat** from the quote; **P/E live path** split-only (parts/td-app-volume-pe.md).
5. **CI**: one branch-only probe workflow (CNBC reachable from GitHub runners?) — needs a go-ahead; then `scrape-pe.mjs` CNBC-first with Twelve Data fallback, split-only, 7-day refetch (`ca`) fixing ~18 stale-split tickers (parts/td-ci.md).
6. **Run the test plan** (below); merge gate passes.
7. After ~10 green scheduled runs: remove Twelve Data code, env, secrets; revoke the key; update CLAUDE.md + ci/README.md.

## Test plan (runnable)

1. Unit/contract — `npm test` with the new files from parts/test-unit.md (5 new ci tests, `src/chartBars.check.ts`, `peHistory.check.ts` additions, 25 mutation targets; real CNBC fixtures saved in `parts/cnbc-bars-fixtures/` (27 files), to be trimmed into `ci/fixtures/`).
2. Data accuracy — parts/test-data-ci.md §1 (`cmp.py`, `golden.mjs`): closes per date within the stated tolerances; `public/pe` golden diff only on the known tickers.
3. Browser E2E — parts/test-e2e.md: `bars-compare` (10 tickers × 10 ranges main vs branch), `bars-sessions`, `bars-fail`, `bars-mobile`, `bars-perf`, `bars-net`, plus `regress.mjs` R23–R32 (its chart stubs must intercept `/bars` too).
4. CI — branch-only runner probe, local dry-run in a temp copy, data gate (`npm test` before/after).
5. **Merge gate** (all must hold): every main-green regression test stays green · every ticker/range main charts, the branch charts with ≥ bars · accuracy within tolerance · Volume identical across ranges · card height stable in failure states · median time-to-chart ≤ main + 100 ms · zero `api.twelvedata.com` requests in the app.
6. Monitoring for 2 weeks incl. Thanksgiving week (short-week gaps showed up in CNBC's 2023 Good Friday week).

## Pros and cons

| Pros | Cons |
|---|---|
| No 8/min · 800/day limit → "chart unavailable" disappears under load | CNBC bars API is undocumented — can change or block without notice |
| No key in the public bundle (today's Twelve Data key is exposed) | One more Worker endpoint to run; free-tier budget shared with `/quotes` |
| Fixes the Volume stat (today it's one 5-min bar) | GitHub-runner reachability for CI unproven (Akamai may block datacenter IPs) |
| Fixes ~18 tickers with wrong pre-split P/E history in CI | Split-only P/E needs two CNBC calls (adjusted + unadjusted) |
| Faster repeat views (Worker cache, ~60 ms) | Known data quirks: Sunday weekly stamps, missing 2023-04-06 bar, special-dividend adjustment, extended-hours intraday bars — all handled in code, but more logic to maintain |
| One price vendor for quotes + charts → consistent numbers | Single vendor = single point of failure (mitigated by the Twelve Data fallback for one release) |
