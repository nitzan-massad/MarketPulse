# Part: Browser E2E + no-degradation plan (modal chart / Volume / P/E overlay → CNBC `/bars`)

Scope: the stock modal's price chart (all 10 ranges `1D 1W 1M 3M 6M YTD 1Y 2Y 5Y ALL`), the
"Volume" stat, and the P/E-history overlay's live fallback (`loadPeSeries` → `fetchSeries(t,"5Y")`)
move from Twelve Data (`StockModal.tsx` `fetchSeries`, `RANGE_CFG`) to the Worker's new `/bars`.

Harness dir (all new scripts live beside the existing ones):
`H=/private/tmp/claude-501/-Volumes-Source-Code/50cdbb01-e0b9-47c0-81a2-fea3569f0a85/scratchpad/e2e`

Reused as-is: Playwright-core from `/Volumes/Source-Code/legit-frontend-service/node_modules/playwright-core`,
system Chrome headless, `page.clock` for sessions, the mocked `/live` + `ws.finnhub.io` WebSocket
(never open the shared Finnhub key's real socket), the seeding `addInitScript`
(`mp_dev_signedin`, `mp_watchlist`), selectors `tr.row-open`, `.mkm-modal`, `.mkm-tbtk`, `.mkm-px`,
`.mkm-ranges button`, `.mkm-plotbox svg`, `.mkm-plot-msg`.

Servers: branch vite `http://127.0.0.1:5188` (VITE_WORKER_URL=http://localhost:8787), local
`wrangler dev` Worker `:8787`, main copy `:5190`. Node ≥ 22.

## Assumed `/bars` contract (adjust stubs if `parts/worker.md` differs)

`GET {WORKER}/bars?symbol=NVDA&range=1D` → `200 {"symbol":"NVDA","range":"1D","bars":[{"t":"2026-10-22 09:30","o":..,"h":..,"l":..,"c":..,"v":..}, …]}`
oldest-first, `t` in **America/New_York wall time**. Errors: non-200 or `bars: []`.
If the Worker instead returns epoch ms, every "ET label" assertion below still applies to what
the DOM shows; only `bars.mjs` stub output changes.

## Known main-side defects (the baseline is NOT the oracle for these)

Recorded so the comparison doesn't "require parity with a bug":

| # | Main behaviour | Branch requirement |
|---|---|---|
| K1 | Volume = **last bar's** `v` of the *selected range* (`series.volume`): 1D shows the last 5-min bar, 5Y the last week, ALL the last month. | Volume = today's (or last session's) full-day volume, **identical across all 10 ranges**. |
| K2 | Holidays not modelled; on an early-close day (2026-11-27, 13:00 close) at 14:00 ET 1D reads `LIVE` with shading. | Must not be worse: either the same, or `CLOSED`. |
| K3 | 1D axis `dStart = min(570, firstBarMin)`: TD 5-min has no pre-market bars, so axis starts 9:30. | If CNBC bars include extended hours, the branch must still start the 1D axis at 9:30 (`.mkm-axtx` first time label `9:30`) — no 04:00 axis. |

---

## 0. Pre-flight (once per run)

- [ ] `curl -s -o /dev/null -w '%{http_code}' 'http://localhost:8787/bars?symbol=NVDA&range=1D'` → `200` (today it is `405`: endpoint not built yet — stop here until it is).
- [ ] `curl -s 'http://localhost:8787/bars?symbol=NVDA&range=1D' | jq '.bars|length'` ≥ 2.
- [ ] `curl -sI http://127.0.0.1:5188/ http://127.0.0.1:5190/` both `200`.
- [ ] Branch source no longer references Twelve Data: `grep -rn "twelvedata\|TWELVEDATA" src/ ; echo $?` → exit `1` (no matches). `ci/scrape-pe.mjs` still uses TD — CI-only, out of browser scope; note it, don't fail on it.
- [ ] `cd $H && node regress.mjs http://127.0.0.1:5190/ main` → 31/31 (baseline still green).

---

## 1. Before/after comparison — `bars-compare.mjs`

`node bars-compare.mjs` → writes `$H/compare/<label>/<TICKER>-<RANGE>.png`, `$H/compare/report.json`, `$H/compare/report.md`.

### Ticker set (10)

| Role | Ticker | How opened |
|---|---|---|
| mega-cap | NVDA | table row price cell |
| mega-cap, comma price | LLY | row |
| mega-cap, long history | AAPL | row |
| micro-cap | ATCX | row (in universe) |
| micro-cap | GOSS | row (in universe) |
| ETF (off-universe) | SPY | deep link `#SPY` (fallback: header search → Enter) |
| dotted class share (off-universe) | BRK.B | deep link `#BRK.B`; also try `BRK-B` and record which resolves on each side |
| ADR | TSM | row |
| recent IPO | first ticker in the **New** section whose main 1Y bar count < 200 (pick at runtime, log it); fallback CRCL via `#CRCL` | as found |
| Finnhub-only gap (not in CNBC quotes) | QNCX | row |

### Data capture (both sides, same context settings)

- Viewport 1400×950, `timezoneId: "America/New_York"`, real network for chart data:
  - **main (:5190)**: real `api.twelvedata.com` — shared visitor quota. Throttle to **≤ 7 TD req/min**
    (queue + `sleep`), record every TD response body to `$H/compare/td-cache/<sym>-<range>.json`;
    on re-run, serve from the cache via `page.route` (no second spend). Budget: 10×10 + 2 P/E = ~102 calls of 800/day.
  - **branch (:5188)**: real local Worker → real CNBC. Record each `/bars` body to `compare/bars-cache/`.
- Finnhub REST stubbed exactly as in `regress.mjs` `stubNetwork` (fundamentals aren't under test);
  WebSockets mocked.
- Capture raw series through `page.on("response")` (TD URL / `/bars` URL) → the **raw oracle**.
- Per ticker: open modal, then for each range click `.mkm-ranges button` with exact text, wait for
  `.mkm-plotbox svg[aria-label="<T> <RANGE> price chart"]`, `sleep(300)`, then extract:
  - `pts` = number of points in `path.mkm-chartline` `d` (count of `L` + 1)
  - `axisX` = `.mkm-axtx` texts with a `x` < `CW-44` (date/time labels), `axisY` = right-gutter labels
  - `chg` = `.mkm-chg` text (range % change), `px` = `.mkm-px`
  - scrubber first/last: `mouse.move` to plotbox left edge +2px and right edge −46px (inside plot,
    left of the 44px price gutter) → read `.mkm-scrub-t` / `.mkm-scrub-p`
  - 1D only: `.mkm-baseln` present, `.mkm-basetag` text `prev close`, `.mkm-remaining` present/absent,
    `.mkm-sess` text (`LIVE · h:mm` / `CLOSED`)
  - Volume: `.mkm-kv .row` whose `.k` = `Volume` → `.v` text
  - screenshot of the `.mkm-modal` element.

### Assertions per ticker × range (branch)

| ID | Assertion | Tolerance / rule |
|---|---|---|
| C1 | chart renders (svg present, no `chart unavailable`) wherever **main** rendered it | hard: branch-rendered ⊇ main-rendered |
| C2 | branch last close (scrubber-right `.mkm-scrub-p`) vs `/quotes` `px` for that ticker | regular session: ≤ 0.5 %; closed/weekend: ≤ 0.05 % or ≤ $0.01 |
| C3 | DOM fidelity: scrubber-left/right values = raw `/bars` first/last close (after the client's 1D session slice) | exact to displayed cents |
| C4 | branch first close vs main first close (same date bucket) | 1D–1Y ≤ 0.5 %; 2Y ≤ 1 %; 5Y/ALL ≤ 3 % (dividend-adjustment drift); breach → `REVIEW` row + side-by-side PNG, not auto-fail |
| C5 | range % (`.mkm-chg`) branch vs main | 1D: both = `/quotes` `pct` ±0.01pp; 1W–1Y ±0.5pp; 2Y ±1pp; 5Y/ALL ±3pp; sign must match unless both `|pct|<0.5` |
| C6 | bar count `pts` branch ≥ main for each range (1D: compare session-sliced count) | hard, except recent-IPO / micro-cap where branch ≥ raw history available; ≥ 0.9×main allowed only with `REVIEW` note |
| C7 | first/last stamp coverage: branch first scrubber date ≤ main first date + 3 trading days; last date = last session | hard |
| C8 | X axis labels: same **format** family as main per range (1D `h:mm`; 1W/1M/3M/6M/YTD/1Y `M/D`; 2Y/5Y/ALL `Mon 'YY`), ≥ 3 labels, monotonic left→right | hard |
| C9 | 1D axis starts `9:30`, ends `4:00`/`16:00` label, never shows pre-market times (K3) | hard |
| C10 | 1D prev-close dashed line: `.mkm-basetag` = `prev close`, and its y maps to `/quotes.pc` (hover-free: compare `baseY` against axis label interpolation, ±1 px) | hard |
| C11 | 1D `.mkm-sess`/shading match the session (see §2) | hard |
| C12 | Volume text is identical across all 10 ranges (K1) and not `—` for NVDA/LLY/AAPL/SPY/TSM | hard; for ATCX/GOSS `—` allowed only if main also `—` on 1M |
| C13 | Volume magnitude sane: within 0.25×–4× of `/quotes.vol10` (10-day avg) during/after a session | `REVIEW` on breach |
| C14 | scrubber stamps in ET: with `timezoneId` set to `Asia/Jerusalem` and `America/Los_Angeles` (two extra runs of NVDA 1D/1W only), the 1D first label is still `9:30` and the scrubber time of the first bar is `09:30`/`9:30` | hard |
| C15 | no `pageerror`, no console errors other than our own aborts | hard |

### P/E overlay (live fallback path)

The ranked-set tickers read `public/pe/<T>.json` (no series call); only off-universe tickers hit
`loadPeSeries`. SPY can't be used (an ETF has no EPS, so the overlay isn't offered). Use an
off-universe **stock** with ≥4 quarterly EPS instead: open `#CRCL`, or any off-universe search hit that shows a P/E value.

- [ ] PE1 branch: clicking `.mkm-pe-open.on` opens `[aria-label="<T> P/E history"]`, the request
      log shows exactly one `/bars?…range=5Y` (or the 5Y-equivalent) and **zero** TD.
- [ ] PE2 branch svg `[aria-label^="<T> P/E over"]` renders wherever main rendered it; median in the
      aria-label within ±5 % of main's.
- [ ] PE3 covered ticker NVDA: overlay opens with **no** `/bars` 5Y request (static file wins) — unchanged vs main.
- [ ] PE4 `/bars` 5Y fails (route → 502) for the off-universe ticker → `No P/E history for <T>.` message, no spinner left.

### Screenshot review

- [ ] `report.md` renders a grid: rows = ticker, columns = range, cell = main PNG | branch PNG.
- [ ] Human eyeball pass on every `REVIEW` row; sign off in `report.md` before merge.

---

## 2. Sessions — `bars-sessions.mjs` (deterministic, stubbed `/bars`)

Stub `/bars` with `bars.mjs` (new, sibling of `td.mjs`): synthetic 5-min (1D) / 30-min (1W) /
daily bars generated relative to the **faked** clock, so labels are predictable. On main, the same
synthetic series goes through the `td.mjs`-shaped stub, so main and branch render identical inputs
and every diff is a code diff. `/quotes` stubbed with `pc = 100`, `px = last bar close`.

| ID | Faked ET clock (`page.clock.install`) | Bars served for 1D | Expect (both sides, unless noted) |
|---|---|---|---|
| SS1 pre-market | 2026-10-22 08:00 (Thu) | previous session 10-21 09:30–16:00 | `.mkm-sess` = `CLOSED`, no `.mkm-remaining`, axis 9:30…4:00, prev-close line present |
| SS2 regular | 2026-10-22 12:30 | 10-22 09:30–12:25 | `LIVE · 12:25`, `.mkm-remaining` width > 0 covering ~12:30→16:00 (x ≈ 46 % of plot ±3 %), future axis labels have class `future`, `.mkm-livering` present |
| SS3 open bell | 2026-10-22 09:31 | 10-22 09:30 only (1 bar) | must not crash; main falls back to non-session chart (slice needs ≥2) — branch same or better (renders 1-point LIVE) |
| SS4 post-market | 2026-10-22 17:30 | 10-22 full session (+ 16:05–19:55 bars if CNBC sends ext hours) | `CLOSED`, axis ends 4:00 (K3), no ext-hours points plotted, last scrubber time `16:00`/`15:55` |
| SS5 overnight | 2026-10-22 22:00 | same | `CLOSED` |
| SS6 weekend | 2026-10-24 11:00 (Sat) | 10-23 session | `CLOSED`, scrubber dates show `23 Oct` |
| SS7 holiday | 2026-11-26 11:00 (Thanksgiving) | 11-25 session | `CLOSED` (no bar dated today), no shading |
| SS8 early close | 2026-11-27 14:00 | 11-27 09:30–12:55 | branch ≥ main (K2): `LIVE` accepted (parity), `CLOSED` = improvement — log which |
| SS9 DST boundary | 2026-11-02 10:30 EST (after 11-01 fall-back) | 11-02 09:30–10:25 | axis/scrubber show 9:30 start (not 8:30/10:30) → proves epoch→ET conversion |
| SS10 live tick | SS2 then `clock.runFor(5*60_000)` and the stub adds one bar | — | no extra `/bars` call before the client's refresh interval (document it); if the branch refreshes 1D, `LIVE · 12:30` |

Also per session, open a **daily** range (1M) and assert last bar date = last completed or
in-progress session, and Volume identical between 1D and 1M (K1).

Pass: every SS row green on branch; any SS row green on main must be green on branch.

---

## 3. Failure modes — `bars-fail.mjs`

Each case on branch; card height measured with the `regress.mjs` R12 `H()` (max `scrollHeight`
over the modal subtree) at 3 points: before click, 120 ms after click (loading), after settle.

| ID | Injection (`page.route` on `{WORKER}/bars**`) | Expect |
|---|---|---|
| F1 | `403` | `.mkm-plot-msg` = `chart unavailable` within 8 s; height unchanged |
| F2 | `502` / `500` | same as F1 |
| F3 | hang 30 s (never fulfil) → client timeout | `chart unavailable` (or loading) — must resolve within the client's timeout (≤ 12 s); never a permanent `loading…`; height unchanged |
| F4 | `200 {"bars":[]}` | `chart unavailable`; Volume `—` (not `0`) |
| F5 | `200` malformed JSON / HTML body | `chart unavailable`, no `pageerror` |
| F6 | `200` bars with `c: null`/`NaN` for some rows | NaN rows dropped; chart renders from the rest; no `NaN` text anywhere in modal |
| F7 | 1 bar only | renders without throwing (main parity: single-point path) |
| F8 | Worker down entirely (`route.abort()`) | `chart unavailable`; rest of modal (price, fundamentals) unaffected |
| F9 | failure then success: F1 for 1M, then click 3M (succeeds), then back to 1M | 3M renders; 1M retried (failure not cached forever) — `seriesCache` must not store failures |
| F10 | rapid range clicks with per-request delays 900/100/500 ms (out-of-order responses) | final active range = last clicked, plotted series = last range (aria-label check) |
| F11 | `/bars` 429 | same as F1; and no retry storm: ≤ 2 `/bars` requests for that range in 10 s |
| F12 | TD blocked (`route("**/api.twelvedata.com/**", abort)`) on branch | **no effect at all** — all ranges render (proves no hidden TD dependency) |

Pass: all F rows on branch. F1/F2/F4 must match main's R14 behaviour (same text, same height).

---

## 4. Mobile — `bars-mobile.mjs`

Contexts: `{ viewport: {390,844}, isMobile:true, hasTouch:true, deviceScaleFactor:3 }` and the same at **360×780**; `/bars` stubbed with a 700 ms delay (like E06).

- [ ] M1 open modal via price cell; screenshot each range (both widths, both sides) → `compare/mobile/`.
- [ ] M2 no horizontal page scroll: `document.scrollingElement.scrollWidth <= innerWidth` after each range.
- [ ] M3 card height constant across all 10 ranges incl. during loading (R12 method).
- [ ] M4 range bar: `.mkm-ranges` scrolls horizontally; `ALL` reachable via `scrollIntoViewIfNeeded` and clickable; fade classes `fl`/`fr` toggle.
- [ ] M5 touch scrub: `touchscreen` down at 30 % of plot width, move to 70 %, read `.mkm-scrub-p` changes, release → readout clears (`.mkm-scrub` loses `on`); a horizontal drag on the plot does **not** page the modal (`.mkm-tbtk` unchanged).
- [ ] M6 1D labels don't overlap: bounding boxes of `.mkm-axtx` time labels pairwise non-intersecting at 360.
- [ ] M7 Volume row visible and not truncated (`scrollWidth <= clientWidth` on its `.v`).
- [ ] M8 P/E overlay at 360: opens, svg fits (`svg.getBoundingClientRect().width <= innerWidth`).

Pass: every check on branch; screenshots diffed by eye against main (no new clipping/overlap).

---

## 5. Performance — `bars-perf.mjs`

Metric **time-to-chart (TTC)** = `performance.now()` delta from the range-button click to
`.mkm-plotbox svg[aria-label="<T> <R> price chart"]` attached (poll via `page.waitForFunction`
inside the page to avoid CDP round-trip noise). Plus **TTC-open** = row click → 1D chart.

- Tickers: NVDA, ATCX, SPY. Ranges: all 10. Cold = new context (empty `seriesCache`), 5 reps;
  warm = same modal, re-click range (cache hit), 3 reps.
- main: real TD **from the recorded cache with recorded latency replay** (store the measured live
  TD latency per call during §1 and `sleep` it in the route) so we don't burn quota on reps.
  branch: real local Worker → real CNBC (no stub), Worker cache warmed/cold measured separately
  (first rep after `wrangler dev` restart = Worker-cold).
- Report p50 / p95 per range per side to `perf.json`.

Pass criteria:
- [ ] P1 cold p50 branch ≤ main p50 + 100 ms for every range (noise allowance), and the **sum of
      p50 over the 10 ranges** branch ≤ main.
- [ ] P2 cold p95 branch ≤ 1.25 × main p95 per range.
- [ ] P3 warm TTC ≤ 50 ms on both (cache hit; no `/bars` request on re-click).
- [ ] P4 TTC-open (1D on modal open) branch p50 ≤ main p50.
- [ ] P5 no range > 3 s p95 on branch.
- [ ] Any failure → re-run once; still failing = FAIL (not REVIEW).

---

## 6. Network accounting — `bars-net.mjs` (+ a guard injected into every suite)

Shared helper `netguard.mjs`:
`export function guard(page, log) { page.on("request", r => { const u = r.url(); if (/api\.twelvedata\.com/.test(u)) log.td.push(u); if (/\/bars\?/.test(u)) log.bars.push(u); }) }`
Imported by `run.mjs`, `regress.mjs`, and every new script; each suite's summary prints `td=<n> bars=<n>`.

`bars-net.mjs` walk (branch, real Worker, Finnhub stubbed): load app → every nav section (Stocks,
Best, New, Watchlist) → open NVDA modal → all 10 ranges → P/E overlay → page ›× 3 → close →
`#SPY` deep link → all ranges → header search "realty" → open a hit → 1D → mobile 390 repeat.

- [ ] N1 `td.length === 0` across the whole walk and across **every** other suite run on the branch (hard gate).
- [ ] N2 per (ticker, range) at most **one** `/bars` request per modal session (cache), 0 on revisit.
- [ ] N3 no `/bars` request for a modal that was never `active` (paging pre-render must not prefetch all neighbours' charts) — count `/bars` symbols ⊆ symbols actually shown active.
- [ ] N4 `/bars` requests go only to `VITE_WORKER_URL` origin; no direct `cnbc.com` bar/quote calls from the browser (symlookup for search is allowed, as today).
- [ ] N5 the built bundle has no TD key: `grep -c "twelvedata" dist/assets/*.js` → 0 after `npm run build` on the branch (and `VITE_TWELVEDATA_KEY` removed from `.env*` usage).
- [ ] N6 main walk recorded as baseline: `td` count printed (expected ≥ 11) for the report.

---

## 7. Regression-suite changes — `regress.mjs`

Required refactor first (otherwise R12/R13/R14/E06 silently stop testing anything on the branch):
- [ ] `stubNetwork(page, { chartFail, chartDelay, … })`: rename `tdFail/tdDelay` → `chartFail/chartDelay`
      and apply them to **both** `**/api.twelvedata.com/**` (td.mjs) and `http://localhost:8787/bars**`
      (new `bars.mjs`, same deterministic random walk so main/branch render identical shapes).
- [ ] Import `netguard.mjs`; at the end print `td`/`bars` totals; on label `branch` assert `td === 0`.

New tests (run on both main and branch; columns "main must" / "branch must"):

| ID | Test | main | branch |
|---|---|---|---|
| R23 | Volume stat identical across 1D/1M/5Y/ALL (K1) | may FAIL (known K1) | PASS |
| R24 | 1D shows `prev close` tag + dashed `.mkm-baseln` | PASS | PASS |
| R25 | 1D at faked 12:30 ET: `LIVE · …` + `.mkm-remaining`; at 21:30 ET: `CLOSED`, no `.mkm-remaining` | PASS | PASS |
| R26 | scrubber: hover left/right edges → `.mkm-scrub-p` matches stub first/last close; mouse out clears | PASS | PASS |
| R27 | chart source down (`chartFail`) for every range → all show `chart unavailable`, height constant | PASS | PASS |
| R28 | failed range is retried after switching away and back (F9) | record | PASS |
| R29 | P/E overlay: NVDA (static) opens and renders; off-universe stub ticker live path renders from 5Y series | PASS | PASS |
| R30 | off-universe deep link `#SPY` → chart renders 1D and 1Y | PASS | PASS |
| R31 | 360px: no horizontal scroll with modal open on 1D and ALL | PASS | PASS |
| R32 | zero `api.twelvedata.com` requests over the whole test | n/a (expected > 0) | PASS |

Existing R09, R12, R13, R14, R16, E04, E06 stay as-is (after the refactor they exercise `/bars` on the branch).

---

## Run order (one shot)

```bash
H=/private/tmp/claude-501/-Volumes-Source-Code/50cdbb01-e0b9-47c0-81a2-fea3569f0a85/scratchpad/e2e
cd $H
node regress.mjs http://127.0.0.1:5190/ main   > r-main.txt
node regress.mjs http://127.0.0.1:5188/ branch > r-branch.txt
node bars-sessions.mjs  > sessions.txt     # deterministic, both sides
node bars-fail.mjs      > fail.txt
node bars-mobile.mjs    > mobile.txt
node bars-net.mjs       > net.txt
node bars-compare.mjs   > compare.txt      # real data; throttled TD on main (~15 min first run)
node bars-perf.mjs      > perf.txt         # after compare (reuses recorded TD latency)
node run.mjs            > run.txt          # existing live-prices suite: must stay green
node repro-shrink.mjs http://127.0.0.1:5188/ 390   # loading-state height spot check
```

## Gate: "only improvements" (all must hold to merge)

1. `regress.mjs`: every test green on main is green on branch (diff `regress-main.json` vs `regress-branch.json`), plus R23–R32 branch-green.
2. `run.mjs`: same pass count as before the change (S1–S12).
3. Coverage ≥ main: set of (ticker, range) rendering a chart on branch ⊇ main's set (C1); P/E overlay renders wherever main's does (PE2).
4. Density ≥ main: bar count per (ticker, range) ≥ main (C6) except logged REVIEW rows.
5. Accuracy: C2/C3/C5 within tolerance for every row; C4 breaches all eyeballed and signed off.
6. Volume: branch range-invariant (C12/R23) — strictly better than main (K1).
7. Sessions: SS1–SS10 green; SS8 equal-or-better than main.
8. Failure: F1–F12 green; unavailable state height = chart height (no layout shift) on desktop, 390, 360.
9. Mobile: M1–M8 green at 390 and 360.
10. Performance: P1–P5.
11. Network: N1 (zero Twelve Data from the browser, every suite) and N2–N5.
12. No new console errors / `pageerror` in any suite.

Anything not meeting 1–12 blocks merge; REVIEW rows need a written note in `compare/report.md`.
