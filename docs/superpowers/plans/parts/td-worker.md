# Part: Worker `GET /bars` (CNBC chart bars), replacing Twelve Data in the stock modal

Scope: the Worker side only (`worker/`, `ci/test-*`). The client swap in
`src/components/StockModal.tsx` (`fetchSeries`) is covered by the client part. This part
defines the contract that the client part depends on.

## 0. Measured facts (AAPL, 2026-10-22 ~12:59 ET, BROWSER_UA from `worker/cnbc.js`)

URL: `https://ts-api.cnbc.com/harmony/app/bars/{SYM}/{INT}/{start}/{end}/adjusted/EST5EDT.json`

| Range | INT | window sent | raw bars | CNBC raw | CNBC gzip | compact out (RTH-filtered) | out gzip | parse+map (Node) |
|---|---|---|---|---|---|---|---|---|
| 1D  | 5M  | today−4d .. now | 683 (incl pre/post) | 103.5 KB | 16.2 KB | 42 bars (mid-session) / 78 full day, 1.5 KB | 0.47 KB | 0.42 ms |
| 1W  | 30M | today−9d | 242 | 37.2 KB | 6.6 KB | 59 bars, 2.1 KB | 0.64 KB | 0.17 ms |
| 1M  | 1D  | −1 month | 22 | 3.6 KB | 0.9 KB | 0.7 KB | 0.32 KB | 0.02 ms |
| 3M  | 1D  | −3 months | 65 | 10.2 KB | 2.2 KB | 1.9 KB | 0.74 KB | 0.04 ms |
| 6M  | 1D  | −6 months | 127 | 19.8 KB | 4.1 KB | 3.7 KB | 1.4 KB | 0.08 ms |
| YTD | 1D  | Jan 1 | 202 | 31.3 KB | 6.3 KB | 5.9 KB | 2.1 KB | 0.13 ms |
| 1Y  | 1D  | −1 year | 251 | 38.9 KB | 7.7 KB | 7.3 KB | 2.6 KB | 0.16 ms |
| 2Y  | 1D  | −2 years | 501 | 77.4 KB | 15.0 KB | 14.5 KB | 5.1 KB | 0.32 ms |
| 5Y  | 1W  | −5 years | 262 | 40.8 KB | 8.7 KB | 7.9 KB | 3.0 KB | 0.17 ms |
| ALL | 1MO | 1970-01-01 | 551 (from 1980-12) | 82.6 KB | 17.2 KB | 17.2 KB | 6.4 KB | 0.37 ms |

Latency: 0.37–1.1 s cold from Israel. A repeated identical URL took about 60 ms, so CNBC
caches identical URLs on its side. The day-granular windows in §2 rely on this. `Cache-Control: max-age=1`.

Behaviour verified with curl:
- **No UA → 403.** BROWSER_UA → 200 (same as `/quotes`).
- **Errors come back as HTTP 200 with an error body:** `{"requestDetails":{…},"status":"ERROR","statusMessage":"… Security Master not found"}`
  for an unknown symbol. A bad INT gives `"barType: null null"`. Success has no `status`,
  only `barData`.
- **`BRK.B` works** in dotted form, so `normSym()` canon applies unchanged.
- **Every range except 5M/30M stops at yesterday.** The daily series has no bar for today
  during the session, even with `end` = tomorrow. Weekly and monthly bars cover only through
  yesterday's close. (TD's daily feed included today's partial bar.) → the client part must
  append/patch the last point from the live quote (§7).
- **Weekly bars are stamped on Sunday** (`20261018000000`). Twelve Data stamps them on
  Monday, and `src/peHistory.ts:81-87` `closeAt()` hard-codes "Monday + 4 = Friday" for the
  5Y P/E overlay. → the server shifts weekly stamps to Monday (§3). Monthly bars are stamped
  on the 1st (same as TD).
- **Intraday includes pre/post data:** 5M bars run 04:00–19:55 ET (192 per day, 78 in
  regular hours). 30M bars run 04:00–19:30 (13 in regular hours, 09:30…15:30). The current 5M
  bar is included and in progress (at 12:59:23 the last bar was 12:55).
- **CNBC does not cap the window.** `5M` from Jan 1 returned 13,700 bars / **2.07 MB**. The
  window must never come from the client.

## 1. API contract

```
GET /bars?symbol=AAPL&range=1D
```

