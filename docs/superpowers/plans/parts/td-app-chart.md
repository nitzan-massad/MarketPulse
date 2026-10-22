# Part: client chart — Twelve Data → CNBC bars (src/components/StockModal.tsx)

Scope: the stock modal's price chart (every range), the P/E-history overlay's live 5Y fallback
(`loadPeSeries`), and the Volume cell that currently reads off the chart series. The Worker
`/bars` endpoint is the worker part's design; this part only states what the client expects of it.

## 0. Probe facts (curl, 2026-10-22 ~13:00 ET, Thursday, market open)

| Probe | Result | Consequence for the client |
|---|---|---|
| `AAPL/5M` today | 108 bars, 04:00 → 12:55 (in-progress bar present at 12:59) | 1D must filter to regular hours |
| `AAPL/5M` yesterday | 192 bars 04:00 → 19:55; **78** regular (09:30 → 15:55) | regular filter = bar-start minute ∈ [570, 960) — same 78 bars TD gave |
| `AAPL/30M` 7 days | 13 regular bars per full day, 09:30-aligned | same filter works for 1W |
| `AAPL/1D` YTD | last bar **2026-10-21** (yesterday); no today bar | daily ranges need today appended from the quote |
| `AAPL/1W` 5y | stamped **Sunday** (`20261018…`); latest = current week, close = yesterday's | shift stamps +1 day to Monday (peHistory `closeAt` assumes Monday); patch last close live |
| `AAPL/1MO` all | `YYYYMM01`, since 1980; latest = current month, close = yesterday's; one bar has `open "0.0000"` | use closes only; drop closes ≤ 0 |
| `ATCX/5M` 3 days | 41 bars, gaps where no trades; 39 regular | sessionSlice's minute-positioned x already handles gaps |
| `BRK.B/1D` | works with the dot form | request with `normSym(t)` |
| unknown `ZZZZQ` | HTTP **200** `{"status":"ERROR",…}` and no `barData` | worker must map to non-200 / `{error}`; client treats as unavailable |
| Sunday window | 200, `priceBars: []` | empty → unavailable (for 1D, the window must reach back to the last session) |
| 5M volumes | regular-hours sum 18.4M vs daily bar 35.6M; 16:00 bar 117.7M (closing auction) | intraday volumes are **not** a usable "today's volume"; CNBC quote `volume` is (16.27M at 13:01) |

`tradeTime` is already US-Eastern wall clock (`EST5EDT` in the URL) — use it and **never**
`tradeTimeinMills` (daily mills are local midnight; wall-clock strings sidestep DST entirely).

## 1. Worker contract this part assumes (reconcile with the worker part)

`GET {WORKER_URL}/bars?symbol=<normSym>&range=<RangeId>` →
`200 { bars: [{ t: "yyyyMMddHHmmss", c: number, v: number }, …] }`, oldest-first, ET, **ext-hours
NOT filtered** (filtering is client-side so it is unit-checked). Any failure (CNBC `status:"ERROR"`,
timeout, bad symbol) → non-200 or `{ error }`. Window per range, worker-side:

