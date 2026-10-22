# Part: automated unit and contract tests for Twelve Data → CNBC bars

Scope: **node only, no browser, no network inside `npm test`.** Every file below is picked up by
`ci/run-tests.mjs` by pattern (`ci/test-*.mjs`, `src/*.check.ts`). Each one prints an `ok …` line
per case and contains real `assert`/`eq` calls, so the runner's vacuity rule passes. Each one exits
non-zero on any failure.

Module names (`worker/bars.js`, `src/bars.ts`, the `/bars` query shape, TTL constants) are
**provisional**. Rename them here to match the implementation part. The cases are what this
part owns.

Fixture source (captured 2026-10-22 12:59 ET, Thu, regular session, UA = the `BROWSER_UA` in
`worker/cnbc.js`):
`/private/tmp/claude-501/-Volumes-Source-Code/50cdbb01-e0b9-47c0-81a2-fea3569f0a85/scratchpad/cnbc-bars-fixtures/`

---

## 0. Facts the fixtures proved (the tests are built on these)

| # | Fact | Fixture | Consequence for tests |
|---|------|---------|-----------------------|
| F1 | `open/high/low/close` are **strings** with 4dp (`"344.0700"`). `volume` is a **number**. | all | The parser must accept both types for every field; the tests feed both. |
| F2 | Errors come back as **HTTP 200**, `{status:"ERROR", statusMessage, requestDetails}`, with no `barData`. Unknown symbol: `"…Security Master not found"`. Bad interval: `"barType: null null"`. Bad date: `"could not be parsed"`. | `err-*.json` | `r.ok` is not success. An unknown symbol must be told apart from an upstream failure. |
| F3 | `BRK/B` → **HTTP 400 HTML** (Tomcat page). `BRK.B` → 200 (intraday RIC `BRKb`, daily `symbol` is a numeric id `65816`). Lowercase `aapl` works. | `brkb-*.json`, `aapl-lower-1d.json` | Normalize with `normSym` before the URL. Never trust `barData.symbol` (it is `36276` on daily and `AAPL.O` on intraday). |
| F4 | Intraday covers **04:00–19:55 (5M)** and **04:00–19:30 (30M)**, so pre and post are included. AAPL today: 66 pre + 42 regular bars by 12:55. Yesterday: 66 pre / 78 regular / 48 post. | `aapl-5m-today`, `aapl-5m-yesterday`, `aapl-30m-7d` | Session filter cases. |
| F5 | The **16:00 bar carries the closing cross**: volume 117,709,697 on 2026-10-21, while the full-day 1D bar is 35,614,126 and Σ(09:30–15:55) is 18,371,746. Post bars 16:05 and 18:05 have about 22M each. | `aapl-5m-yesterday` | The Volume stat must **never** be Σ(all intraday bars). Pin the chosen definition. |
| F6 | **Daily stops at yesterday.** The last 1D bar is `20261021` at 12:59 ET on 10-22. 1W's last bar is the current week (stamp `20261018`, close = yesterday's 343.99). 1MO's last bar is the current month (`20261001`, close 343.99). | `aapl-1d-1y`, `aapl-1w-5y`, `aapl-1mo-all` | Today's-bar merge cases. |
| F7 | `tradeTime` is **ET wall clock** (`20261022040000`). `tradeTimeinMills` is the true UTC instant: the offset is 4h in EDT and 5h in EST, and both appear in one response across DST. Daily/weekly/monthly bars are stamped at local midnight. | `aapl-5m-dst-mar2026` (03-06 EST → 03-09 EDT), `aapl-1d-dst-nov2025` | Derive minute-of-day from `tradeTime`, never from `mills` with a fixed offset. |
| F8 | **1W bars are stamped Sunday** (`20261018`). TD stamped Monday. With CNBC Sunday + 1 day, all **262/262 weeks** match `ci/cache/pe/AAPL.json` dates, and closes match within 5bp except **one week, 2023-04-03 (TD 164.66, CNBC 163.76, Good-Friday week)**. | `aapl-1w-5y` vs `ci/cache/pe/AAPL.json` | Golden parity case and the main mutation target. |
| F9 | P/E golden, simulated now: the Monday-shifted CNBC closes reproduce `public/pe/AAPL.json` in **260/261 points** (max rel diff 0.57%, the 2023-04-03 week). Raw Sunday stamps make **261/261 points** differ. Offline recompute from the committed cache reproduces **231/231** committed `public/pe/*.json` byte-for-byte. | scratch `parity.mjs`, `parity-all.mjs` | §6 golden tests are viable today. |
| F10 | Weekend/future windows → `priceBars: []` with `exchange` set. An inverted window (start>end) → `priceBars: []` with **`exchange: null`**. A holiday is simply absent (2025-07-04 is missing in `aapl-1d-holiday`). | `aapl-5m-weekend`, `aapl-1d-inverted`, `aapl-1d-holiday` | Empty is data ("no bars"), not an error. |
| F11 | **Intraday history depth is patchy.** 30M has 2026-03-06 but not 2025-11, 2025-12 or 2026-01/02. 5M has 2026-01-05 but not 2026-02-02. | probes | No test may assume intraday older than about 7 days. 1D and 1W ranges must not need it. |
| F12 | Thin ticker ATCX: 5M today has only 12 bars, the first at **10:00**, 9 of them flat (o=h=l=c), with missing 5-minute slots. 1D 1Y has 251 bars and no zero-volume bars. | `atcx-*` | Gaps stay gaps, and flat bars are valid. |
| F13 | Upstream headers: `Cache-Control: max-age=5`, `Access-Control-Allow-Origin: *`. Latency is about 0.3–0.8s. | headers | The Worker cache is ours. Upstream gives no useful caching. |
| F14 | `adjusted` is split-adjusted (NVDA 2024-06-05 = 122.44, pre-10:1). `unadjusted` and `UTC.json` variants exist (UTC shifts stamps to 04:00). | `nvda-1d-split`, `aapl-1d-unadj`, `aapl-1d-utc` | The URL must pin `adjusted/EST5EDT`, and a test asserts both segments. |