Request validation (in this order, with no CNBC call on any reject):
1. `allowedOrigin(origin, env)` fails → `403 "forbidden"` (no CORS header). This is the same
   gate as `/quotes`.
2. `OPTIONS` → preflight 2xx, `allow-methods: GET`. Non-GET → `405` with CORS headers.
   (A plain GET with no custom headers is a simple request, so browsers send no preflight.
   The client must keep it that way: no custom headers, so each chart load costs one
   request, not two.)
3. `symbol` → `normSym()` from `worker/cnbc.js` (one symbol; no comma lists). null →
   `400 {"error":"bad symbol"}`.
4. `range` ∈ `1D 1W 1M 3M 6M YTD 1Y 2Y 5Y ALL`, case-sensitive, exact match. Otherwise →
   `400 {"error":"bad range"}`.
5. The Worker ignores any other parameter. `start`/`end`/`interval` are **never** accepted
   from the client.

Success `200`, `content-type: application/json`, CORS `access-control-allow-origin: <origin>`,
`vary: origin`, `cache-control: max-age=<TTL s>`:

```json
{ "s": "AAPL", "r": "1D", "i": "5M", "asOf": 1792702763000,
  "t": ["2026-10-22 09:30", "2026-10-22 09:35", …],
  "c": [343.81, 343.18, …],
  "v": [1234567, 98765, …] }
```

- `t`, `c` and `v` are parallel arrays, oldest first. Using column arrays instead of an array
  of objects cuts about 40% before gzip.
- `t` uses **ET wall-clock strings in Twelve Data's format**, so `sessionSlice`,
  `fmtScrub`, `buildChart` and `peHistory.closeAt` work unchanged.
  - Intraday ranges (1D, 1W) use `"YYYY-MM-DD HH:MM"`. `sessionSlice` splits on the space
    and the colon.
  - Daily ranges use `"YYYY-MM-DD"`.
  - Weekly stamps are shifted to that week's **Monday** (CNBC's Sunday + 1 day), to keep TD
    semantics.
  - Monthly stamps use `"YYYY-MM-01"`.
- `c` is the close, parsed from CNBC's string, rounded to 4 dp, and always > 0. Bars whose
  close does not parse to a finite value > 0 are dropped.
- `v` is the volume, an integer or `null`.
- `i` is the CNBC interval used. It is informational: the client derives "intraday" from it
  (`i` ends with `M` and is not `1MO`), replacing `RANGE_CFG[range].interval.includes("min")`.
- `asOf` is the server time when the bars were fetched (ms). It is the cache-entry age, not
  the time of the last bar.
- **OHLC is omitted.** The modal draws a line from closes only (`fetchSeries` parses o/h/l
  and then discards them). Add a comment like
  `ponytail: closes only; add o/h/l arrays (or ?ohlc=1) when candles ship` in the code.

Errors (every one carries CORS, so the client sees the status instead of an opaque failure):

| status | body | when | client does |
|---|---|---|---|
| 400 | `{"error":"bad symbol"}` / `{"error":"bad range"}` | validation | bug, so show the unavailable state; no fallback |
| 403 | `forbidden` (no CORS) | foreign origin | n/a |
| 404 | `{"error":"no data"}` | CNBC `status:"ERROR"` body, or 0 bars after filtering | fall back to TD (§7) |
| 405 | `GET only` | wrong method | n/a |
| 502 | `{"error":"upstream"}` | timeout, non-2xx, non-JSON, reshaped envelope, or the failure memory below is active | fall back to TD (§7) |

## 2. Range → interval and window (server-side, pure)

Compute "today" in ET with `Intl.DateTimeFormat("en-US", { timeZone: "America/New_York" })`,
the same way as `src/chartSession.ts` `easternNow`. **Both `start` and `end` are
day-granular**: `start` is a date at `000000`, and `end` is **tomorrow (ET) at
`000000`**. This makes the upstream URL identical for a whole ET day, which helps CNBC's own
cache (the cold/warm timings above) and makes tests deterministic. End = tomorrow still
returns bars up to now (verified).

