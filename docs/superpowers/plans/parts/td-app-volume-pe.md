# Part: Twelve Data removal — Volume stat, P/E history, env/build (everything except drawing the range chart)

Branch `feat/cnbc-quotes`. Planning only. Probes run 2026-10-22 ~13:00 ET (in session) with the
browser UA from `worker/cnbc.js` `BROWSER_UA`.

## Inventory — every TD touch point outside the range chart

| # | Where | What it does today |
|---|---|---|
| A | `MarketPulse/src/components/StockModal.tsx:26` | `TWELVEDATA_KEY = import.meta.env.VITE_TWELVEDATA_KEY` |
| B | `MarketPulse/src/components/StockModal.tsx:100,350,880,1316-1319` | `Series.volume` = last bar's volume → "Volume" stat (`todayVol`) |
| C | `MarketPulse/src/components/StockModal.tsx:780-786,1519-1520` | `peLiveOk` / `canPe` / `loadPeSeries = fetchSeries(stock.t, "5Y")` → `<PeHistory loadSeries>` |
| D | `MarketPulse/src/components/PeHistory.tsx:28-31,66-79` | static `public/pe/<T>.json` first; off-universe → `loadSeries()` + `peSeries()` live |
| E | `MarketPulse/src/peHistory.ts:1-4,81-91,183-186` | comments + **Monday-stamp assumption** in `closeAt` and `peSeries` (`+4 days = Friday`) |
| F | `MarketPulse/ci/scrape-pe.mjs:6-8,24,37-38,45-68` | CI backfill of 5Y weekly closes from TD (`interval=1week&outputsize=262`), once per ticker, `DailyLimit` handling, `thisMonday` stamp |
| G | `MarketPulse/ci/track-requests.mjs:105-106` | comment only ("its one Twelve Data call") |
| H | `MarketPulse/src/vite-env.d.ts:5` | `VITE_TWELVEDATA_KEY?: string` |
| I | `MarketPulse/.github/workflows/site.yml:126-132` (P/E step env + comment), `:234` (Build `VITE_TWELVEDATA_KEY`) | secrets → CI + bundle |
| J | `MarketPulse/.github/workflows/track-requests.yml:69,78-79` | `TWELVEDATA_KEY` / `TWELVEDATA_CI_KEY` to scrape-pe |
| K | `MarketPulse/src/chartSession.ts:4,20` | comments mention TwelveData (chart part owns the code; just reword) |
| L | Docs: `MarketPulse/CLAUDE.md` (keys + "chart bars from Twelve Data"), `MarketPulse/ci/README.md:19,817-819` | prose |
| M | `.env.local` lines 5-6 (`VITE_TWELVEDATA_KEY`, `TWELVEDATA_CI_KEY`) | local only, gitignored — tell the user to delete; don't touch |

`fetchSeries` / `RANGE_CFG` / `Bar` themselves (`StockModal.tsx:41-53,309-354`) belong to the
range-chart part. This part only needs the contracts listed under "Coordination".

---

## 1. Modal "Volume" stat

### Current behaviour — it's wrong on the default view
`todayVol = series?.volume` (`StockModal.tsx:880`), and `series.volume` = the **last bar** of the
*selected range* (`:350`). So "Volume" means:

| range | TD bar | what "Volume" shows |
|---|---|---|
| **1D (default)** | 5min | **one 5-minute bar** (e.g. ~0.14M for AAPL, when the day is ~16M) |
| 1W | 30min | one 30-minute bar |
| 1M–2Y | 1day | today's partial day — roughly right |
| 5Y | 1week | the whole week |
| ALL | 1month | the whole month |

The number also changes when you switch tabs, and the skeleton is tied to `seriesLoading`, not the
quote. Measured with CNBC 5M bars today: last 5M bar volume 140,628, while CNBC's quote said
`"volume": "16,200,933"`. That's two orders of magnitude off on the default tab. It's a bug today,
not something the migration introduces.

### CNBC replacement
Day volume from the **CNBC quote row** the modal already fetches (`fetchCnbc` → Worker `/quotes`),
not from any bar series:
- Raw field `volume` is a comma string. In session: `"16,200,933"`, `last_time` today. Pre-market
  fixture (`ci/fixtures/cnbc-quotes.json`): AAPL `"31,018,583"` with `last_time` = the prior day,
  so off-hours it holds the last session's total. That's what Apple Stocks shows too. Halted/dead
  names give `"0"` (GETY, SQNS in the fixture).