---

## 1. Fixture setup

- [ ] Copy the trimmed fixtures into `ci/fixtures/cnbc-bars/`. Keep the full ones for `aapl-1w-5y`, `aapl-5m-today`, `aapl-5m-yesterday` and `aapl-5m-dst-mar2026`. Trim `aapl-1mo-all` to its first 3 bars plus the last 24, and `aapl-1d-1y` and `atcx-1d-1y` to the last 30 bars. The other files are small and go in as-is.
  ```bash
  S=/private/tmp/claude-501/-Volumes-Source-Code/50cdbb01-e0b9-47c0-81a2-fea3569f0a85/scratchpad/cnbc-bars-fixtures
  D=ci/fixtures/cnbc-bars; mkdir -p $D
  cp $S/{aapl-1w-5y,aapl-5m-today,aapl-5m-yesterday,aapl-5m-dst-mar2026,aapl-30m-7d,aapl-30m-dst-mar2026,aapl-1d-holiday,aapl-1d-dst-nov2025,aapl-1d-inverted,aapl-5m-weekend,atcx-5m-today,brkb-dot-1d,brkb-dot-5m,brkb-slash-1d,err-unknown-sym,err-bad-interval,err-bad-date,nvda-1d-split}.json $D/
  node -e 'const fs=require("fs");const t=(f,fn)=>{const j=JSON.parse(fs.readFileSync(process.argv[1]+"/"+f));j.barData.priceBars=fn(j.barData.priceBars);fs.writeFileSync(process.argv[2]+"/"+f,JSON.stringify(j))};
    t("aapl-1mo-all.json",b=>[...b.slice(0,3),...b.slice(-24)]);t("aapl-1d-1y.json",b=>b.slice(-30));t("atcx-1d-1y.json",b=>b.slice(-30));' $S $D
  du -sh $D   # expect < 300K
  ```
- [ ] Keep the bodies **byte-identical to CNBC** apart from trimming `priceBars`. Do not reformat numbers: strings stay strings (F1).
- [ ] Add `ci/fixtures/cnbc-bars/CAPTURED.txt` with one line per file: capture time (ET), URL and HTTP status. This is the provenance for F1–F14.
- [ ] Add `ci/cnbc-bars-contract.mjs` (deliberately **not** `test-*`, so `npm test` stays offline). It is a manual live probe. It re-fetches each URL in `CAPTURED.txt` and asserts the shape facts F1–F4, F6, F7 and F10 still hold. Run it by hand before deploy and whenever CNBC is suspected of reshaping: `node ci/cnbc-bars-contract.mjs`.

---

## 2. `ci/test-cnbc-bars-parse.mjs`: pure parser (`worker/bars.js`)