| Range | INT | start | post-filter | TTL |
|---|---|---|---|---|
| 1D  | 5M  | today − 5 days | RTH only, then keep only the **latest date** that has RTH bars | 60 s |
| 1W  | 30M | today − 10 days | RTH only, then keep the **last 5 dates** | 5 min |
| 1M  | 1D  | today − 1 calendar month | none | 1 h |
| 3M  | 1D  | today − 3 months | none | 1 h |
| 6M  | 1D  | today − 6 months | none | 1 h |
| YTD | 1D  | Dec 20 of the previous year | keep the **last bar before Jan 1** (anchor) plus every bar of this year | 1 h |
| 1Y  | 1D  | today − 1 year | none | 1 h |
| 2Y  | 1D  | today − 2 years | none | 1 h |
| 5Y  | 1W  | today − 5 years | Sunday stamp → Monday | 1 h |
| ALL | 1MO | `19700101` | none | 6 h |

- **1D window of 5 days:** the worst gap before the open is a weekend plus a Monday holiday
  (Tuesday 08:00 → last session is Friday, 4 days back), plus 1 day of margin. Before 09:30
  this naturally returns yesterday's session, which matches today's TD behaviour and what
  `sessionSlice` expects. The raw fetch is at most ~960 bars / ~150 KB, still below 1 ms of
  parsing.
- **Pre/post filtering happens on the server** (regular hours: `09:30 ≤ HH:MM < 16:00`):
  - The 1D chart draws a fixed 09:30–16:00 axis (`chartSession.ts` `SESSION_OPEN/CLOSE`).
  - Twelve Data never sent extended-hours bars, so the client stays at parity with no new
    rendering logic.
  - The payload for 1D drops from 192 to 78 bars per day.
  - The live extended-hours price already comes from the quote's `ext` field.
  - Add a comment like `ponytail: RTH only; ?ext=1 returning the 04:00–20:00 bars is the
    upgrade if the chart ever draws extended hours`.
- **YTD anchor:** TD's `outputsize 200` was not really YTD. With the prior-year close as the
  first point, `(last − first)/first` is the true YTD return, and it still works on Jan 2
  when only 1 to 2 bars exist.
- **Calendar windows for 1M…2Y** replace TD's "last N bars" counts. The difference is at
  most a bar at each edge.

## 3. Module layout

- **New `worker/bars.js`**: pure, with no Workers globals, so the `ci/` tests import it
  straight into Node, like `cnbc.js`. Exports:
  - `CNBC_BARS` (base URL)
  - `RANGES` (the frozen config table from §2)
  - `etToday(nowMs)` → `{ y, m, d }`
  - `barsUrl(sym, range, nowMs)` → string
  - `parseBars(body, range)` → `{ t, c, v }`. It throws `NoData` on a CNBC `status:"ERROR"`
    body or on 0 bars after filtering, and throws `Error` on a reshaped envelope (no
    `barData.priceBars` array).
  - `isRth(tradeTime)`
  - `mondayOf(tradeTime)`

  It reuses `BROWSER_UA` and `normSym` from `cnbc.js`.
- **`worker/index.js`**: add a `bars(url, cors)` handler next to `quotes()`, and route
  `/bars` through the same origin/CORS/OPTIONS/405 block as `/quotes`
  (`if (url.pathname === "/quotes" || url.pathname === "/bars")`).

## 4. Cache, coalescing, failure memory, timeout

Follow `/quotes` (`worker/index.js` top), but with its own state, because the host and the
failure modes are different:

```js
const BARS_CACHE_MAX_BYTES = 8 * 1024 * 1024; // sum of cached body lengths
const barsCache = new Map(); // "SYM|RANGE" -> { body: string, at, ttl, bytes }  (Map order = insertion = LRU-ish)
let barsBytes = 0;
const barsInflight = new Map(); // "SYM|RANGE" -> Promise<{status, body}>
let barsFailedUntil = 0;        // transport-level failure memory
const BARS_FAIL_MS = 30_000;
// timeout: AbortSignal.timeout(CNBC_TIMEOUT_MS) — reuse the 5 s constant
```

- **Cache the serialized response body string**, not parsed objects. Then the byte
  accounting is exact (`body.length`, ASCII only), and a hit costs no `JSON.stringify`.
- **Bound the cache by bytes, not entries.** Entries range from 0.3 KB (1M) to about 25 KB
  (ALL for a 1962 listing such as IBM). An entry cap would be meaningless.
  - On insert: `delete` and re-`set` the key so it moves to the end, then evict from the
    front of the Map until `barsBytes ≤ BARS_CACHE_MAX_BYTES`.
  - This evicts oldest-first and is still O(1) per eviction. It is not the clear-all used by
    `/quotes`: bars entries differ in TTL by up to 360×, and a clear-all would throw away
    hours-long ALL/5Y entries because 1D churns.
  - 8 MB is about 6% of the 128 MB isolate and holds roughly 500 worst-case or 3,000+
    typical entries, which is far more than this app's traffic needs.
  - The response is built from the request's own result, never re-read from the cache after
    `await`. This is the same invariant as `/quotes`, so eviction by a concurrent request
    cannot blank it.
