# E2E Verification Plan: getData replacement (`fix/replace-getdata`)

**Goal:** prove, before merge, that after the switch **every number is the same, no information is lost, and nothing degrades**: data, UI and CI.
**Branch under test:** `fix/replace-getdata` (20 commits on `c242d0cc4`). Implementation plan: `2026-11-18-replace-getdata.md`.

## Pass criteria (all must hold)
1. **Data, same input:** old code (`c242d0cc4`) and new code (HEAD), run on the same recorded TipRanks responses, produce no differences except a short list of intended ones. The intended ones are:
   - "General" sector carried over;
   - Jack Zhou appearing (the uid fix);
   - stars computed from rank;
   - stored ratings keeping their firm and target.
2. **Data, mapping:** 100% of new values equal the recorded source value they come from, and no row switches its consensus basis (D1).
3. **Data, snapshot:** compared with `c242d0cc4`, for the rows `getData` used to fill:
   - zero regressions (a value turning to null, or a lost row, ticker or rating);
   - each field's change stays within the drift seen across 60 historical snapshot pairs;
   - at most 1% unexplained per field, each checked by hand.
4. **Coverage:** all ~557 tickers, all 17 row fields, all ~564 analyst files, `seen.json`, bull/bear, P/E, reviews-recent and RTDB `trackedRows`.
5. **UI (Playwright):** the text extracted from every view and from every stock's detail view (all ~557) shows no "—" where a value was, no fewer rows, and no missing ticker. Every remaining difference must be one already explained by the data layer.
6. **CI:**
   - total run time ≤ the baseline (last 4 good runs: 27–49 min);
   - refresh step ≤ 12 min;
   - backfill carries ≤ 2 rows; enrich at 100/100;
   - analyst files written ≥ 331, with 0 failed;
   - bull/bear failures ≤ the baseline (~23);
   - data-loss check and health check both green.
7. **Failure handling:** 11 injected failures each end with no data lost, a red run where expected, and a bounded run time.

