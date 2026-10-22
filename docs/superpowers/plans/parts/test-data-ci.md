# Part: data accuracy, CI verification and monitoring — Twelve Data → CNBC bars

Scope: the app chart (`src/components/StockModal.tsx` `fetchSeries`, `src/chartSession.ts`) and
`ci/scrape-pe.mjs` `weekly()` move from Twelve Data (TD) to
`https://ts-api.cnbc.com/harmony/app/bars/{SYM}/{INT}/{start}/{end}/adjusted/EST5EDT.json`
(`start`/`end` = `YYYYMMDDHHmmss`, INT `5M|30M|1D|1W|1MO`).
This part covers only how we prove the data is right, how CI gets exercised without touching
`main`/deploy, and what to watch afterwards. It does not cover the code change itself.

---

## 0. Findings from the live sample (2026-10-22, ~13:00 ET, market open)

7 TD calls total (AAPL, BRK.B, GOSS × `1day`/260 + `1week`/262, plus AAPL `5min`/78). CNBC called
with the same symbols. Scripts used: scratchpad `cmp.py` + `golden.mjs` (copied in §3.2).

| Ticker | Series | Common bars | Close diff median | Close diff max | Bars > 1¢ | Volume CNBC/TD | Missing days |
|---|---|---|---|---|---|---|---|
| AAPL | daily (1y) | 259 | 0.000% | 0.000% | 0 | 0.993–1.002 | none |
| AAPL | weekly (5y) | 261 | 0.000% | 0.55% | 1 (wk 2023-04-03) | median 1.000, min 0.77 | none |
| BRK.B | daily | 259 | 0.000% | 0.000% | 0 | 0.965–1.002 | none |
| BRK.B | weekly | 261 | 0.000% | 0.68% | 1 (wk 2023-04-03) | median 1.000 | none |
| GOSS (micro, reverse-split history) | daily | 259 | 0.000% | 0.35% | 106 (sub-cent rounding of adjusted px, e.g. 33.84 vs 33.864) | 0.994–1.008 | none |
| GOSS | weekly | 261 | 0.000% | 8.26% (wk 2023-04-03) | 60 (rounding) | median 1.000 | none |
| AAPL | 5-min, today | 42 | 0.005% | 0.03% | — | — | — |

Golden diff, **0 TD calls**: CNBC `1W` vs the committed TD history in `ci/cache/pe/<T>.json`
(`closes`, last bar excluded) for 34 tickers (NVDA, LLY, TSM, AAPL, GOSS, ORLY, AVGO, WMT, CMG +
25 random): 261/261 weeks present for every ticker, median diff 0.000% everywhere.
Only exceptions:

- **Week of 2023-04-03 differs for ~every ticker (0.3–9%)**: CNBC has **no bar for Thu
  2023-04-06** (a normal trading day, before Good Friday) in `1D` *and* `1W`. Its weekly bar
  closes on Wed. It's the only non-holiday weekday missing from AAPL's 2021–2026 daily
  series. All the other 56 gaps are NYSE holidays (incl. 2025-01-09 Carter day of mourning).
- **BNTX**: 33 weeks 2021–2023 differ by 1.3–2.6%. CNBC is lower, so CNBC back-adjusts for
  BNTX's special dividends and TD doesn't. Expect the same on any special-dividend payer.
- **CATX, IMNN** (multiple reverse splits): 5–21 weeks within ±1.5%, from rounding of
  reverse-split-adjusted cents. **ACIU** (1 week, 4.4%) and **BZAI** (1 recent week, 1.4%) are one-offs.
- **Splits match exactly**: NVDA 10:1, AVGO 10:1, CMG 50:1, ORLY 15:1, WMT 3:1. TSM ADR also matches.

Behaviour differences the code must handle:

| Topic | TD | CNBC |
|---|---|---|
| Weekly bar stamp | Monday | **Sunday** (`tradeTime` `20261018000000`). Add +1 day to keep `thisMonday` logic in scrape-pe |
| Today's daily bar mid-session | included (partial) | **absent** (last = yesterday); current week's `1W` bar stops at yesterday |
| 5M/30M session | regular hours, rolling last N bars (spans yesterday) | **04:00–20:00 extended hours** for the requested window. chartSession must drop bars outside 09:30–16:00, and today's request must use start = today 00:00 |
| Intraday stamp | bar start, `YYYY-MM-DD HH:MM:SS` | bar start, `YYYYMMDDHHmmss` (5-min closes align at offset 0, not +5) |
| Adjustment | split-adjusted, **not** dividend-adjusted | split-adjusted, regular dividends **not** adjusted (AAPL 2021-01-08 = 132.05 raw); **special dividends adjusted** (BNTX) |
| Order | newest-first | oldest-first |
| Numbers | strings | OHLC strings with 4 dp, volume as a number |
| Unknown symbol | `status:"error"` | **200 with empty `priceBars`** (`BRK-B`, `^GSPC`) **or 403 HTML** (`ZZZZQ`). Treat empty as "no series" and never as "zero history". |
| Symbols | `BRK.B` | `BRK.B` works, `BRK-B` doesn't. Indices are `.SPX`. ETFs work (SPY) |
| UA | n/a | curl's default UA gets **403** (Akamai). Node 24 `fetch` default UA → 200. Browser → 200, `Access-Control-Allow-Origin: *`, `Cache-Control: max-age=180` |
| Monthly | 1st of month | 1st of month, history from 1980 |
| Quota | 8/min, 800/day, shared with visitors | none observed. Pace anyway (≥ 300 ms) |

### Tolerances (use these in the checks below)

- Daily close, matching dates: **|Δ| ≤ max(0.5¢, 0.05%)** for ≥ 99% of bars. Allow up to 0.5% on
  sub-$1 or reverse-split names (rounding).
- Weekly close: same, **excluding the week of 2023-04-03** and confirmed special-dividend
  tickers. Any other week > 1% means investigate: a ratio near an integer or 1/integer is a split mismatch, and that blocks.
- 5-min close (regular session): ≤ 0.1%.
- Volume: daily ratio 0.95–1.05. Weekly isn't gated, because holiday and missing-day weeks drift up to 25%.
- Bar count: weekly 5Y ≥ 255 bars for a ticker listed 5y+, no gaps except NYSE holidays + 2023-04-06.
- P/E output (`public/pe/<T>.json`): same point dates. P/E values within 1% except the 2023-04-03 week.

---

## 1. Pre-work (local, no network writes)

- [ ] `cd ~/Desktop/Nitzan/MarketPulse && git switch -c cnbc-bars` (new branch off `main`, in this clone, no worktree).
- [ ] Node ≥ 22.18 for tests (`node -v`), 20–22 for `npm run dev`.
- [ ] `npm test` is green on the untouched branch, so you have a baseline.
- [ ] Snapshot the goldens before any change:
  ```bash
  G=$(mktemp -d)/golden && mkdir -p $G && cp -R public/pe ci/cache/pe $G/ && echo $G
  ```

## 2. Accuracy matrix (8 tickers, ≤ 16 TD calls, 8 s apart)

Tickers: **AAPL, NVDA (10:1 2024 split), LLY, TSM (ADR), SPY (ETF), BRK.B (dot symbol),
GOSS or ATCX (micro-cap), ORLY (15:1 2025 split)**. AAPL, BRK.B and GOSS are already measured in §0,
so the remaining 5 cost ≤ 10 TD calls (`1day`/260 + `1week`/262 each). Do **not** spend TD calls
on weekly history for tickers already in `ci/cache/pe`: those closes *are* the TD golden (§3.2).

- [ ] For each ticker, compare daily (1y) and weekly (5y) per the tolerance table. Record median/max
      close Δ, count > 1¢, volume ratio range, and dates present on one side only.
- [ ] Confirm the Sunday→Monday +1 shift lines up all weekly bars (0 one-side-only dates).
- [ ] Spot-check that dividends aren't adjusted: AAPL 2021-01-08 close must be 132.05 on both.
- [ ] Split check: NVDA 2024-06-07 weekly close ≈ 120.88 (post-split basis) on both.
- [ ] App intervals: for one ticker, request `5M` (today 00:00 → tomorrow 00:00), `30M` (last 7
      calendar days), `1MO` (1980 → today). Assert that after the 09:30–16:00 filter the 1D chart has
      ≤ 78 bars, all dated today (or the last session when the market is closed).
- [ ] Re-run the AAPL `1D` request after 16:15 ET and after 20:15 ET, to see when today's daily bar
      appears. This decides whether the 1M/3M/… chart needs today's quote appended.
- [ ] Market-closed run (weekend): `5M` for "today" returns 0 bars, so the code must fall back to the last
      session. Verify the fallback by requesting a 4-day window and keeping the latest date.

## 3. CI dry-run

### 3.1 Local dry-run of the new scrape-pe (never writes the real tree)