- **Negative cache:** `NoData` (unknown symbol, or no RTH bars) is cached as a 404 body with
  a **TTL of 1 h**. Junk symbols then cost CNBC one call per hour each, and their bytes
  count against the same bound.
- **Coalescing:** concurrent misses on the same `SYM|RANGE` share one promise. Delete the
  key in `.finally` only if it is still the same promise, the same pattern as `/quotes`.
- **Failure memory:** the following set `barsFailedUntil = Date.now() + 30 s` (time measured
  from the failure):
  - timeout or abort
  - HTTP non-2xx (403 = UA or IP block)
  - a non-JSON body
  - a reshaped envelope

  While that is active, every cache miss answers `502` immediately. Cache hits are still
  served, because stale-but-valid entries stay useful while CNBC is down.
  - A per-symbol `status:"ERROR"` is **not** a transport failure. It is a 404 and does not
    trip the global memory, so one bad ticker cannot black out charts for everyone.
  - The bars memory is separate from the quotes `failedUntil`, because these are different
    hosts.
- **Timeout:** use `AbortSignal.timeout(5_000)`. The measured cold worst case was 1.1 s.

### `caches.default` (edge cache): decision is not to use it now

- The Cache API is **per-colo**: it is not replicated, so it would only help when a second
  visitor is served by the same colo as the first.
  - At this app's traffic (one or two isolates serve everyone), the in-isolate Map has the
    same hit rate.
  - Cache API reads and writes count as subrequests, and they add latency on a miss.
- The Worker is served from `*.workers.dev` (`src/workerUrl.ts`). The Cloudflare docs I read
  do not confirm whether `caches.default` works there. They name custom domains and
  `*.pages.dev`, and describe workers.dev only for a cache-key detail. This needs
  verification with `wrangler tail` before anyone depends on it.
- Mirror the `/quotes` comment: `ponytail: per-isolate; caches.default keyed by SYM|RANGE
  (with a custom-domain route) is the upgrade if traffic spreads across colos.`

## 5. Budget impact (Cloudflare Workers free plan)

- **Requests (100k/day, shared):** `/quotes` dominates. One open tab polling every 20 s is
  4,320 req/day if it stays open 24 h, or about 1,170 per 6.5 h session.
  - `/bars` costs one request per (modal open × range viewed), plus one for the 5Y P/E
    overlay (`StockModal.tsx:786`). The client already memoizes per page session
    (`seriesCache`, `StockModal.tsx:131`).
  - Estimate: 100 modal opens/day × about 3 = **300 req/day, about 0.3%** of the quota.
    This is negligible. It does not change the `/quotes` poll budget.
- **CPU (10 ms per invocation):**
  - Measured JSON.parse plus the filter/map is 0.42 ms for the worst normal case (1D, 683
    raw bars, 103 KB). The worst bounded case (5-day 5M window, about 960 bars) is about
    0.6 ms in Node. Even at 5× slower on Workers, that is about 3 ms.
  - Time spent waiting on `fetch` does not count as CPU time. A cache hit costs microseconds
    because the body is a pre-serialized string.
  - **A 500-bar parse is fine**: 2Y has 501 bars and took 0.32 ms.
- **Subrequests:** at most 1 per invocation (limit 50).
- **Memory:** 8 MB bound out of 128 MB.

## 6. Abuse and origin

- The `allowedOrigin` gate is the same one `/quotes` uses: the site plus localhost and
  127.0.0.1. It is not an auth boundary, because a non-browser client can forge `Origin`.
  Keep the existing comment.
- **The server owns the window.** The `range` enum plus server-computed `start`/`end` mean no
  request can ask CNBC for the 2 MB 5M year. The largest possible upstream pull is about
  150 KB (1D).
- `normSym` keeps junk out of the CNBC URL path: no `/`, no `..`, and at most 9 characters.
- **The cache key space is bounded by bytes, and negative results are cached.** An attacker
  rotating symbols can at most cause one CNBC call per (symbol, range) per TTL, and the 30 s
  failure memory stops hammering once CNBC starts refusing.