| range | CNBC interval | start (ET) |
|---|---|---|
| 1D | 5M | today − 5 calendar days 00:00 (covers weekend + a Monday holiday, so pre-market / weekend still has the last session AND its predecessor for the baseline) |
| 1W | 30M | today − 7 days |
| 1M / 3M / 6M / 1Y / 2Y | 1D | today − 1/3/6/12/24 months |
| YTD | 1D | Jan 1 this year (TD's "200 bars" was never really YTD) |
| 5Y | 1W | today − 5 years |
| ALL | 1MO | 19700101 |

End = today 23:59:59 for all. If the worker part prefers ISO `t`, `toStamp` below accepts both
(one regex), so the two parts need not land in lockstep.

## 2. New pure module `src/chartBars.ts` (+ `src/chartBars.check.ts`)

Dependency-free, no `import.meta` (the check compiles to CommonJS). Header comment carries the
`npx tsc src/chartBars.ts src/chartBars.check.ts --outDir /tmp/cb --module commonjs --target es2020 --lib es2020,dom --skipLibCheck && node /tmp/cb/chartBars.check.js` line, like `chartSession.check.ts`.

```ts
export type BarKind = "intraday" | "day" | "week" | "month";
export interface Bar { t: string; c: number; v: number } // t: "YYYY-MM-DD HH:MM" | "YYYY-MM-DD"

/** "20261022093000" (or "2026-10-22T09:30…") -> "2026-10-22 09:30" for intraday, "2026-10-22"
 *  otherwise; week stamps shift CNBC's Sunday to Monday (peHistory.closeAt's contract). null if unparseable. */
export function toStamp(raw: string, kind: BarKind): string | null;

/** Worker body -> clean oldest-first bars: drops non-finite / <= 0 closes and unparseable
 *  stamps, de-dupes equal stamps (last wins), sorts ascending. Throws nothing; [] on junk. */
export function parseBars(body: unknown, kind: BarKind): Bar[];

/** Regular session only: bar-start minute in [SESSION_OPEN, SESSION_CLOSE). Intraday only. */
export function regularOnly(bars: Bar[]): Bar[];

/** Daily-type series + today's live price: day -> append {day, px} when day > last date;
 *  week -> replace last close if day falls in [lastMonday, +6], else append Monday-of(day);
 *  month -> replace if same YYYY-MM, else append YYYY-MM-01. intraday / live null -> unchanged.
 *  Returns NEW arrays (the cached series is never mutated). */
export function withLive(stamps: string[], closes: number[], live: { day: string; px: number } | null, kind: BarKind): { stamps: string[]; closes: number[] };

/** 1D dashed baseline: quote prev-close when the quote is FOR the plotted session
 *  (quoteDay === sessionDate); else the previous session's last regular close from the same
 *  bars (5M 15:55 close ≈ official close); else the session's first close. */
export function sessionBase(sessionDate: string, stamps: string[], closes: number[], quoteDay: string | null, pc: number | null): number;
```

Import `SESSION_OPEN` / `SESSION_CLOSE` from `./chartSession` (pure, already CommonJS-safe).

### `chartBars.check.ts` cases (each an `eq`, real fixtures cut from the probes above)
- `toStamp("20261022093000","intraday")` → `"2026-10-22 09:30"`; `"day"` → `"2026-10-22"`.
- `toStamp("20261018000000","week")` → `"2026-10-19"` (Sun→Mon); month-boundary Sunday `"20260531000000"` → `"2026-06-01"`; year boundary `"20261227…"` → `"2026-12-28"`.
- `toStamp("2026-10-22T09:30:00","intraday")` → `"2026-10-22 09:30"` (ISO accepted); `toStamp("garbage","day")` → `null`.
- `parseBars` on a CNBC-shaped body with string closes `"344.40"` → numbers; a `c:"0.0000"` / `"NaN"` row dropped; out-of-order input sorted; duplicate stamp de-duped; `parseBars(null)` / `{error:"x"}` / `{bars:"x"}` → `[]`.
- `regularOnly`: 04:00, 09:25 dropped; 09:30 kept; 15:55 kept; 16:00 (closing-auction bar) dropped; 19:55 dropped. Yesterday's 192-bar AAPL shape → 78 (use a generated 04:00–19:55 5-minute ladder).
- `withLive` day: last `2026-10-21` + live `2026-10-22` → appended; live `2026-10-21` (pre-market / weekend: quote day = last bar) → unchanged; live null → unchanged; input arrays not mutated.
- `withLive` week: last `2026-10-19` + live `2026-10-22` → last close replaced, length same; live `2026-10-26` (Monday, new week, no bar yet) → appended `2026-10-26`.
- `withLive` month: last `2026-10-01` + live `2026-10-22` → replaced; live `2026-11-02` → appended `2026-11-01`.
- `withLive` intraday → unchanged.
- `sessionBase`: quoteDay === session → pc; quoteDay = earlier day (CNBC hasn't rolled at 09:30) → previous session's last regular close; no previous session in bars and no pc → first close.

### `chartSession.ts` changes (+ check edits)
- `sessionSlice` (chartSession.ts:30): guard `closes.length < 2` → `< 1`, and `keep.length < 2` → `< 1`.
  Reason: 09:30–09:35 has ONE regular bar today; today returns null and the chart falls back to the
  plain index chart over 5 days of bars. One point draws the dot + an empty line, which is right.
- Add `date: string` (the kept session's `YYYY-MM-DD`) to `SessionSlice` (chartSession.ts:11) so
  `buildChart` can call `sessionBase`.
- Comments at chartSession.ts:4-7 and :20 say TwelveData → reword to "the 1D feed (CNBC 5M bars,
  filtered to regular hours) spans several sessions".
- chartSession.check.ts:46 `"too few bars -> null"` becomes `sessionSlice([], [], NOON)` → null; add
  `"single opening bar today is live"`: `sessionSlice([5], ["2026-07-25 09:30"], {date:"2026-07-25",min:571})` → `{closes:[5], live:true, lastMin:570, date:"2026-07-25"}`; add `date` asserts to the existing first case.

## 3. StockModal.tsx edits, top to bottom

1. **:26** delete `TWELVEDATA_KEY`. **:3** add import `{ type BarKind, parseBars, regularOnly, sessionBase, withLive } from "../chartBars"`.
2. **:41-53** `RANGE_CFG` → `Record<RangeId, { kind: BarKind; ttl: number }>`:
   1D/1W `{kind:"intraday", ttl:60_000}`; 1M…2Y `{kind:"day", ttl:3_600_000}`; 5Y `{kind:"week", …}`; ALL `{kind:"month", …}`.
   Comment: "range -> bar kind + cache life; the window per range lives in the Worker".
   (TTL: TD's cache was page-life to save quota; CNBC via the Worker has none, and a page left open
   past the session otherwise shows a frozen 1D forever.)
3. **:85-101** delete `interface Bar` (o/h/l never read; `Bar` now comes from chartBars). `Series` → `{ closes; stamps }` only:
   `hi`/`lo` are never read, `last` is just `closes.at(-1)`, and `volume` moves to the quote (step 9).
4. **:131** `seriesCache` → `Map<string, { s: Series; at: number }>`.
5. **:309-354** `fetchSeries` rewrite (≈20 lines):
   ```ts
   async function fetchSeries(ticker: string, range: RangeId): Promise<Series> {
     const sym = normSym(ticker);
     if (!sym) throw new Error("not a US ticker");
     const key = `${sym}|${range}`;
     const { kind, ttl } = RANGE_CFG[range];
     const hit = seriesCache.get(key);
     if (hit && Date.now() - hit.at < ttl) return hit.s;
     const r = await fetch(`${WORKER_URL}/bars?symbol=${encodeURIComponent(sym)}&range=${range}`,
       { signal: AbortSignal.timeout(10_000) });
     if (!r.ok) throw new Error(`bars ${r.status}`);
     let bars = parseBars(await r.json(), kind);
     if (kind === "intraday") bars = regularOnly(bars);
     if (!bars.length) throw new Error("no bars");
     const s = { closes: bars.map((b) => b.c), stamps: bars.map((b) => b.t) };
     seriesCache.set(key, { s, at: Date.now() });
     return s;
   }
   ```
   Failures are never cached (as today), so the next open retries.
6. **:124 / :298-306 / :577 / :676** expose the CNBC "today" to the chart: `QuoteMetric` gains
   `live: { day: string; px: number } | null` = `!stale && cq?.day ? { day: cq.day, px: cq.px } : null`
   (`stale` is already computed at :287). New state `const [live, setLive] = useState<QuoteMetric["live"]>(null)` beside `ext`; `setLive(r.live)` beside `setExt(r.ext)`.
   ponytail: when Finnhub priced the quote (CNBC missing/stale) there is no day, so daily ranges simply end at yesterday — Finnhub's `t` could supply it if that ever matters.
7. **:418-503** `buildChart(closes, stamps, intraday, opts)`: add `quoteDay?: string | null` to `opts`;
   **:431** `base = sessionBase(slice.date, stamps, closes, opts.quoteDay ?? null, opts.prevClose ?? null)`
   — `stamps`/`closes` here are the full filtered 1D arrays, which still hold the previous session. Nothing else in `buildChart` changes: stamps keep the `"YYYY-MM-DD HH:MM"` / `"YYYY-MM-DD"` shape that `fmtStamp`, `fmtScrub`, `fmtStampLong`, `multiYear` and `sessionSlice` parse.
8. **:824-829 + :866-877** one derived view, then chart and % both read it:
   ```ts
   const view = useMemo(() => series ? withLive(series.stamps, series.closes, live, RANGE_CFG[range].kind) : null, [series, live, range]);
   const rangePct = range === "1D" ? dayPct
     : view && view.closes.length > 1 && view.closes[0] ? ((view.closes.at(-1)! - view.closes[0]) / view.closes[0]) * 100 : null;
   const chart = useMemo(() => view && view.closes.length
       ? buildChart(view.closes, view.stamps, RANGE_CFG[range].kind === "intraday", {
           is1D: range === "1D", prevClose: quote?.pc ?? null, quoteDay: live?.day ?? null, now: easternNow() })
       : null, [view, range, quote, live]);
   ```
   (`view` must be declared before `rangePct`, i.e. move the chart memo block up above :824 or put `view` there.)
9. **:880 / :1318** Volume cell: `const todayVol = quote?.vol ?? null` and skeleton on `qmLoading && !quote`
   instead of `seriesLoading`. Needs `vol` on `CnbcQuote` (worker `parseQuote` + `quotes.ts:8` + `mergeModal` →
   `quote.vol = pick(lq?.vol, fq?.v?)`; Finnhub `/quote` has no volume, so `lq?.vol ?? null`) — **cross-part
   dependency** on the quotes/worker part. Without it the cell reads "—" rather than a wrong number:
   CNBC 5M volumes do not sum to the day (18.4M vs 35.6M) and daily bars stop at yesterday. (Today's
   code shows the last 5-minute bar's volume on the default 1D range — already wrong, fixed by this.)
10. **:747-769** fetch effect: unchanged (still `active`-gated, `cancelled`-guarded; error → `setSeriesError(true)` → "chart unavailable" at :1094). Comment at :747 says "default 1M" — fix to "1D".
11. **:781-786** comment "spend the Twelve Data quota every visitor shares" → "would make every visitor
    compute it live"; `loadPeSeries` stays `fetchSeries(stock.t, "5Y")` and now gets Monday-stamped
    CNBC weekly closes **without** the live patch (raw cache), which is what `peSeries` wants.
12. Neighbours / `active`: no change. Neighbours never fetch bars; they show the "loading…" skeleton
    until landed on, exactly as now. `loadingUncovered` / `noData` (:906-908) keep keying on `seriesLoading`/`chartAvailable`.

## 4. Behaviour by clock (1D)

| ET clock | bars after `regularOnly` | slice = | live / shading | baseline |
|---|---|---|---|---|
| Weekday 04:00–09:30 (pre) | latest regular date = yesterday | yesterday 9:30–16:00 | `CLOSED`, no shade (lastDate ≠ now.date) | CNBC quote still `day = yesterday`, `pc` = day-before → `sessionBase` takes pc ✔ |
| 09:30–09:35 | 1 bar today | today, 1 point (needs §2 guard change) | `LIVE`, shade 09:30→16:00 | quote day = today → pc; if CNBC not yet rolled → yesterday's last 5M close |
| 09:35–16:00 | today's bars | today | `LIVE · H:MM`, `remaining` = lastX→16:00 | pc |
| 16:00–20:00 (post) | today's 78 | today | `CLOSED` (now.min ≥ 960) | pc (quote px = today's close, pc = yesterday) |
| Night / weekend / weekday holiday | last session (Fri / day before) | that session | `CLOSED` | quote day = that session → pc |

The header %: 1D keeps `dayPct` from the quote (unchanged). The after-hours/pre-market price stays
in the existing `ext` row (not plotted) — CNBC has the bars if a later change wants a dotted ext tail.

Daily ranges: today is never in CNBC's daily bars; `withLive` appends it from the quote only once
CNBC's quote `day` is past the last bar (i.e. the regular session has opened today). Pre-market,
nights and weekends: quote day = last bar → no append, so no phantom bar. 5Y/ALL: the in-progress
week/month bar exists with yesterday's close; `withLive` overwrites its close with the live price.

Timezone: all stamps are ET wall clock strings; the only clocks are `easternNow()` (sessionSlice)
and `etClock()` (stale/live) — both Intl `America/New_York`. No `Date` parsing of bar times anywhere
except `fmtStamp`/`fmtScrub`'s local-parts construction (unchanged, no day shift).

## 5. Empty / thin / error

- Unknown symbol, worker 5xx, timeout (10s), body without `bars`, all bars junk, or 1D with no
  regular bars in 5 days → `fetchSeries` throws → "chart unavailable" (:1094); not cached.
- Thin intraday (ATCX: 12–15 regular bars/day with gaps) → plotted at true minute positions; fine.
- Thin daily (new listing, YTD on Jan 2) → `withLive` may leave 1 point → `buildChart`'s `n === 1`
  branch draws a dot; `rangePct` null → "—". Acceptable, no extra code.
- Off-universe uncovered tickers: unchanged flow; the chart now works without any API key.

## 6. Deletions / docs

- `TWELVEDATA_KEY` (StockModal.tsx:26), the TD URL + newest-first `.reverse()` parsing (:315-339), `Bar`/`Series` dead fields.
- `src/vite-env.d.ts:5` `VITE_TWELVEDATA_KEY` and `.github/workflows/site.yml:234` `VITE_TWELVEDATA_KEY:` — the app no longer reads it. **Keep** `TWELVEDATA_KEY`/`TWELVEDATA_CI_KEY` in site.yml:130-131 and track-requests.yml:78-79: `ci/scrape-pe.mjs` still uses TD (out of this part's scope; its cached Monday-stamped closes stay compatible because the client now also stamps Monday).
- `src/peHistory.ts:3` and `:81` comments: "Twelve Data" → "weekly bars stamped with their Monday (CNBC's Sunday stamp is shifted in chartBars.toStamp; CI's Twelve Data closes are Monday already)".
- CLAUDE.md: "chart bars from Twelve Data" → "chart bars from CNBC via the Worker's `/bars`"; drop `VITE_TWELVEDATA_KEY` from the dev-keys line (CI key stays for scrape-pe); add `chartBars` to the pure-module list.

## 7. Verification

`npm test` (compiles `chartBars.check.ts` + updated `chartSession.check.ts`), `npx tsc --noEmit`,
then `npm run dev` against `wrangler dev` (`VITE_WORKER_URL`) and click every range on AAPL,
BRK.B, ATCX and an off-universe ticker, once in-session and once after 16:00 / on a weekend
(force via a stubbed `easternNow` if needed): 1D LIVE shading + prev-close line, 1M last point =
live price, 5Y/ALL last point = live price, bad symbol → "chart unavailable", P/E overlay for an
off-universe ticker still draws.