`scrape-pe.mjs` hard-codes `public/pe` and `ci/cache/pe`, so run it in a throwaway copy:
```bash
D=$(mktemp -d)/mp && rsync -a --exclude node_modules --exclude .git ~/Desktop/Nitzan/MarketPulse/ $D/ \
  && ln -s ~/Desktop/Nitzan/MarketPulse/node_modules $D/node_modules && cd $D
# (a) steady state: cached closes exist, so expect 0 price calls
FINNHUB_KEY=… LIMIT=5 node ci/scrape-pe.mjs
# (b) backfill path: wipe closes for a few tickers so the CNBC fetch runs
for t in AAPL NVDA BRK.B GOSS ORLY; do node -e "const f='ci/cache/pe/$t.json',fs=require('fs'),c=JSON.parse(fs.readFileSync(f));delete c.closes;fs.writeFileSync(f,JSON.stringify(c)+'\n')"; done
FINNHUB_KEY=… ONLY=AAPL,NVDA,BRK.B,GOSS,ORLY node ci/scrape-pe.mjs
npm test   # THE DATA GATE, locally, on the files just written
```
- [ ] The (a) log reads `0 price backfills` and `done: … charts written` with no `skip` lines.
- [ ] The (b) log reads `5 price backfills`, and `_asOf.json` has `ok:true` and no `wait`/`err` for the 5.
- [ ] Recommended implementation knob, which makes this one command without the `node -e` step:
      `PE_OUT`/`PE_CACHE` env overrides + `REFETCH=1` (refetch closes even if cached).
- [ ] Run `TWELVEDATA_KEY= TWELVEDATA_CI_KEY= VITE_TWELVEDATA_KEY=` (empty) to prove the new path
      doesn't need TD.

### 3.2 Golden diff vs committed files

- [ ] **Cache closes**: for every ticker from (b), diff the new `closes` against `$G/pe/<T>.json` (the
      cache copy) by date, last bar excluded. Pass = tolerance table §0. Fail = any week
      > 1% outside 2023-04-03, or any missing date.
- [ ] **P/E output**: diff `public/pe/<T>.json` vs `$G/pe/<T>.json` (the public copy). Same `pts` dates,
      same null/flag positions, values within 1% except the 2023-04-03 week. `asOf` will differ, and that's fine.
- [ ] **Breadth, CNBC-only (0 TD calls)**: run the golden script over all ~436 cached tickers
      (~4 min at 500 ms pacing) and list the tickers with > 1% weeks:
      ```bash
      cd ~/Desktop/Nitzan/MarketPulse
      node <scratch>/golden.mjs $(node -e 'const fs=require("fs");console.log(fs.readdirSync("ci/cache/pe").map(f=>f.slice(0,-5)).filter(t=>(JSON.parse(fs.readFileSync("ci/cache/pe/"+t+".json")).closes||[]).length>50).join(","))')
      ```
      `golden.mjs` is a read-only fetch-and-compare. The copy used today is in the session scratchpad. Re-create it under `$TMPDIR`, not in the repo.
      Expect only the 2023-04-03 week, special-dividend names and reverse-split rounding.
      An integer-ratio mismatch means TD's cache predates a later split. That's a stale-cache bug in today's
      data that CNBC would *fix*. List those tickers for an explicit refetch.
- [ ] **Decision to record**: keep existing cached TD closes (only new tickers use CNBC), or
      refetch everything. Recommendation: **keep**, and refetch only the integer-ratio list above.
      Lowest diff, zero change to 400+ shipped charts.

### 3.3 Branch workflow (never `main`, never deploy)

**Do not `workflow_dispatch` site.yml on the branch.** Its commit step pushes to the checked-out
ref and its deploy step publishes Pages from it. Instead:

- [ ] Push the branch, so `tests.yml` runs `npm test` (code gate + data gate over the branch's committed
      files). It must be green.
- [ ] Add a **throwaway** workflow on the branch only, e.g. `.github/workflows/cnbc-probe.yml`:
      `on: push: branches: [cnbc-bars]`, `permissions: contents: read`, no secrets except
      `FINNHUB_KEY`, no commit/deploy steps. (`workflow_dispatch` only works once the file is on `main`, which is
      why it uses the branch push trigger.) Steps:
  1. **Reachability (one-off)**: `node -e` fetch of `AAPL/1W`, `AAPL/5M`, `SPY/1D`, `BRK.B/1D` with
     the default Node UA and again with a browser UA. Print status, bar count and the first 200 bytes on
     non-200. Also `curl -sI` to log the Akamai response headers. **Pass = 200 with bars from the
     Azure runner.** A 403 here means GitHub-hosted runners are blocked. In that case route scrape-pe's CNBC
     call through the existing Worker (add a `/bars` relay) or FlareSolverr, and re-test.
  2. §3.1 (b) in the runner workspace (`ONLY=…`), then `npm test` = the DATA GATE run twice
     (before and after, exactly like site.yml).
  3. `git diff --stat public/pe ci/cache/pe` plus upload both dirs as an artifact for the §3.2 diff.
     **No** `git push`.