- If abuse shows up, add the Workers Rate Limiting binding keyed on `cf-connecting-ip`. Do
  not build it now (YAGNI).

## 7. Client fallback (decision)

**Keep Twelve Data as the fallback for one release, then remove it.**
- The bars endpoint is undocumented. Keeping TD costs nothing, because `fetchSeries`'
  current TD body already exists and becomes `fetchSeriesTD`, and `VITE_TWELVEDATA_KEY` is
  already shipped.
- Order: `/bars`, then on **404, 502, timeout or network error** fall back to TD, then show
  the existing "chart unavailable" state.
  - Do not fall back on 400, which is our bug.
  - Do not cache failures in `seriesCache`.
- Both paths must produce the same `Series` (`closes`, `stamps`). This is why §1 keeps TD's
  stamp format and Monday weekly stamps.
- Add a comment like `ponytail: TD fallback kept while CNBC bars is new; delete fetchSeriesTD
  and VITE_TWELVEDATA_KEY after N weeks with no fallback hits`. Optionally count fallback
  hits via `analytics.ts`.
- **Client-part dependency:** daily, weekly and monthly ranges end at yesterday (§0).
  - For 1M…ALL, append the live CNBC quote (`px`, `day`) as the final point when
    `quote.day > last stamp`, or patch the last weekly/monthly close when it falls in the
    same week or month.
  - Without this, the range change % ignores today's move, which is a regression versus TD.
  - Do this in the client, not the Worker: it keeps `/bars` cacheable for an hour, and the
    client already holds the quote.

## 8. Test plan (Worker part)

Tests are discovered by pattern and use no framework. Stub `fetch` and `Date.now` the same
way `ci/test-worker-quotes.mjs` does. Use a fresh module instance per case through
`import("../worker/index.js?case=…")`, as in `ci/test-worker-cache-bound.mjs`.

**Fixtures:**
- Synthesize bar arrays in the test: write a helper that builds CNBC-shaped
  `priceBars` for a date and interval, covering 04:00–19:55 for 5M.
- Commit a **trimmed** real sample, `ci/fixtures/cnbc-bars-aapl.json` (a few bars per
  interval, plus the real `status:"ERROR"` body), so the envelope shape is pinned to
  reality. Do not commit the 100 KB raw files.

### `ci/test-cnbc-bars.mjs` (pure, `worker/bars.js`)
1. `barsUrl` for each of the 10 ranges at a frozen time (for example 2026-10-22 12:59 ET):
   exact INT, `start` and `end` (= tomorrow `000000`), the symbol path-encoded, and the
   `adjusted/EST5EDT.json` suffix.
2. DST edges: just before and after 2026-03-08 and 2026-11-01. ET "today" is correct at
   23:30 UTC and 03:30 UTC (the date roll-over against UTC).
3. Window arithmetic: 1M on Mar 31 (→ Feb 28/29 clamp, no overflow into March), YTD on Jan 2,
   1D on Tuesday after a Monday holiday (the window reaches the previous Friday).
4. `isRth`: 09:25 false, 09:30 true, 15:55 true, 16:00 false, 04:00 false, 19:55 false.
5. 1D filter: 3 days of 5M (192 per day) → exactly 78 bars, all from the latest date,
   `t[0]` = `"YYYY-MM-DD 09:30"`, last = `"… 15:55"`. Mid-session (bars up to 12:55) →
   only today's bars. Pre-open (today has only 04:00–09:25 bars) → **yesterday's** 78.
6. 1W: 30M over 8 days → the last 5 dates × 13 bars, 09:30…15:30.
7. YTD: bars from Dec 22 to Jan 5 → the first output is the Dec 31 bar (anchor) followed by
   January only.
8. Weekly: a Sunday stamp `20261018…` → `"2026-10-19"`, including across a month and a year
   boundary (Sun Dec 28 → Mon Dec 29). Monthly → `"YYYY-MM-01"`.
9. Parsing:
   - String closes `"343.8100"` → `343.81`.
   - A close of `""`, `"N/A"`, `"0.0000"` or a negative value drops that bar, and the
     parallel arrays stay the same length.
   - A missing volume → `null`.
   - The output is oldest-first even if the input order is shuffled. Sort on
     `tradeTimeinMills` defensively, or assert ascending order.
10. Errors:
    - The real `status:"ERROR"` body throws `NoData`.
    - `{}`, `{barData:{}}`, or a `priceBars` that is not an array throws a reshape `Error`
      (not `NoData`).
    - 0 bars after filtering throws `NoData`.