Import `parseBars`, `classifyBody`, `barsUrl`, `normSym` and the `INTERVALS` table. Each case prints `ok <name>`.

**Envelope and classification**
- [ ] `aapl-5m-today` → 108 bars, oldest-first, first `t=20261022040000`, last close `345.755`.
- [ ] Each output bar has the shape `[t(ms UTC), o, h, l, c, v]` (or the agreed shape), and every field is `typeof number`.
- [ ] String prices `"344.0700"` → `344.07`, with no float drift beyond 1e-9.
- [ ] `volume` arriving as the string `"54014"` → 54014. As a number → unchanged (F1, for the day CNBC flips it).
- [ ] `err-unknown-sym` → `{kind:"unknown"}`. This is **not** an exception.
- [ ] `err-bad-interval` and `err-bad-date` → `{kind:"bad-request"}` (our own bug; must be distinct from unknown).
- [ ] `brkb-slash-1d` (HTML, status 400) → classified as upstream failure, and it never throws an uncaught `SyntaxError`.
- [ ] `{}`, `null`, `{barData:null}`, `{barData:{}}` and a non-array `priceBars` → upstream failure ("reshaped envelope"). They must not return an empty success.
- [ ] `aapl-5m-weekend` (`priceBars: []`, exchange set) → `{kind:"ok", bars: []}`.
- [ ] `aapl-1d-inverted` (`exchange: null`) → `{kind:"ok", bars: []}`. A null `exchange` must not throw (F10).

**Row-level edge cases** (synthetic rows spliced into a copy of a real fixture)
- [ ] `close: ""`, `"N/A"`, `null`, a missing key, `"0.0000"` or `"-1"` → that bar is dropped and the rest are kept.
- [ ] `open/high/low` missing but `close` valid → bar kept, missing fields set to `close` (or `null`; pin the choice).
- [ ] `volume` missing, `null` or `"--"` → bar kept with `v: null`, **not 0**.
- [ ] `tradeTime` missing, `"2026102204"` (short) or `"abcd…"` → bar dropped.
- [ ] `tradeTimeinMills` missing → bar still parsed from `tradeTime` (it is the source of truth, F7).
- [ ] Bars out of order → output sorted ascending.
- [ ] Duplicate `tradeTime` → one bar, the later one in input wins.
- [ ] `high < low` → dropped (or swapped; pin it).
- [ ] Values with thousands separators `"1,270.7500"` → 1270.75 (reuse `toNum` from `worker/cnbc.js`; a test asserts the two modules agree).
- [ ] A bar all-flat (`o=h=l=c`, ATCX F12) → kept.

**Thin tickers and class shares**
- [ ] `atcx-5m-today` → 12 bars, first at 10:00, and no synthetic fill for the missing 5-minute slots.
- [ ] `brkb-dot-5m` → 82 bars. `brkb-dot-1d` → 15 bars. The parser ignores `barData.symbol` (`BRKb` / `65816`).

**URL builder**
- [ ] `barsUrl("BRK.B","1D",start,end)` === `https://ts-api.cnbc.com/harmony/app/bars/BRK.B/1D/<start>/<end>/adjusted/EST5EDT.json`. The dot stays a dot and is not `%2E`. The URL contains no `/` beyond the path segments.
- [ ] `normSym` cases feed the builder: `brk-b`, `BRK/B`, `BRK_B` → `BRK.B` (F3). `""`, `"A B"`, `"../x"`, `"AAPL/1D"`, a 7-character ticker or `"$AAPL"` → null.
- [ ] `start`/`end` are 14 digits (`YYYYMMDDHHmmss`).
- [ ] The URL ends `/adjusted/EST5EDT.json` (F14). Mutating it to `unadjusted` or `UTC` fails here.
- [ ] Interval is in `{5M,30M,1D,1W,1MO}` only. Anything else throws or returns null before any fetch.

---

## 3. `src/bars.check.ts`: range → window, sessions, today's bar, volume (client or shared pure logic)

The header comment carries its `npx tsc … && node …` line, like `chartSession.check.ts`. Inputs are injected (`nowMs`, never `Date.now()` inside). The ET clock is derived through `easternNow`-style Intl, so the check passes in any `TZ`. Run it once with `TZ=UTC` and once with `TZ=Asia/Jerusalem` in the plan's verification step.