- [ ] Run it at least twice: once in market hours and once on a weekend (empty-today path).
- [ ] Delete `cnbc-probe.yml` from the branch before the PR. It must never reach `main`.

### 3.4 Merge gate

- [ ] `npm test` green locally + `tests.yml` green on the PR.
- [ ] §2 matrix and §3.2 diffs pass, with results pasted into the PR body.
- [ ] Reachability probe green from a GitHub-hosted runner.
- [ ] Fallback path tested (§4) with CNBC forced to fail (`CNBC_BARS_URL=https://ts-api.cnbc.com/nope`
      or the equivalent knob). The ticker lands in `_asOf.json` as `err` with backoff, and the DATA GATE stays green.

## 4. Rollback / fallback to TD

- [ ] Ship with the TD code path still present behind one switch:
      `PE_PRICE_SOURCE=cnbc|td` for scrape-pe, and a const in StockModal for the app.
      Default `cnbc`, with an automatic per-call fallback to TD when CNBC fails (non-200, empty `priceBars`)
      **and** a TD key is set.
- [ ] Rollback = set `PE_PRICE_SOURCE: td` in site.yml (one-line PR), or `git revert` the merge.
      Cached closes are source-agnostic `[date, close]` with Monday stamps, so mixing is safe as long
      as the +1 day shift is in place.
- [ ] Keep the `TWELVEDATA_*` secrets until §6 completes. Without them the fallback is dead.

## 5. Monitoring after rollout

Watch for **2 weeks** (≈ 67 cron runs, 2 Monday rollovers), and through **Thanksgiving week
2026-11-23..27**. Holiday-shortened weeks are where the CNBC hole showed up, so the first post-holiday
Monday must be checked.

- [ ] Each site.yml run, "Refresh P/E history" log: `done: N refreshed (K price backfills), F failed`.
      Alert if `F` > baseline (compare with 5 pre-rollout runs) or any `HTTP 403` / `no values`.
- [ ] `public/pe/_asOf.json`: count `err:true`, `wait:true`, `ok:true`. `ok` must not drop, and
      `wait` must drain (new tickers get history on their first run now that the quota is gone).
      ```bash
      node -e 'const i=require("./public/pe/_asOf.json"),v=Object.values(i);console.log({n:v.length,ok:v.filter(e=>e.ok).length,err:v.filter(e=>e.err).length,wait:v.filter(e=>e.wait).length})'
      ```
- [ ] DATA GATE never red because of pe (`test-pe-files.mjs`).
- [ ] Monday after rollout: the newest `closes` bar in a few caches is stamped Monday (not Sunday)
      with no duplicate week. A Sunday stamp means the +1 shift regressed and produces duplicate weekly points.
- [ ] App: open the modal for AAPL, BRK.B, SPY, a micro-cap and a new off-universe ticker, across all 10 ranges,
      in market hours, after-hours and on the weekend. The 1D axis is 09:30–16:00 with no pre-market bars,
      no console errors, and the last close is within 0.1% of the live quote.
- [ ] Week 2: re-run the §3.2 breadth golden diff once. Diffs must stay only the known classes.

## 6. Removing the TWELVEDATA_KEY secret (order matters)

1. [ ] App on CNBC deployed and verified (§5 app checks), with the TD fallback still compiled in.
2. [ ] scrape-pe on CNBC for ≥ 2 weeks with no fallback hits in logs.
3. [ ] PR: remove the TD fallback code and every reference: `site.yml` (`VITE_TWELVEDATA_KEY` build
       env, `TWELVEDATA_KEY`/`TWELVEDATA_CI_KEY` on the P/E step), `src/vite-env.d.ts`, StockModal,
       the `chartSession.ts` comments, `ci/README.md`, `CLAUDE.md` keys line. `grep -rni twelvedata` must
       return nothing outside git history.
4. [ ] Merge, then confirm one full green scheduled site.yml run (DATA GATE included) without TD.
5. [ ] Delete the secrets: `gh secret delete TWELVEDATA_KEY` and `gh secret delete TWELVEDATA_CI_KEY`
       (personal repo, so run as `nitzan-massad`).
6. [ ] **Revoke the TD key in the Twelve Data dashboard.** It has been embedded in the public JS bundle
       (`VITE_` prefix), so deleting the secret alone doesn't retire it.
7. [ ] Remove `VITE_TWELVEDATA_KEY` from `.env.local`.

Deleting a secret that a workflow still references doesn't fail the run (it expands to `""`).
That's exactly why step 3 must come first: otherwise the fallback silently dies and nothing tells you.