### `ci/test-worker-bars.mjs` (handler, through `worker.fetch`)
11. CORS: the site origin and `http://localhost:5173` are echoed with `vary: origin`.
    Foreign, missing, or look-alike origins (the same list as the quotes test) → 403 and
    **0 upstream calls**.
12. OPTIONS → 2xx, `allow-methods: GET`, no upstream call. POST/PUT/DELETE → 405 with CORS.
13. Validation → 400 with the exact body, and 0 upstream calls, for each of:
    - missing `symbol`
    - `symbol=^GSPC`
    - `symbol=TOOLONGX`
    - `symbol=AAPL,MSFT`
    - missing `range`
    - `range=1d` (case)
    - `range=10Y`
    - `range=`

    Extra `start`/`end` params are **ignored**: the upstream URL equals `barsUrl(…)`.
14. Upstream request: the URL is exactly `barsUrl(sym, range, now)`, the `user-agent` is
    `BROWSER_UA`, and the `signal` is present.
15. `BRK-B` / `brk_b` → the upstream path uses `BRK.B` and `s:"BRK.B"`. Both share one cache
    entry.
16. Success shape: `s, r, i, asOf, t, c, v`, with parallel lengths and `cache-control:
    max-age=60` for 1D, 300 for 1W, 3600 for 1M, 21600 for ALL.
17. TTL per range: a hit at TTL−1 ms makes no new call. At TTL+1 ms there is exactly one new
    call. Check this for 1D (60 s) and 1Y (1 h). 1D and 1Y for the same symbol are
    independent keys.
18. Coalescing: two concurrent requests for the same `SYM|RANGE` make **one** upstream call
    and get identical bodies. The same symbol with different ranges makes two calls.
19. Negative cache: an `ERROR` body → 404 `{"error":"no data"}`. A repeat within 1 h makes no
    upstream call. After 1 h, one call. It does **not** trip the failure memory: another
    symbol fetches normally immediately.
20. Failure memory:
    - Upstream 403, 500, a non-JSON body, or a reshaped envelope → 502.
    - Within the next 30 s, a miss for a **different** symbol → 502 with 0 upstream calls.
    - A cached hit is still 200.
    - At 30 s + 1 ms, a call is made again.
    - The memory is independent of `/quotes`: a CNBC quotes failure does not block `/bars`,
      and the reverse also holds.
21. Timeout: an upstream fetch that never resolves (honours `signal` abort) → 502, and the
    `inflight` key is cleared, so the next request after the failure window fetches again.
    Use a fake signal or a short timeout to keep this test fast. Expose the timeout constant,
    or stub `AbortSignal.timeout`.
22. The handler never throws: every path returns a Response with CORS headers, except the
    403. An uncaught throw on Cloudflare becomes a 500 with no CORS, which the client sees as
    an opaque failure.

### `ci/test-worker-bars-cache-bound.mjs` (byte bound, mirrors `test-worker-cache-bound.mjs`)
23. Filling the cache with synthetic 1D/ALL bodies past 8 MB keeps the total ≤ 8 MB, and the
    **oldest** entries are evicted first: an old key goes back upstream, while a recent key
    is still a hit.
24. Exactly at the bound nothing is evicted. One byte over evicts at least one entry.
25. Eviction by a concurrent request does not blank an in-flight request's answer. Use the
    same gate trick as `test-worker-cache-bound.mjs`'s "concurrent" case.
26. A re-insert of an existing key replaces its bytes rather than double-counting them:
    the total stays constant across 100 refreshes of the same key.
27. Negative (404) entries count toward the bytes.

### Regression
28. The existing `ci/test-worker-quotes.mjs`, `test-cnbc-worker.mjs`,
    `test-worker-cache-bound.mjs` and `test-worker-relay.mjs` pass unchanged, so the shared
    routing block did not change `/quotes` or `/live` behaviour.

### Manual check after `cd worker && npx wrangler deploy`
(Hand deploy, only with Nitzan's go-ahead.)
- `curl -H "origin: https://nitzan-massad.github.io" "$W/bars?symbol=AAPL&range=1D"` →
  78 bars or fewer, all 09:30–15:55 of one date. Repeat within 60 s and confirm no new
  upstream call in `wrangler tail`.
- `range=5Y` → Monday stamps. `range=YTD` → the first stamp is in last December.
- `symbol=ZZZZQX` → 404.
- No origin → 403.