**Range → {interval, start, end}** (`windowFor(range, nowMs)`)
- [ ] The table is pinned: 1D→5M, 1W→30M, 1M/3M/6M/YTD/1Y/2Y→1D, 5Y→1W, ALL→1MO. One assert per range.
- [ ] Every range in `RANGES` (StockModal) has a window. A test iterates the exported list, so adding a range without a window fails.
- [ ] **ET date, not UTC:** `now = 2026-10-22T02:00Z` (= 22:00 ET on 10-21) → 1D start `20261021…`. Mutation `toISOString().slice(0,10)` → `20261022`, and this fails.
- [ ] **Weekend:** Sat 2026-10-24 12:00 ET → the 1D window reaches back to cover Fri 10-23 (start ≤ `20261023000000`). Sun 2026-10-25 the same. Monday 03:00 ET (before the first 04:00 bar) → still covers Friday.
- [ ] **Holiday:** Fri 2025-07-04 (absent in `aapl-1d-holiday`) → the 1D window covers Thu 07-03. Thanksgiving Thu 2026-11-26 → covers Wed 11-25. Pin the lookback as "≥ 4 calendar days, then keep the last session", which survives a long weekend plus a holiday (for example Good Friday + weekend).
- [ ] **DST:** Sun 2026-03-08 and Sun 2026-11-01 (transition days) → the 1D window still resolves to the prior Friday's session. A 1W window spanning 2026-03-06…03-10 keeps all 3 sessions (`aapl-30m-dst-mar2026`, 96 bars).
- [ ] 1W start = now − 7 calendar days at 00:00 ET. On Thu 10-22 → `20261015000000` (matches `aapl-30m-7d`: 6 days, 178 bars).
- [ ] 1M/3M/6M/1Y/2Y start = now minus 1/3/6/12/24 months, at 00:00 ET. Month-end clamping: 2026-03-31 minus 1M → 2026-02-28, not 03-03.
- [ ] YTD start = Jan 1 of the ET year. On 2027-01-01 01:00 ET YTD has no daily bar yet: pin the fallback, for example "previous year's last 5 sessions" or an empty-state, so the chart is not a crash.
- [ ] 5Y start = now − 5y. ALL start ≤ `19800101` (AAPL's first monthly bar is `19801201`).
- [ ] `end` is today 23:59:59 ET for every range, so it never cuts today's intraday bars.
- [ ] The window string for a given `(range, nowMs)` is stable within the cache TTL bucket. This is the worker cache key (§4): two calls 10s apart give the same key for 1M.

**Intraday stamps and sessions**
- [ ] `tradeTime` → `"YYYY-MM-DD HH:MM"` stamp that `sessionSlice` accepts (it rejects anything without a space, including TD's `HH:MM:SS`; assert the adapter's output exactly).
- [ ] Minute-of-day comes from `tradeTime`. On `aapl-5m-dst-mar2026`, the 03-06 (EST) first bar is `04:00` = 240 and the 03-09 (EDT) first bar is 240 too. Mutation: derive from `tradeTimeinMills − 4h` → 03-06 reads 03:00, and this fails (F7).
- [ ] **Pre/post filter (1D chart):** `aapl-5m-today` → 42 bars, 09:30…12:55. `aapl-5m-yesterday` → 78 bars, 09:30…15:55, so the 16:00 closing-cross bar is **excluded**. Pin it: the last regular bar is 15:55, and the 16:00 close is carried by `quote.pc`/the daily bar.
- [ ] With the filter, `sessionSlice(...).dStart === 570` and `dEnd === 960`. Without the filter dStart would be 240 (04:00): the mutation "drop the filter" fails here.
- [ ] Keep pre/post in the **1W 30M** series or not, as decided: pin `aapl-30m-7d` → 72 regular bars (6 days × 12, minus the partial day) if filtered, or 178 if not. One assert locks the decision.
- [ ] Thin ticker: `atcx-5m-today` → 12 regular bars, first minute 600 (10:00). `dStart = 570` (axis still starts at the open) and no fabricated bars.
- [ ] A session with 1 regular bar → `sessionSlice` returns null, so the caller falls back. This fails if the adapter pads.
- [ ] Before 09:30 ET on a trading day (pre-market only today), the 1D chart shows **the previous session**, not an empty chart or a pre-market-only chart. Input: today's 5M with only pre bars plus yesterday's bars. Pin "latest date that has ≥ 2 regular bars".
- [ ] `live` stays false on a holiday weekday: `marketOpen` doesn't model holidays, and `sessionSlice.live` must not be true when the newest regular bar's date ≠ ET today. This is an existing invariant, re-asserted on CNBC stamps.

**Today's bar (daily/weekly/monthly)** (`withToday(bars, quote, nowET, interval)`)
- [ ] 1D bars ending `20261021` plus a quote with `day === "2026-10-22"` and `px 345.755` → one bar appended for 2026-10-22, close 345.755. `last === 345.755`.
- [ ] Same input but `quote.day === "2026-10-21"` (quote not updated yet / holiday) → nothing appended.
- [ ] Saturday: `quote.day` = Friday, and the bars already end Friday → nothing appended and nothing duplicated.
- [ ] Bars already include today (CNBC changes behavior and starts sending it) → replaced, not duplicated. The length is unchanged.
- [ ] `quote == null` (CNBC down) → bars untouched, and the chart still renders through yesterday.
- [ ] 1W: the last bar (current week, Sunday stamp 10-18) gets its close **replaced** by the live px, with no new bar. 1MO: the last bar (10-01) is the same.
- [ ] Before 09:30 ET with only a pre-market `ext` price → no today bar (the regular `px` is still yesterday's close).
- [ ] The returned `hi/lo` include the appended close.

**Volume stat** (`todayVolume(...)`; pin one definition and keep the rest as negative asserts)
- [ ] Recommended: CNBC quote `volume` if `parseQuote` gains it, else Σ regular 5M bars 09:30–15:55 of ET today. With `aapl-5m-today` that is **12,510,865**.
- [ ] Negative: ≠ Σ all bars of today (12,980,317, which includes pre-market).
- [ ] Negative: for yesterday's bars as "today", the result is never 117,709,697 + … (the 16:00 cross, F5). Σ regular = 18,371,746. Pin the expected value.
- [ ] Off-session (Sat): the stat shows the last session's figure (pin: daily bar `v` = 35,614,126 from `aapl-1d-1y`, or "—"), never 0.
- [ ] **Independent of the selected range:** the same value for 1D/1W/1Y/5Y. This is the regression test for TD's "last bar of whatever range is selected" (`StockModal.tsx` `series.volume`, which was a weekly or monthly bar's volume on 5Y/ALL).

---

## 4. `ci/test-worker-bars.mjs`: the `/bars` endpoint (`worker/index.js`)

Same harness as `ci/test-worker-quotes.mjs`: stub `globalThis.fetch`, drive `Date.now`, and load fixtures from `ci/fixtures/cnbc-bars/`. Upstream routing by URL: the stub parses `/{SYM}/{INT}/` from the URL and returns the matching fixture.

**Routing, origin, method**
- [ ] `GET /bars?symbol=AAPL&range=1D` from `env.ORIGIN` → 200, `access-control-allow-origin` echoes the origin, `vary: origin`.
- [ ] `http://localhost:5173` and `http://127.0.0.1:4173` → allowed. `http://localhost.evil.com:80` and `https://localhost:5173` → 403.
- [ ] Foreign origin or missing `Origin` → 403, with **0 upstream calls**.
- [ ] `OPTIONS` → 2xx, `access-control-allow-methods: GET`, no upstream call.
- [ ] `POST`/`PUT` → 405 with CORS headers.
- [ ] `/bars` does not fall through to the track-dispatch POST branch: a `POST /bars` must not call `api.github.com` (assert no GitHub call).

**Validation (400 before any upstream call)**
- [ ] Missing `symbol`. `symbol=` (empty). `symbol=AAPL,MSFT` (multi). `symbol=../../x`. `symbol=AAPL%2F1D`. A ticker of 7+ characters.
- [ ] `range` missing, `range=1d` (case: pin whether accepted), `range=2D`, or `range=__proto__` → 400. `range=constructor` → 400 (prototype-key lookup guard).
- [ ] `symbol=brk-b&range=1D` → 200, and the upstream URL contains `/BRK.B/` (F3). `symbol=BRK/B` → the same, and it never sends `BRK/B` (which 400s upstream).

**Response contract**
- [ ] 200 body `{symbol, range, interval, asOf, bars:[[t,o,h,l,c,v],…]}` (or as agreed). It is numbers only, and the byte size is about 1/3 of the CNBC body (assert `<` 50% for `aapl-1w-5y`).
- [ ] Unknown symbol (`err-unknown-sym`) → **404** `{error:"unknown"}`. This does **not** trip failure memory: an immediate request for AAPL still calls upstream.
- [ ] `err-bad-interval` (our URL bug) → 502, and it is logged.
- [ ] Empty `priceBars` (weekend 5M) → 200 `bars: []`. The client then falls back to the last session (§3). This is not a 502 and not remembered as a failure.
- [ ] Upstream request: UA === `BROWSER_UA`, `accept: application/json`, `signal` is an `AbortSignal` (timeout).

**Cache per range**
- [ ] The TTL table is exported and pinned. Suggested values: 1D 60s, 1W 5min, 1M–2Y 30min, 5Y/ALL 6h. Assert each value, so a change is a deliberate test edit.
- [ ] For each range, walking the clock to `TTL−1ms` gives 0 new upstream calls, and `TTL+1ms` gives 1 new call.
- [ ] The key is `SYMBOL|range`. AAPL 1D and AAPL 1Y are 2 upstream calls. `aapl`, `AAPL` and ` AAPL ` share one key (normalized). BRK-B and BRK.B share one key.
- [ ] 1M/3M/6M/1Y/2Y each have their own window, so they are separate keys. (If the implementation shares one 2Y daily fetch and slices it, assert **1** upstream call for all five. Pin whichever is built.)
- [ ] A 404-unknown is cached too (negative cache, ≥ the 1D TTL), so a junk ticker can't be replayed into upstream calls.
- [ ] Cache shared across origins: the site and localhost hit the same entry.

**Byte-bounded cache** (`ci/test-worker-bars-cache-bound.mjs`, one module instance per case via `?case=` import, as in `test-worker-cache-bound.mjs`)
- [ ] `BARS_CACHE_MAX_BYTES` exported. Filling the cache with synthetic bodies totalling > max evicts the **oldest** entries first, and the total stays ≤ max after every insert (assert the exported `cacheBytes()` or count entries).
- [ ] A single body larger than the max is served (200, correct body) but **not cached**: the next identical request makes another upstream call.
- [ ] A clear or eviction during a concurrent request never blanks that request's answer, because the answer is built from its own fetch result (mirrors the `/quotes` guarantee).
- [ ] Size is counted in **bytes of the stored string** (UTF-16 length × 2, or `TextEncoder` length; pin it), not entry count. A test with 2 entries of very different sizes proves it: 1 huge + many tiny, then the tiny ones survive.
- [ ] An ALL (1MO, about 551 bars) body for 300 distinct symbols stays within the bound. This is the worst-case realistic load.

**Coalescing**
- [ ] 5 concurrent `/bars?symbol=AAPL&range=1Y` misses → **1** upstream call, and all 5 get identical 200 bodies.
- [ ] Concurrent AAPL 1Y + AAPL 1D → 2 calls (different keys never coalesce).
- [ ] A coalesced upstream failure → all waiters get 502, and the in-flight entry is removed: after the failure TTL, a new request calls upstream again (no leaked promise).
- [ ] A timeout (stub never resolves; drive `AbortSignal.timeout` with a short exported `BARS_TIMEOUT_MS` or a fake signal) → 502 within the timeout, and in-flight is cleared.

**Failure memory**
- [ ] Upstream non-2xx (`brkb-slash` HTML 400, 403, 429, 500), a network throw, a non-JSON body or a reshaped envelope → 502, and remembered. A retry inside the window → 502 with **0** upstream calls. After the window → upstream is called again.
- [ ] Failure memory is scoped per pick: **global for `/bars` only**. It must not share state with `/quotes`: a `/bars` failure must not make `/quotes` 502, and the reverse. Mutation "reuse `failedUntil`" fails here.
- [ ] Pin the decision: does a failure on AAPL block MSFT? Recommended yes, a global `barsFailedUntil`, the same logic as `/quotes` (an upstream block is upstream-wide). Assert it.
- [ ] **Stale-on-error (if built):** a cached entry past its TTL plus an upstream failure → serve the stale body with `x-stale: 1` instead of 502. Otherwise assert 502. Pin one.

**Regression of existing worker tests**
- [ ] `node ci/test-worker-quotes.mjs`, `ci/test-worker-cache-bound.mjs`, `ci/test-worker-relay.mjs` and `ci/test-cnbc-worker.mjs` are unchanged and green. `/bars` must not alter `/quotes` behavior.

---

## 5. `src/peHistory.check.ts` (extend) + `src/bars.check.ts`: P/E overlay math parity

- [ ] `weeklyFromCnbc(bars)` (the adapter both the client and CI use) maps the Sunday stamp → **Monday** `YYYY-MM-DD`. `20261018` → `2026-10-19`. `20211017` → `2021-10-18`. A Sunday at month end, `20230430` → `2023-05-01`. A Sunday at year end, `20261227` → `2026-12-28`.
- [ ] The adapter output is fed to the unchanged `peSeries`. For a synthetic EPS series the result equals the same series built from Monday-stamped TD-style inputs, so it is byte-identical.
- [ ] `closeAt`: the Friday of a shifted CNBC week is Monday + 4. A Sunday stamp (no shift) would make the Friday a Thursday. Assert `closeAt(["2025-03-30"], …,"2025-04-03")` ≠ `closeAt(["2025-03-31"], …,"2025-04-03")`. This documents why the shift is not cosmetic.
- [ ] The client off-universe path (PeHistory `loadSeries` → 5Y CNBC via `/bars`) and the CI path (`scrape-pe` weekly) produce **identical** `pts` for the same raw bars. Both import one adapter, and the test asserts the adapter is the same function reference exported from one module (no copy).
- [ ] The partial current week: the last 1W bar (current week, close = yesterday's) maps to this week's Monday. `scrape-pe` step 2 then overwrites it with `px` (`lastBar[0] === thisMonday` → replace). Assert no extra point is pushed.

---

## 6. `ci/test-scrape-pe-cnbc.mjs`: CI P/E scrape parity (golden)

Precondition (implementation part): `scrape-pe.mjs` must be importable without side effects. Either move the fetch and the offline recompute into `ci/pe-build.mjs` exports (`weeklyCnbc(t, fetchImpl)`, `recompute(cache, {px, today})`), or guard the main with an `import.meta.url` check like `ci/keep.mjs`. This test imports only those.

**Fetch path (stubbed fetch, fixture `aapl-1w-5y`)**
- [ ] `weeklyCnbc("AAPL")` requests `…/AAPL/1W/<5y-ago>000000/<today>235959/adjusted/EST5EDT.json` with `BROWSER_UA`. It returns 262 `[MondayDate, close4dp]` pairs, oldest-first.
- [ ] **Golden vs the committed cache:** the dates equal `ci/cache/pe/AAPL.json` `closes` dates **262/262**. Closes are within 5bp on 261/262. The single allowed divergence is `2023-04-03` (164.66 vs 163.76). Assert exactly that one, so a new divergence fails loudly.
- [ ] `err-unknown-sym` → throws a normal `Error` (index entry gets `err` + backoff), **not** `DailyLimit`.
- [ ] HTTP 403 or HTML → throws. `priceBars: []` → throws `"no values"` (same handling as TD's empty), so a backfill is never written empty.
- [ ] The `TD`/`TWELVEDATA_CI_KEY` gate is gone: with no TD env var set and `hasEarnings && !c.closes`, the CNBC fetch happens.
- [ ] Pacing constant `CNBC_GAP_MS` exists and is ≥ 1000. Assert successive stubbed calls are spaced (drive with a fake `sleep`).

**Offline recompute golden (pure refactor guard)**
- [ ] For **every** `public/pe/<T>.json` (231 today), `recompute(ci/cache/pe/<T>.json, {px: undefined})` `.pts` deep-equals the committed file's `pts` (F9: 231/231 today). This test is date-independent: no `px` means no last-bar mutation, and `asOf` is excluded from the comparison.
- [ ] AAPL with CNBC closes instead of the cached TD closes → equals `public/pe/AAPL.json` on **260/261** points, the only diff at `2023-04-03` with rel diff < 1%. Pin the count and the date.
- [ ] Mutation guard: the same AAPL run with **raw Sunday stamps** → ≥ 250 points differ (261 today). Assert `> 200`, so the test itself proves the shift matters.
- [ ] `px` injection: `recompute(c, {px: 350, today: "2026-10-22"})` → the last point's date is `2026-10-19` and its P/E uses 350. `today: "2026-10-26"` (new week) → one point pushed, length +1, and capped at 262 closes.
- [ ] `ci/test-pe-files.mjs` is unchanged and still green (the output shape gate).

---

## 7. `ci/test-no-twelvedata.mjs`: removal guard

- [ ] Grep `src/`, `ci/` (excluding `ci/README.md` history notes, if kept, and `ci/fixtures`), `worker/` and `.github/workflows/` for `api.twelvedata.com`, `TWELVEDATA`, `VITE_TWELVEDATA_KEY` and `twelvedata`. Assert 0 hits. Print the hit count. Today's hits are `src/chartSession.ts` (comment), `src/vite-env.d.ts`, `src/components/StockModal.tsx`, `ci/scrape-pe.mjs`, `site.yml` and `track-requests.yml`. Run it before the implementation as a red-first proof.
- [ ] Grep `src/components/StockModal.tsx` for `fetchSeries` calling `` `${WORKER}/bars` `` (or the agreed helper) and **not** `fetch("https://ts-api.cnbc.com…")`. The browser must never call CNBC directly (CORS `*` makes that possible, so the guard matters).

---

## 8. Mutation targets: each must turn a named test red

For each one, apply the mutation, run the single file, expect non-zero, then run `git checkout -- <file>`. Record the result in the PR description.

| # | Mutation (file) | Must fail |
|---|-----------------|-----------|
| M1 | `parseBars`: `Number(x.close)` → `x.close` (strings leak through) | §2 "every field typeof number" |
| M2 | `classifyBody`: drop the `status==="ERROR"` branch | §2 err-unknown / §4 404 |
| M3 | Treat `Security Master not found` as an upstream failure | §4 "unknown does not trip failure memory" |
| M4 | Remove `normSym` in `/bars` | §4 BRK/B → URL contains `/BRK.B/` |
| M5 | URL `adjusted` → `unadjusted`, or `EST5EDT` → `UTC` | §2 URL suffix |
| M6 | `windowFor` uses the UTC date | §3 "ET date, not UTC" |
| M7 | 1D lookback 0 days (today only) | §3 weekend / holiday / Monday 03:00 |
| M8 | Minute-of-day from `mills − 4h` | §3 DST 03-06 bar |
| M9 | Drop the pre/post filter | §3 dStart 570 |
| M10 | Keep the 16:00 bar in the regular session | §3 78-bar / last-15:55 assert, §3 volume |
| M11 | Volume = Σ all of today's bars | §3 volume ≠ 12,980,317 |
| M12 | Volume = last bar of the selected series | §3 "independent of range" |
| M13 | `withToday` appends without checking `quote.day` | §3 holiday / Saturday |
| M14 | `withToday` appends a weekly bar instead of replacing | §3 1W replace |
| M15 | Cache key without range | §4 1D vs 1Y = 2 calls |
| M16 | Cache by entry count, not bytes | §4b huge + tiny survives |
| M17 | Cache an over-max body | §4b "served but not cached" |
| M18 | Remove the `inflight` map | §4 5 concurrent → 1 call |
| M19 | Don't delete inflight on failure | §4 retry after failure TTL calls upstream |
| M20 | Share `failedUntil` with `/quotes` | §4 failure-memory isolation |
| M21 | Drop `signal: AbortSignal.timeout` | §4 timeout signal assert |
| M22 | Weekly adapter: no Sunday→Monday shift | §5 Monday mapping, §6 ≥ 200 points differ |
| M23 | `scrape-pe`: keep the `TD &&` gate | §6 "no TD env → still fetches" |
| M24 | `scrape-pe`: `[]` bars written as closes | §6 empty → throws |
| M25 | Any leftover `api.twelvedata.com` | §7 |

---

## 9. Verification (run in order)

- [ ] `node ci/test-no-twelvedata.mjs`: **red** before implementation (proves the guard bites), green after.
- [ ] Each new file standalone: `node ci/test-cnbc-bars-parse.mjs`, `node ci/test-worker-bars.mjs`, `node ci/test-worker-bars-cache-bound.mjs`, `node ci/test-scrape-pe-cnbc.mjs`. Each prints ≥ 1 `ok` line per case and exits 0.
- [ ] `TZ=UTC npm test` and `TZ=Asia/Jerusalem npm test`: both green (the ET logic must not lean on the host TZ).
- [ ] `npx tsc --noEmit`: clean.
- [ ] Mutation table §8: every row red, and the files restored after.
- [ ] `node ci/cnbc-bars-contract.mjs` (manual, network): the live shape still matches the fixtures. Run it on a weekday during the session **and** once on a weekend.
- [ ] Node: tests need ≥ 22.18 (`.ts` imports from `.mjs`); this machine is v26 (fine for tests).