- `volume_alt` ("16.2M") is redundant. `toScaled` already parses the comma form.
- Finnhub fallback: there is none. Finnhub `/quote` has no volume. When CNBC has no quote, or the
  quote is stale (frozen previous day), show `—`.

### Plan steps
1. `worker/cnbc.js` `parseQuote`: add `vol: posOrNull(toScaled(row.volume))`, mapping 0 or less to
   null. Put it next to `vol10`, and add a header-comment line saying `vol` is the session's day
   volume (off-hours: the last session's).
2. `src/quotes.ts`: add `vol: number | null` to `CnbcQuote`. In `mergeModal`, add
   `v: lq?.vol ?? null` to the returned `quote`. It goes in the live half on purpose: a stale CNBC
   quote yields null, not yesterday's number labelled as today's. Add `v: number | null` to
   `FhQuote` (Finnhub's own `fq` never sets it).
3. `StockModal.tsx`:
   - add `v` to `interface Quote` (`:56-62`) and wherever `fq` is built (`:~270`), with `v: null`
   - set `todayVol = quote?.v ?? null`
   - change the Volume cell's skeleton from `seriesLoading` to `qmLoading && !quote`, the same as
     Open/High/Low
   - remove `volume` from `Series` (`:100,350`). Tell the chart part, so its new `Series` doesn't
     carry it.
4. Deploy the Worker by hand (`cd worker && npx wrangler deploy`) **before or with** the site.
   Order doesn't matter: an old Worker sends no `vol`, `undefined ?? null` gives `—`, and nothing
   breaks.

### Tests
- `ci/test-cnbc-worker.mjs`:
  - `parseQuote(R.AAPL).vol === 31018583` (off-hours fixture)
  - session fixture AAPL is `1717420`
  - GETY `"0"` gives null
  - a row with no `volume` key gives null
- `src/quotes.check.ts`:
  - extend the `Q()` helper with `vol: 2.5e6`
  - `mergeModal(Q(), …).quote.v === 2.5e6`
  - `mergeModal(Q(), FQ, …, true).quote.v === null` (stale)
  - `mergeModal(null, FQ, …).quote.v === null`

### Risks
- CNBC quote volume and CNBC bar volume don't agree. AAPL 10/21 daily bar = 35.6M, while the
  pre-market quote says 31.0M for that day. Midday, the sum of regular-session 5M bars was 12.5M vs
  the quote's 16.2M. The quote field is what cnbc.com displays as "Volume", so it's the defensible
  choice. Neither will match Finnhub's 3M average exactly. The ±15% difference is fine for a
  "read against Avg Vol 3M" glance.
- The Worker caches for 20s and the modal's live cache expires after 1 min, so volume refreshes no
  faster than price. That's fine.

---

## 2. P/E history overlay

### Current behaviour
- **Ranked/pinned tickers (`covered`)** never call TD from the browser:
  - `PeHistory.loadStatic` reads `public/pe/<T>.json` (or `trackedPayload(t,"pe")`)
  - `peState` comes from `public/pe/_asOf.json`: `ok` → chart; missing / `err` / `wait` →
    "updating" (`pending`); `ok:false` → no button (`StockModal.tsx:601-611,784`)
  - The files are built by `ci/scrape-pe.mjs`:
    - 5Y weekly closes from **TD once per ticker**, cached in committed `ci/cache/pe/<T>.json`
    - every later run writes this week's close from `stocks.json` `px` into the Monday-stamped
      bar
  - Index today: 231 ok, 269 not ok. 57 cache files have **no closes yet** (KAPA, USGO, ATCX…),
    waiting on TD quota.
- **Off-universe tickers** (`!covered`) are gated by `peLiveOk`: at least 4 Finnhub EPS or peTTM
  quarters. They compute live:
  - `loadPeSeries = fetchSeries(stock.t,"5Y")`: TD `1week` × 260 with the browser's key, which
    burns the shared 800/day quota
  - then `peSeries(stamps, closes, eps, peq)` with no SEC report dates

### CNBC facts verified (1W bars, `…/bars/{SYM}/1W/{start}/{end}/adjusted|unadjusted/EST5EDT.json`)
- Start `20210101000000` returns 304 weekly bars (AAPL, BAC, TSM, ORLY, CTVA, BRK.B), so 5Y+ is
  available in one call with no key.
  - `Access-Control-Allow-Origin: *`, so a browser can call it directly; its own UA passes.
  - curl's default UA gets 403. Node/CI must send `BROWSER_UA`.
- **Weekly bars are stamped SUNDAY** (`tradeTime "20201227000000"`), not Monday like TD. The
  current week's partial bar is included (`20261018` = this week, close = latest price).
- **Closes match TD after a Sunday → +1 day shift.** Compared against the committed TD cache over
  all 262 common weeks:
  - AAPL: 1 mismatch above 0.5%
  - BAC: 1 mismatch above 0.5%
  - TSM, ORLY: 0
  - The single miss is the Good-Friday week 2023-04-03 (CNBC 163.76 vs TD 164.66; ~0.5%,
    harmless).
  - Neither source is dividend-adjusted (AAPL 2020-12-31 close 132.69 = actual).
- **`adjusted` also back-adjusts SPIN-OFFS; TD did not.** CTVA: 259/262 weeks differ.
  `unadjusted/adjusted` factor is exactly 15.0 for ORLY before its 2025-06 split and 10.0 for NVDA
  before 2024-06 (splits), but **6.665** for CTVA before 2026-09-27 (spin-off). Finnhub's EPS is not
  spin-adjusted, so CTVA on raw `adjusted` closes would chart pre-spin P/E ~6.7× too low, and the
  existing "price halves in a week" guard (`peHistory.ts` `brokenAt`) never fires because the
  adjusted series has no jump. `unadjusted` alone is wrong too (not split-adjusted; ORLY jumps 15×).

### Plan steps
1. **`src/peHistory.ts`: make the weekly math weekday-agnostic** (it's the root cause, and it's
   shared with CI):
   - add an exported `weekFriday(stamp: string): string` giving the Friday of the stamp's week:
     Sunday +5, Monday +4, and so on (`(5 - dow + 7) % 7`)
   - use it in `closeAt` (replace `days(d, stamp) - 4`) and in `peSeries` (replace the `+ 4 * DAY`
     `fri`)
   - update the header and the `closeAt` doc comment to say "weekly bars (any start-of-week
     stamp)" and drop "Twelve Data"
   - Monday-stamped data (all 500 committed caches) behaves exactly as now
2. **`src/peHistory.ts`: add a pure `splitOnlyCloses(adj: number[], unadj: number[]): number[]`**,
   which rebuilds TD's basis (split-adjusted, NOT spin-adjusted):
   - walk the bars newest to oldest; `f = unadj/adj`
   - when `f` steps by more than 1%, compare the step ratio to `SPLIT_FACTORS` and their inverses
     (reverse splits), within 1%
   - a split keeps the adjusted value
   - any other step (spin-off, special dividend) multiplies every older close by that step, which
     undoes it
   - result: CTVA comes back to 78.52 → 11.78 (TD's shape), and `brokenAt` handles the spin as it
     does today
3. **New pure module `src/cnbcBars.ts`** (shared with the chart part; agree who creates it):
   - `barsUrl(sym, int, start, end, adj)`: uses `normSym`, so BRK-B becomes BRK.B
   - `parseBars(json)`: `{t: yyyy-MM-dd[THH:mm], o,h,l,c: parseFloat, v}`, oldest-first, NaN
     closes dropped, `throw` when `barData.priceBars` is missing or empty
   - `ymdhms(date)`
   - Keep it free of `import.meta` so a `.check.ts` and `ci/` (Node type stripping) can both import
     it, the way `scrape-pe.mjs` imports `peHistory.ts`.
4. **`StockModal.tsx` live fallback:** replace `loadPeSeries` with a P/E-specific loader:
   - fetch `1W` adjusted and unadjusted (start = today − 5Y − 3 weeks) in parallel
   - return `{ stamps, closes: splitOnlyCloses(adj, unadj) }`, cached per ticker in a module Map
   - drop the "share the chart's 5Y cache" coupling: the chart's 5Y series stays `adjusted`, which
     is right for a *price* chart
   - whether it goes direct to `ts-api.cnbc.com` or through a Worker `/bars` proxy is the chart
     part's call; this loader just uses the same helper
   - `peLiveOk` stays as is (it's an EPS-availability gate)
   - rewrite the comment at `:780-782`: CI-owned files remain the path for ranked tickers, because
     they carry SEC report dates and keep the browser from doing 3 calls, not because of quota
5. **`PeHistory.tsx`:** only the `loadSeries` prop doc changes (it's no longer "the price chart's
   own"). No logic change.
6. **`ci/scrape-pe.mjs`** (TD's last CI consumer; coordinate if a CI part exists):
   - replace `weekly(t)` with two CNBC `1W` calls (adjusted + unadjusted, `User-Agent: BROWSER_UA`,
     20s timeout)
   - map each Sunday stamp **+1 day to Monday**, so new rows slot beside the 500 TD-era
     Monday-stamped caches, `thisMonday`'s px-overwrite keeps working, and `.slice(-262)` stays
     right
   - closes come from `splitOnlyCloses`
   - drop the current partial week (`thisMonday` gets `px` anyway)
   - remove:
     - the `TD` const
     - `TD_GAP_MS` (use a polite ~500ms gap)
     - `DailyLimit`
     - `stopTd` / `tdCalls`. Rename to `pxCalls`, or keep the name with a CNBC log line.
   - the `if (hasEarnings && !c.closes?.length && TD && !stopTd)` gate loses `TD && !stopTd`
   - **Do not re-backfill existing caches:** they're TD-basis and verified equal. The 57 cache
     files with no closes fill on their next rotation (no more daily cap); `wait` entries clear by
     themselves.
   - Optional one-off: `ALL=1` locally. Not needed.
   - header comment: "CNBC, once per ticker (free, but undocumented: don't poll)"
7. **`ci/track-requests.mjs:106`:** comment becomes "without re-fetching its CNBC closes".
   **`ci/README.md:817-819`:** closes now come from CNBC (adjusted + unadjusted → split-only), the
   Sunday→Monday shift, and that the TD-era caches are kept.

### Tests
- `src/peHistory.check.ts` (it compiles via `npm test`):
  - `weekFriday("2025-03-30")` (Sun) and `weekFriday("2025-03-31")` (Mon) both give `"2025-04-04"`
  - `closeAt` with Sunday stamps `["2025-03-23","2025-03-30"]` gives the same answers as the
    existing Monday cases (`:86-88`)
  - `peSeries` on a small fixture gives the same output for Sunday-stamped and Monday-stamped
    copies (deep-eq on `v`)
  - `splitOnlyCloses`, with real numbers from the probes:
    - ORLY-shaped (factor 15 → 1): output equals `adj`
    - CTVA-shaped (6.665 → 1): output equals `unadj` before the step, `adj` after
    - mixed (split, then a spin later)
    - reverse split (0.1)
    - flat factor 1 (AAPL): identity
    - a missing-week misalignment throws or returns `adj`; pick one and assert it
- New `src/cnbcBars.check.ts`, or extend the chart part's version, with a trimmed real 1W fixture:
  - Sunday `tradeTime` parsed to `2020-12-27`
  - oldest-first order
  - string-to-number OHLC
  - `volume` number passthrough
  - an empty `priceBars` throws
  - `normSym` in the URL (`BRK-B` → `BRK.B`)
- `ci/test-pe-files.mjs` already gates the written files (`ok` ⇔ file, ordering, positive values).
  No change; it guards the scrape-pe edit.
- Add a `ci/test-scrape-pe-weekly.mjs`, or fold the parse into a pure export: CNBC 1W fixture →
  `[["2020-12-28", 132.69], …]` (Monday-shifted) and no current-week row.

### Risks
- **Undocumented endpoint.** It can reshape or start rejecting at any time. Failure modes:
  - live fallback: an error shows "no P/E history"
  - CI: the ticker's `err` gets backoff; existing files keep regenerating from cache
  - No silent wrong data, as long as `parseBars` throws on a reshaped envelope.
- **Spin/special-dividend detection** relies on adjusted and unadjusted bars aligning on
  `tradeTime`. Assert equal lengths and stamps; otherwise fall back to `adj`, with a `ponytail:`
  note naming the CTVA case.
- **A holiday-week close** can differ from TD by about 0.5% (Good Friday 2023). Cosmetic.
- **CI on GitHub runners** sends a browser UA from Azure IPs. Not probed from Actions. If CNBC
  blocks datacenter IPs, the fallback is routing CI through the Worker `/bars` (if the chart part
  builds one). Verify with one `ONLY=KAPA node ci/scrape-pe.mjs` run in a workflow_dispatch before
  relying on it.
- The new Sunday stamps must never reach `ci/cache/pe` unshifted. A mixed cache would carry two
  rows per week. The scrape test above guards that.

---

## 3. Env, types, build

### Steps (after parts 1–2 and the chart part land, so nothing reads the key)
1. `src/components/StockModal.tsx:26`: delete `TWELVEDATA_KEY` (and the `"no twelvedata key"`
   throw, which goes with the chart part's `fetchSeries` rewrite).
2. `src/vite-env.d.ts:5`: delete `VITE_TWELVEDATA_KEY`. `tsc` then flags any leftover reader.
   That's the completeness check.
3. `.github/workflows/site.yml`:
   - `:234`: delete `VITE_TWELVEDATA_KEY` from Build
   - `:126-132`: remove `TWELVEDATA_KEY` / `TWELVEDATA_CI_KEY` from "Refresh P/E history" and
     reword the comment (CNBC once per ticker; the LIMIT note becomes "Finnhub-paced")
4. `.github/workflows/track-requests.yml:69,78-79`: same removal and reword.
5. `CLAUDE.md`:
   - Keys: drop `VITE_TWELVEDATA_KEY` / `TWELVEDATA_KEY`
   - "chart bars from Twelve Data" becomes "chart bars from CNBC"
   - "3-month volume stay Finnhub" stays true; day volume is now CNBC
   - `ci/README.md:19`: drop TwelveData from the build-keys list
6. `src/chartSession.ts:4,20`: comment rewording only (chart part).
7. **After merge and a green deploy** (the user does this; not part of the code change):
   - delete the repo secrets `TWELVEDATA_KEY` and `TWELVEDATA_CI_KEY`
   - delete lines 5-6 of the local `.env.local`
   - optionally revoke the TD key, which is currently baked into every deployed bundle as
     `VITE_…`

### Tests and verification
- `npx tsc --noEmit` passes after the type is removed. That proves no reader is left.
- `grep -rniE "twelve ?data|TWELVEDATA|api\.twelvedata" src ci worker .github CLAUDE.md` must
  return nothing. (`docs/superpowers/plans/` is excluded on purpose.)
- `npm run build`, then `grep -c twelvedata dist/assets/*.js` gives 0.
- `npm test` passes: the full suite, including `quotes.check`, `peHistory.check`,
  `test-cnbc-worker`, `test-pe-files`.
- Manual, `npm run dev` on Node 22:
  - AAPL modal on 1D: Volume ≈ CNBC page volume, and stays the same when switching 1D/1W/5Y
  - TSM P/E history (covered: static file)
  - an off-universe ticker with EPS: live CNBC path, and the network tab shows no
    `api.twelvedata.com`
  - CTVA-like spin: P/E line blanks at the spin instead of a 6.7× pre-spin drop

### Risks
- Removing the workflow env before `scrape-pe.mjs` stops reading `TWELVEDATA_*` doesn't fail
  anything: `TD` was `""`, and the gate just skipped backfills. Even so, ship the env removal in
  the same commit as the scrape-pe change.
- Workflow edits go through git only (`AGENTS.md`); pushing to `main` deploys.

## Coordination with the range-chart part
- Agree one shared pure `src/cnbcBars.ts` (URL builder + `parseBars`). The chart owns 5M/30M/1D/1MO
  use; P/E uses 1W adjusted and unadjusted.
- New `Series` has **no `volume`** (Volume comes from the quote).
- Chart 5Y stays `adjusted`, so the P/E loader no longer shares the chart's 5Y cache entry.
- If the chart part routes bars through a Worker `/bars` proxy, the P/E loader and (if Actions IPs
  are blocked) `ci/scrape-pe.mjs` should use it too.