## Phases (in order)
| # | Phase | Detail | Needs approval |
|---|---|---|---|
| 0 | **Fix before testing** | (a) `dry_run` is not read-only: the "Pin requested tickers" step deletes requests in the live RTDB (`ci/track-requests.mjs:353-354`), so skip it when `dry_run` is set. (b) Add an `upload-artifact` step to dry runs (produced data, `health`, `dropped.json`). (c) An `RTDB_URL` override for emulator tests. Each change goes through a task review. | No (branch-only) |
| 1 | Offline checks | Fixture-based mapper parity in `ci/test-parity-mappers.mjs`, run by `npm test`; the 11 injected failures run locally with a fetch stub | No |
| 2 | Capture run | About 1,300 TipRanks requests over 25–35 min to record the source responses, done locally. **Never `getData`** | **Yes** |
| 3 | Data parity report | Same-input runs, mapping check and snapshot comparison → `parity-report.md` (under 2 min, offline) | No |
| 4 | UI parity | Playwright, 3 builds (old code with old data, new code with old data, new code with new data), frozen network and clock, about 35 min. Install `@playwright/test@1.63.0` in the **scratchpad only** | **Yes** (install) |
| 5 | Track flow | Firebase emulator: the NNNN happy path, a junk-ticker failure (the `err` field, the app's failed state, the 24h clear) | No |
| 6 | GitHub dry run | Cancel run `44445363564`, push the branch, run `site.yml` with `dry_run=true`, download the artifact, then repeat phases 3 and 4 on the CI-produced data and check the CI criteria | **Yes** (cancel, push, dispatch) |
| 7 | Merge + monitor | Merge, run `track-requests` for NNNN and one junk ticker from a test account, watch the first 8 scheduled runs. Rollback triggers are below. A rollback also means pausing the schedule, because `getData` is still blocked | **Yes** |

## Known limits (accepted)
- Facts only `getData` had (the per-rating firm and converted targets for hidden analysts) can't be checked again. The stand-in check is that every stored rating survives unchanged.
- The "tracked" request state can't be reached in local login mode; it is covered by `src/trackState.check.ts`.

---
# Appendix A: Data parity (detail)
# P1 — Data-level parity: old (c242d0cc4) vs new (`fix/replace-getdata`)

**Claim to prove:** for every ticker, file and field, the new pipeline outputs either the same value as the old one, or a different value we can explain (market moved, TipRanks published something, or a change we chose on purpose). Nothing goes from a value to null, and no row disappears without an explanation.

**Why one diff can't prove this:** getData is blocked, so the old pipeline can't run again. Also, every rerun happens later, so market data has already moved. The proof therefore has three tiers. Each one removes a different confound.

| Tier | What it removes | How |
|---|---|---|
| **A. Same-input replay** | time drift | Run OLD and NEW code on the *same recorded* source bodies. Expect exact equality apart from an allowlist of deliberate changes. |
| **B. Mapping fidelity** | doubts about the new mapping | Each new value must equal the value in the captured source body it came from. This is exact and has no time component. |
| **C. Snapshot proxy + drift classifier** | the paths that used getData (which can't be replayed) | Compare new rows with the last getData-era snapshot `c242d0cc4` (T0 = 2026-11-17 04:33Z). Each difference is labelled *explained* or *unexplained*, using evidence from the capture and a drift envelope measured from history. |

## 1. Capture (one live run, the only network use)

- `ci/parity-record.mjs` is an `--import` preload that wraps `globalThis.fetch`.
  - For each response it writes `REC/<sha1(url)>.body` and adds a line to `REC/index.jsonl` with `{url, via: plain|flare, status, ts}`.
  - For FlareSolverr POSTs it keys on the inner `url` and stores `solution.response`.
  - It also pins `Date.now`/`new Date()` to `CLOCK` so both replays see the same "now" (keep-set expiry and `ls`/`ea`/`ba` stamps depend on it).
- **Workdir.** Run in a scratch copy: `git archive HEAD | tar -x -C $W/new`, then put `c242d0cc4`'s `src/data/*` and `public/{forecasts,bullbear,pe,reviews-recent.json}` into it. Nothing is written to the repo.
- **What runs.** `refresh-data-ci` → `scrape-forecasts` (`STALE_DAYS=0 LIMIT=600`, all tickers) → `scrape-pe` and `scrape-bullbear` (`LIMIT=600`) → `build-reviews-recent`.
- **Extra fetches, for the classifier only:** `stock-aianalyst` + `stock-forecast` payloads for all 557 tickers.
- **Cost.** About 1,300 requests (3 sorted calls + 1 universe pull, about 77 MB, + about 1,120 payloads + forecast and bullbear pages). Plain fetch answers all of these today: screener 200/1.1s, stock-forecast 200/0.2s, aianalyst 200/0.5s (probed 2026-11-19). Expect about 25–35 min. This needs the user's OK; it's local or a `dry_run`, never a commit.
- **Optional second capture 3h later.** It gives *new-vs-new* churn, to catch rows that flap in and out between runs. A flapping old-dated row rings the bell again.

## 2. Tier A — same-input replays (`ci/parity-replay.mjs`, offline)

The old code comes from `git archive c242d0cc4 ci | tar -x -C $W/old`. A replay preload, `ci/parity-serve.mjs`, serves `REC`:
- an unrecorded URL gets the recorded Cloudflare "blocked" body;
- getData is never recorded, because it can't be.

| Replay | OLD | NEW | Expect |
|---|---|---|---|
| A1 in-pull rows (271 at T0) | inline mapper, `c242:refresh-data-ci.mjs:61-79` (verbatim copy; the harness checks that the copy still matches `git show`) | `mergeRow(prev, rowFromScreener(it,{inPull:true}))` | equal on all 17 keys, except: `sec:"General"` (new = carry prev); a missing `tipRanksSmartScoreData` (old `null`, new carry); `mc` from `marketCapUSD`. **Already prototyped** on today's live sortBy=5 page: 119 items, the only diffs were 9 `"General"` |
| A2 whole refresh script | `$W/old/ci/refresh-data-ci.mjs` with `BACKFILL_LIMIT=0`, so getData isn't attempted and off-pull rows carry | `$W/new/...` | in-pull rows, enrich (`forecastFields`+`applyForecast`), `seen.json` and `meta.json` **byte-equal for in-pull tickers**. Off-pull rows go to tier C. `meta.universe` must be the same filtered `totalCount` (about 5.3k), **not** the 13.9k no-filter count |
| A3 forecast payload mapper | old `forecastsFromPayload(fj,t,null)` | new | per (n,d) row: `f,r,pt,opt` exact. New adds only `st` and uid-recovered rows. **Prototyped on AAPL:** 0 field diffs, +1 row (Jack Zhou, the uid fix), 1 `st` null |
| A4 page path | old `mergeForecasts` / `topUpRows` / `latestPerAnalyst` / `keepNewerPrev` | new | same rows on recorded pages. `withStars` differs by design (getData join vs carry) |
| A5 derived | `build-reviews-recent`, `parseBullBearHtml`, the `scrape-pe` close logic (code unchanged) | same | byte-equal output on the same inputs. This proves those files can only change through their inputs |

## 3. Tier B — mapping fidelity (every new value against its captured source)

For each of the 557 rows, take the source that won (in-pull screener item, universe item, aianalyst payload, or carry) and check each field against it:
- `px == rndPx(lastClose | priceUSD)`;
- `con/b/h/s` == the D1-basis object (`best` in-pull; `analystsConsensusData` / `analystRatings.all` otherwise);
- `pt/up` == `best ?? all`;
- `ss`, the `ai` trio, `mc`, `n`, `desc`.

A carried field must equal the T0 value. Pass = 100%. This is also the **basis-flip detector**: for each off-pull row whose counts differ from T0, check whether T0 matched `all` or `best` in the capture. If T0 matched `all` and new now matches `best`, that's a D1 regression.

## 4. Tier C — field classification against `c242d0cc4`

**Labels.**

| Label | Meaning |
|---|---|
| `EQ` | equal |
| `EXPL` | the difference is explained by evidence in the capture |
| `ENV` | inside the historical drift envelope |
| `INTENDED` | a listed design change |
| `IMPROVED` | null → value, or a stale value made fresh |
| `REG` | regression; any `REG` fails the run |
| `UNEXPL` | none of the above; reviewed by hand, and the run fails if over the limit |

**The envelope.** `ci/parity-envelope.mjs` walks the 60 getData-era data commits (same `git cat-file` approach as `replay-data-loss.mjs`). It takes every pair whose gap matches Δ = capture − T0 (±6h) and records the per-field |Δ| distribution for off-pull rows only. Off-pull rows are the ones with a `ba` stamp from that run. The tolerance is the p99 of old-vs-old drift. "No degradation" means the new-vs-old distribution at the same gap doesn't exceed it: per-field p50/p90/p99 within 1.25×, and the null→value / value→null counts within the historical max.

**`src/data/stocks.json`** (557 rows; at T0, 271 came from the in-pull path and 286 from getData)

| Field | Class | Rule |
|---|---|---|
| `t` (set) | exact | the same set, except the planned KPTI drop. ACH must come from the aianalyst payload or carry |
| `n`, `desc` | exact, never null | a diff is allowed only if it equals the captured source (TipRanks renamed it). Otherwise `REG` |
| `sec` | exact, never null | `"General"`→real sector = `IMPROVED`; anything else is `REG` |
| `px`, `mc` | drift, never null | `ENV`, and the ratio must hold: \|(mc′/mc)/(px′/px) − 1\| ≤ 2% |
| `chg` | drift | off-pull rows: the old value was carried stale from getData. Fresh = `INTENDED`; check only Tier B |
| `con`, `b`, `h`, `s` | drift | `EXPL` if \|Δ(b+h+s)\| ≤ the number of ratings in the captured `stock-forecast` payload that entered (d > T0) or left (d in [T0−90d, cap−90d]) the 3-month window, and the `con` change follows from the counts. A basis flip is `REG`. More than `LIMITS.con` value→null is `REG` |
| `pt`, `up` | drift | `EXPL` if a rating dated after T0 exists, else `ENV`. Check that `up` = (pt−px)/px within 0.5pt (old computed `up` from the getData price). Value→null over `LIMITS` is `REG` |
| `ss` | drift | `ENV` (it updates daily). Value→null is allowed only if the capture says `null` explicitly |
| `ai`, `air`, `aipt` | drift | must equal the captured report (Tier B). Value→null is `REG` unless the report is absent in both sources |

**`public/forecasts/<T>.json`** (564 files; key = `analystKey|d`)

| Case | Rule |
|---|---|
| a rating in both | `n,f,r,pt,opt,d` **exact** (keepPrevRating, D3); `st` within 0.3 of T0; `st` value→null is `REG` |
| a rating only in old | `INTENDED` if the same analyst has a newer `d`, or `d` is more than 365 days old; otherwise `REG` (LOST) |
| a rating only in new | `d > T0` = new rating; `d ≤ T0` = recovered (`IMPROVED`, e.g. Jack Zhou). The latter are **listed**, because they may ring the bell (reviewAlerts keys on `n\|f\|d\|r\|pt`) |
| per file | the file still exists, and `rows_new ≥ rows_old − superseded − aged`; the `st` null count does not go up |
| `_asOf.json` | keys ⊇ old; every value ≥ old |
| `_pageTried.json` | parses; keys ⊆ tickers. The key format changed by design, so this is a schema check only |

**Other files.**

| File | Rule |
|---|---|
| `seen.json` | keys ⊇ old minus dropped; `d`, `l` and the first-seen `ss/ai/con` byte-equal; `ls/ea/ba` monotonic |
| `meta.json` | `universe` and `shown` as in A2 |
| `bullbear/*` | no file deleted; `asOf` monotonic; a rewritten file keeps non-empty bull/bear sections |
| `pe/*` | the closes history is a prefix-equal copy of T0; only the current week's bar may move (it equals the new `px`) |
| `reviews-recent.json` | every T0 item still inside the 7-day window and not superseded is present with identical `n,f,r,pt,opt,d`; new items with `d ≤ T0` are listed |
| `desc.json`, `pinned.json`, `sectors.json`, `keepalive.json`, `tracked.json` | no producer changed, so byte-equal |
| RTDB `trackedRows` (track fetch) | replay `rowFromAiAnalyst` on the captured payloads for all 557 tickers plus NNNN, compare with T0 rows using the stocks rules above, and require `n`/`px` non-null (the plan's failure rule) |

## 5. Harness, outputs, pass/fail

**Files.** All are dev tools. None matches `ci/test-*.mjs`, because they need captures.

| File | Role |
|---|---|
| `ci/parity-record.mjs` | the capture preload |
| `ci/parity-serve.mjs` | the replay preload |
| `ci/parity-envelope.mjs` | history → `envelope.json` |
| `ci/parity-replay.mjs` | Tier A |
| `ci/parity-diff.mjs` | Tiers B and C → report |

The deterministic piece is A1 on `ci/fixtures/screener-items.json`, plus A3 on `stock-forecast-aapl.json`. It can ship as `ci/test-parity-mappers.mjs`, with the old mapper's source pinned by `git show` text equality.

**Inputs:** `REC/`, `CLOCK`, the T0 sha, `$W/{old,new}`.

**Outputs:**
- `parity-report.json`: per file × field, counts of `EQ`/`EXPL`/`ENV`/`INTENDED`/`IMPROVED`/`UNEXPL`/`REG`, each with ≤5 examples `{t, old, new, evidence}`;
- `parity-report.md`: a one-screen summary, a coverage line and the `REG` list.

**PASS when all of these hold:**
1. Tier A: 0 diffs outside the allowlist.
2. Tier B: 100% fidelity.
3. 0 `REG` across all files.
4. `UNEXPL` ≤ 1% per field, each one reviewed by hand.
5. Coverage is complete: 557/557 tickers accounted for (555 universe + ACH + KPTI by decision), all 564 forecast files, all 17 row keys, every forecast field.
6. Per-field drift is within the historical envelope.

**Runtime:** about 30 min for the capture; under 2 min for the offline replays, the envelope (about 60 snapshots, around 40s, like `replay-data-loss`) and the diff.

**Honest limits:**
- getData-only facts can't be re-observed. These are the per-rating firm and converted targets for anonymized experts, and ratings that only `carryForward` could see. They are covered only by "every T0 rating survives byte-equal" (D3), not by a fresh comparison.
- Older ratings not yet in any file are a loss the user accepted (D3).

---
# Appendix B: UI parity with Playwright (detail)
# P2 — UI-level parity with Playwright (design only)

Goal: show that every number and label the app renders is equal between the old and new
pipelines, or that each difference is a data drift the data-parity layer (P1) already
classified. Also show that no field became empty and the UI did not get worse.
Prior art in repo: `node_modules/playwright` 1.63.0 is present (extraneous, not in package.json)
and a browser cache exists in `~/Library/Caches/ms-playwright/`. Nothing is installed by this plan
unless noted.

## 1. Three builds side by side (git worktrees, repo untouched)

| Run | Code | Data (`src/data/*.json`, `public/{forecasts,bullbear,pe}`, `public/reviews-recent.json`, `public/desc.json`, `public/earnings.json`) | Port |
|---|---|---|---|
| **B** baseline | `c242d0cc4` (= main = merge-base) | as committed at `c242d0cc4` (old getData pipeline) | 4101 |
| **K** control | `fix/replace-getdata` HEAD | **B's data** copied over | 4102 |
| **C** candidate | `fix/replace-getdata` HEAD | output of the new pipeline (`scripts/refresh-data.mjs`/ci run into the worktree) | 4103 |

- B vs K = **code-only** diff. The only expected deltas are the new "failed" track state and
  the "No analyst coverage yet" line, shown exactly for tickers where
  `noAnalystCoverage(row)` is true. Compute that set from B's `stocks.json` in the harness.
- K vs C = **data-only** diff. Every delta must match a P1 drift record.
- B vs C = the final verdict (the union of the two).
- Data timing: B's data and C's data should come from the same time window (run the old and
  new pipelines back to back) so that P1 drift stays small. If B uses old committed data,
  more market drift is expected, and P1 must classify it.
- Setup: `git worktree add $S/wt-{base,ctl,cand} <ref>`. Symlink the main repo's `node_modules`
  into each worktree, so nothing gets installed. For K, run
  `git -C wt-ctl checkout c242d0cc4 -- src/data public/forecasts public/bullbear public/pe public/*.json`.
- **Build, not dev server.** Run `npm run build` (tsc + vite build) on local Node 26. This is
  safe: the fsevents crash only affects the dev watcher. Serve each `dist/` with
  `python3 -m http.server <port> --bind 127.0.0.1` and open it as `http://localhost:<port>`.
  The hostname keeps `DEV_AUTH` on, and there is no Vite at runtime, so the Node 20–22 limit
  does not apply. Use the identical env for all 3 builds:
  `VITE_WORKER_URL=http://worker.stub VITE_FINNHUB_KEY=stub VITE_TWELVEDATA_KEY=stub VITE_FMP_KEY=stub`.
  Dummy keys keep the keyed code paths alive, and the stubs answer them.

## 2. Deterministic environment (same for B/K/C)

- **Clock:** `page.clock.setFixedTime('2026-11-14T15:00:00Z')` (a Saturday, so the off-hours
  path: prior close = last − change, OHLC from the daily bar). Add one sections-only pass at a
  weekday 15:00 ET to cover the open-session rendering.
- **Network:** `context.route('**/*')`. localhost passes through. Everything else is answered
  from fixtures or aborted, and every request is logged:
  - `worker.stub/quotes` → one fixed quote per symbol, generated once from B's `stocks.json`
    price (+ a fixed change).
  - `worker.stub/bars*` → deterministic synthetic bars, seeded by the ticker.
  - `/live` WS → `page.routeWebSocket` that accepts and stays silent.
  - `finnhub.io`, `api.twelvedata.com`, `financialmodelingprep.com`, `symlookup.cnbc.com` →
    fixed JSON fixtures.
  - `*firebasedatabase.app` and `googleapis` → abort. **Assert zero hits**, because DEV_AUTH
    must not touch Firebase.
- **Two price modes:**
  - (a) `localStorage.mp_live="0"`: the snapshot price from the data shows. This is the
    primary data-parity pass.
  - (b) live stubbed: covers the LivePx/quoteStore UI path. Its numbers come from fixtures, so
    B, K and C must match exactly.
- **Per-user state** comes from `addInitScript` localStorage seeds:
  - `mp_dev_signedin=1`
  - a fixed watchlist and marks (≈15 tickers, mixed up and down)
  - `mp_dev_trackreq` and `mp_dev_trackerr` for the track states
  - `sessionStorage.mp_nav` to land on each section
- **Rendering:** fixed viewports 1280×900 and 390×844, `reducedMotion: 'reduce'`, fonts awaited
  (`document.fonts.ready`), and a wait for network idle plus no pending lazy fetch before each
  extract.

## 3. Coverage inventory (nothing sampled for numbers)

- **StockTable:**
  - 3 tabs (Analyst / Smart Score / AI).
  - × consensus filter {default StrongBuy, all}.
  - × every sortable column asc and desc.
  - × each market-cap bucket.
  - × each sector, with the full row set for that filter.
  - Extract every row × every column: ticker, name, price, target, upside, consensus, b/h/s,
    Smart Score chip (incl. `—` for `ss:null`), AI score/rating, market cap, sector. Also
    extract the row order, because ordering is data.
- **BestOfBest, NewArrivals, Watchlist** (seeded), **PostFeed/notifications and reviews feed**,
  **NotificationBell** panel, **FearGreed** panel (`#!feargreed`), and **Search** results for
  ~10 queries.
- **StockModal for EVERY ticker** in B∪C `stocks.json` ∪ `tracked.json` (~557), opened through
  the deep link `#<T>`, then `#<T>/fc` and `#<T>/pe`:
  - header: price, change, OHLC, volume, market cap, sector, description
  - consensus + b/h/s, target (low/avg/high), upside, Smart Score, AI score + rating
  - every analyst forecast row: name, firm, stars, rating, target, date, and the row count
  - bull and bear text
  - P/E chart values and labels
  - watch and thumb buttons
  - the limited-coverage / no-coverage banners
  - Full sweep instead of sampling: ~1.5–2.5 s per ticker × 3 views on 4 workers ≈ 6–8 min
    per build, ≈ 25 min for B+K+C. That is cheap enough that sampling is not worth it.
- **Track-request states:** use 3 off-universe tickers (not in `stocks.json`).
  - none: no seed
  - pending: `mp_dev_trackreq=[T]`
  - failed: `mp_dev_trackerr=[T]`
  - "tracked" is not reachable under DEV_AUTH (the dev sync only produces none, pending or
    failed). Rely on `src/trackState.check.ts` for it, or propose a test-only seed as a
    follow-up. Report this as a known gap.
  - No-coverage line: assert it appears for exactly the predicate set, and nowhere else.

## 4. Extraction and comparison

- **Primary method is structured DOM text, not pixels.** A per-view extractor is mapped by
  selectors (the app has no `data-testid`s, so the map is keyed on the existing `mkm-*`,
  `.tab` and table classes). It emits `{view, key, fields:{name: text}}` to
  `out/<run>/<view>.json`.
- **Backstop for selector gaps:** each view also records its normalized `innerText` (lines,
  whitespace collapsed) and a structural signature: a tag+class tree hash, plus the count of
  rows, chips, stars and forecast rows. A field the selector map missed still shows up as a
  text-line diff, so coverage does not depend on the map being complete.
- **Normalization:** whitespace and Unicode minus/NBSP only. Numbers stay as rendered strings,
  so formatting is part of the check. No rounding tolerance.
- **Diff engine** (`compare.mjs`) runs each pair and classifies every differing field:
  - `equal`
  - `code-expected`: B→K whitelist (failed state, no-coverage line on predicate tickers)
  - `data-classified`: matched against the P1 drift file keyed `ticker.field` with a reason
  - `FAIL`: anything else
- **Information-loss rules (FAIL even if P1 classified the change as drift):**
  - a value becomes `—` or empty where B had a value, unless P1 marks an explicit `null`
  - fewer forecast rows, fewer table rows, or a missing bull/bear section
  - a ticker present in B but absent from C with no P1 "dropped" record
- **UI-degradation rules:**
  - zero new `pageerror` or `console.error` vs B
  - zero unstubbed or failed requests
  - no horizontal overflow (`scrollWidth > clientWidth`) at 390 px
  - every modal reaches loaded state within 5 s (no stuck spinners)
  - pixel diffs: run `toHaveScreenshot` **B vs K only** (identical data, so pixels should
    match), max diff ratio 0.001, on ~40 views: every section at both viewports, 20 modals
    (pick ones with long names, no coverage, null ss, many forecast rows, off-universe), and
    the 3 track-state banners. Pixel B vs C is noise when data differs, so do not gate on it.
- **Report:**
  - `report.html` + `report.json`: totals per class, every FAIL with B/K/C values side by
    side and screenshot links
  - coverage stats: tickers opened, fields extracted, views
  - exit 1 on any FAIL

## 5. Where it lives, config, CI

- **Files:** the harness lives in `$SCRATCH/e2e/ui-parity/`, outside the repo, so it is not
  picked up by the `npm test` discovery patterns (`ci/test-*.mjs`, `src/*.check.ts`).
  - `playwright.config.ts`:
    - three `projects` (B/K/C), each with its own `baseURL`
    - a `webServer` array of the 3 `python3 -m http.server` commands
    - `workers: 4`, `retries: 0`, `trace: 'retain-on-failure'`
  - `fixtures/` (quotes, bars, finnhub, fmp)
  - `extract.ts` (selector map), `sections.spec.ts`, `modals.spec.ts`
  - `compare.mjs`, `setup-worktrees.sh`
- **Install, proposed and needs approval:** `npm i -D @playwright/test@1.63.0` in the harness
  dir, not in the repo. Plus `npx playwright install chromium` if the cached build does not
  match.
- **Node:** use Node 26 for build and runner. No Vite dev server is used, so the 20–22 limit
  does not bite. Fallback: `nvm use 21.7.3` exists, but it is below the repo's
  `engines >=22.18`, so use it only for `vite preview` if ever needed.
- **Runtime:** ~3 min for 3 builds, ~25 min for the modal sweeps, ~5 min for sections and
  screenshots. About 35 min total.
- **Optional CI later:** commit the harness as `e2e/ui-parity/` with a `workflow_dispatch`-only
  `ui-parity.yml` (Node 24, `actions/upload-artifact` for the report). It must never run on
  push, because pushing to main deploys. It must not be made `npm test`-discoverable unless
  fully stubbed and deterministic, which by the design above it is. Even then, keep it out of
  the DATA GATE because of its runtime.

---
# Appendix C: Pipeline / CI / operations (detail)
# P3 — Pipeline / CI / operational E2E (fix/replace-getdata)

Facts this plan rests on (checked 2026-11-19, read-only):
- `origin/main` == `c242d0cc4` (last data commit 2026-11-17 04:33). The 4 scheduled runs since were all **cancelled at 6h** (getData blocked); run `44445363564` is in progress on main's old site.yml (no 220-min cap) and holds the `pages` concurrency group — a branch `dry_run` will queue behind it until it is cancelled (Task 9 approval item).
- Branch data == main data, so the data-loss gate on a branch dry_run compares against the true production snapshot.
- **Baseline (last 4 good scheduled runs 44013523376, 43941215887, 43817333973, 43771389559):**
  total 27–49 min (38.5/39.5/49/27); snapshot step 438–722 s (median ~475); backfill step 837–2184 s (median ~1385);
  earnings ~210 s; post 16–28 s; data gate 7–10 s; deploy ~20 s.
  Counts: keep set 556–557, 285–286 off-pull refreshed / 0 carried / 0 expired; `enriched 100/100`; universe ~5295;
  forecasts 331–339 written, 0 failed, 26–37 carried; bullbear 22–23 failed (pre-existing); pe 0 failed, ~262 charts.
- Collect baselines with: `gh run view <id> --json jobs` (step start/end) and `gh run view <id> --log | grep -E "keep set:|backfill:|enriched |wrote .* rows|done: |exit: forecasts"`.

## 1. Staged rollout

### Stage A — local full dry run (copy of the repo, real FlareSolverr)
1. `git clone --local . $SCRATCH/e2e/repo && cd $_ && git checkout fix/replace-getdata && npm ci` (no edits to the real checkout).
2. `docker run -d --name fs -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest`.
3. `export RUNNER_TEMP=$SCRATCH/e2e/rt FLARESOLVERR_URL=http://localhost:8191/v1` (RUNNER_TEMP makes `health()` write `$RUNNER_TEMP/health`). **Leave FIREBASE_SERVICE_ACCOUNT unset** → fold/pin/mark/clear log "skipping" (no RTDB touch).
4. Replay site.yml in order with `/usr/bin/time -p` around each: snapshot copy (cp stocks/seen/forecasts to $RUNNER_TEMP/prev-*), `DROPPED=$RUNNER_TEMP/dropped.json node ci/refresh-data-ci.mjs`, the 3-way backfill block verbatim (same LIMIT/PARALLEL/STALE_DAYS), build-reviews-recent, sectors, feargreed, earnings (FINNHUB_KEY from .env.local), skip post/themes (CF neurons), then `PREV_DIR=$RUNNER_TEMP DROPPED=… npm test`, then `npm run build`.
5. Save `git -C repo diff --stat`, the produced files, and logs to `$SCRATCH/e2e/stageA/` for the data-parity (P1) and Playwright (P2) layers.

### Stage B — GitHub `dry_run` on the branch
`gh workflow run site.yml --ref fix/replace-getdata -f dry_run=true` (after the stuck main run is cancelled — needs approval).
**Known dry_run leaks to resolve first:** (a) `Pin requested tickers` runs on dry_run and **PATCHes RTDB** (`planUnrequest` deletes tracked/expired requests, ci/track-requests.mjs:353-354); (b) `Fold` only reads; (c) Build runs (harmless). Proposed fix: `if: github.event_name != 'push' && !inputs.dry_run` on Pin, or pass `DRY_RUN=1` and skip the PATCH. Same for Fold if it ever writes.

**Minimal workflow addition (artifact for P1/P2):** after THE DATA GATE, before Commit:
```yaml
      - name: Upload dry-run data
        if: ${{ always() && inputs.dry_run }}
        uses: actions/upload-artifact@v4
        with:
          name: dry-run-data
          retention-days: 7
          path: |
            src/data
            public/forecasts
            public/bullbear
            public/pe
            public/reviews-recent.json
            public/earnings.json
            ${{ runner.temp }}/health
            ${{ runner.temp }}/dropped.json
            ${{ runner.temp }}/prev-*
```
(+ a second `dist/` upload after Build for Playwright against the exact bundle.) Pull with `gh run download <id> -n dry-run-data`.

### Acceptance metrics (Stage A and B; B is binding)
| Metric | Source line | Pass |
|---|---|---|
| Snapshot step | step duration | ≤ 15 min (timeout) and ≤ 1.5× baseline median (~12 min) |
| Universe | `backfill: U universe, P payload, C carried (… universe X/Y items)` | Y ≥ 10k items; U ≥ 90% of missing; C ≤ 5% (health trips at 30%) ; P ≤ BACKFILL_LIMIT |
| Keep set | `keep set: N (…, E expired …)` | N within ±2 of 557; E equals `dropped.json` length and every dropped ticker is past keep age |
| Step deadline | `step deadline reached` | absent (present = degrade, not fail) |
| Enrich | `enriched a/b … noReport` | a/b ≥ 95/100; noReport ≤ 5 |
| Rows | `wrote N rows`, `seen.json: N tickers` | N == keep set |
| Forecasts | `done: W written … C carried … F failed`, `widened` lines | W ≥ 300, F/targets < 10% (health threshold), payloadFails ≤ 10 (no ::warning::), page fetches ≤ 30 |
| Bullbear | `done: ok/empty/failed/skipped` | failed ≤ baseline 23 (+10%), skipped 0 |
| P/E | `done: … 0 failed, ~262 charts` | failed 0, charts ≥ 260 |
| Backfill step | duration | ≤ 150 min cap; ≤ 1.25× baseline median (~29 min); `exit: forecasts=0 bullbear=0 pe=0` |
| Data-loss gate | `ci/test-no-data-loss.mjs` live line `PREV_DIR=…` | green; prev rows > 0 asserted; no forecast-shrink entries |
| Health gate | `$RUNNER_TEMP/health` | empty; all OUTCOMES success/skipped; job green |
| Total | job duration | ≤ 60 min (baseline max 49) |
| FlareSolverr usage | count `POST …/v1` (add a counter log line, or grep FlareSolverr container logs `docker logs fs | grep -c "Incoming request"` in Stage A) | ≤ baseline+20%; universe = 1 request |

## 2. Freshness / degradation metrics (compute from artifact vs prev-* via a scratch script)
- **% rows refreshed this run**: rows whose `ls`/price changed or stamped this run ÷ keep set. getData era: 557/557 (271 in pull + 286 off-pull). Pass ≥ 95%.
- **Oldest row age**: max(now − row asOf/`ls`) for in-keep rows; pass ≤ 1 run interval (3 h) except pinned/no-coverage rows (list them).
- **AI / consensus staleness**: distribution of `ea`/`ba` stamp ages; enrich cap 100 → full rotation ≤ ceil(eligible/100) runs; compare the before/after histogram.
- **Forecast rotation coverage**: `_asOf.json` ages — % ≤ 10 h (2 runs at LIMIT=300); max age; count >92-day drops (ledger Task 6 ROLLOUT CHECK: expected one-off on first rotation; must be `widened`, not gate-red).
- **CI duration** and **FlareSolverr requests per run** (table above), tracked per run in §5.

## 3. Failure-injection matrix (local, deterministic)
Mechanism: no repo edits. A preload `$SCRATCH/e2e/fetch-stub.mjs` loaded via `NODE_OPTIONS="--import <path>"` that wraps `globalThis.fetch`: requests to tipranks.com (plain path) and to `$FLARESOLVERR_URL` (FlareSolverr path, decode `cmd/url` from the POST body) are answered per `STUB_MODE` from `ci/fixtures/` (`screener-items.json`, `aianalyst-*.json`, `stock-forecast-aapl.json`, `ma-cloudflare-head.html` for blocks); everything else passes through. Run `refresh-data-ci.mjs` / `scrape-forecasts.mjs ONLY=AAPL,TWLO` / gate against the Stage A copy reset to c242d0cc4 data. Time-box each with `timeout`.

| # | Injection (STUB_MODE) | Expected |
|---|---|---|
| 1 | universe → CF block page (`ma-cloudflare-head.html`, 403) on both paths | no retry on firewall block; `health: universe pull failed`; payload backfill ≤ BACKFILL_LIMIT, rest carried; gate green; health gate red |
| 2 | universe → `{}` / `{"items":null}` | "no items" thrown → same as #1 (I3 fix) — never a silent empty map |
| 3 | universe → 200 MB valid JSON | completes ≤ 120 s timeout or falls into #1; RSS < 2 GB (`/usr/bin/time -l`) |
| 4 | aianalyst payload → block for all | breaker opens after N, `breaker open: stock-aianalyst` once; rows carried, 0 dropped; run red |
| 5 | FlareSolverr down (`FLARESOLVERR_URL=http://127.0.0.1:1/v1`) + plain blocked | all fetches fail fast; snapshot ≤ deadline; prev data intact; data gate green; health red |
| 6 | step deadline: `STEP_DEADLINE_MS=60000` + 5 s stub latency | `step deadline reached: k … skipped, rows carried`; stocks.json/seen.json still written; step < 15 min; no health line |
| 7 | payload → `{}` (parses, 0 rows) over a file with rows | treated as failure: prev forecast rows carried (Task 6 ruling); file never shrinks |
| 8 | strict-field nulls (`con`, `pt`, `ss`, `ai` null/absent mix) | explicit null kept as data (`ss:null`→`—`), absent → carry prev; gate's strict-field checks green; `ai` 0–100 |
| 9 | forecasts payload fails for 15% of targets | `>10% forecasts failed` health line; files carried; red |
| 10 | SIGTERM forecasts mid-run | `_asOf saved`; no partial JSON (all files parse) |
| 11 | gate negative control: delete 10 rows from stocks.json, truncate one forecast file | data-loss gate **red** (proves gate is live, not vacuous); `PREV_DIR` empty → red |
For every case: assert `git diff` shows no row/ticker/forecast-row loss vs prev except listed `dropped`, and wall time bounded.

## 4. track-requests.yml e2e
RTDB URL is hardcoded (ci/track-requests.mjs:49) — no emulator hook today.
- **Preferred (pre-merge):** propose a 1-line `const DB = process.env.RTDB_URL || "https://…"` and run locally against `firebase emulators:start --only database` (URL `http://127.0.0.1:9000` with `?ns=marketpulse-df5d9-default-rtdb`; the emulator treats `Authorization: Bearer owner` as admin, so `accessToken()` also needs a `RTDB_TOKEN` override or a dummy service account path — verify before relying on it). Then: seed `trackRequests/NNNN {tracked:false, at}` → `LITE=1 pin`, `fetch` (fixture `aianalyst-nnnn.json` via the stub or live), scrapers with `ONLY=NNNN`, data gate, `upload`, `mark`, `fail`. Assert `trackedRows/NNNN` has row+payload text, request `tracked:true`, `err` null.
- **Unknown ticker**: seed `ZZZZQ` → fetch fails → `fail` writes `err:{at}`; rerun → `err.at` unchanged (Task 7 fix); advance clock (`planUnrequest(…, now+25h)` unit or set `err.at` back 25 h in emulator) → site `pin` deletes it. UI: P2 Playwright loads the app with the emulator (or mocks the RTDB snapshot) and asserts "couldn't fetch yet" state, then gone after clear.
- **Fold/clear round trip**: with `trackedRows/NNNN` seeded, `fold` writes stocks/tracked/seen + public files; `clear` deletes only if `asOf` unchanged.
- **Post-merge production (needs approval):** request a real low-traffic untracked ticker from a test account in the app → Worker dispatch → run ≤ 10 min, green; app shows it within minutes; next site.yml run folds + clears it and commits. Then request a junk ticker (e.g. `ZZZZQ`) → run red, UI shows failed state, request gone ≥ 24 h later (check `trackRequests` via read-only REST GET with the service account). Only real-RTDB writes are the user's own two requests, which the pipeline itself cleans.

## 5. Post-merge monitoring (first 8 scheduled runs ≈ 24 h) and rollback
Per run, record (script over `gh run view --log`): job duration, snapshot/backfill durations, U/P/C, enriched a/b, forecasts W/C/F, bullbear failed, pe failed, health lines, gate result, commit landed (`git log origin/main -1`), site data age (`meta.json` asOf on marketpulse-app.web.app).
**Rollback triggers** (revert the merge commit; pushing it is the deploy — ask first):
- Data-loss gate red on 2 consecutive runs, or any committed snapshot with fewer rows than prev minus `dropped` (should be impossible — means the gate is bypassed).
- `universe pull failed` on ≥ 2 of the first 4 runs **and** carried > 30% (payload path can't carry the load).
- Job duration > 120 min or any 220-min timeout; backfill step hits 150 min.
- No data commit for 2 consecutive runs (freshness regression vs getData era).
- Forecasts failed > 10% on ≥ 2 runs, or `_asOf` share ≤ 10 h below 80% after run 4.
- track-requests: happy path red or `err` never cleared after 24 h.
Not rollback-worthy (fix forward): a single red health gate from feargreed/sectors flake; first-rotation `widened` forecast lines; bullbear failed ≈ baseline.
Rollback caveat: reverting returns to getData, which is blocked — "rollback" really means revert + disable schedule (`gh workflow disable site.yml`) so the 6h cancelled runs don't burn minutes, while keeping last good data live.
