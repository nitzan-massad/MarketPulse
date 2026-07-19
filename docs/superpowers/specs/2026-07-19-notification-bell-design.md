# MarketPulse — Notification Bell (design spec)

Date: 2026-07-19
Status: proposed (awaiting review)

## Goal

A header notification bell that alerts a logged-in user when a stock on their
watchlist moves ≥5% from the price it was at when they added it. Green = up
("I hope you bought this: …"), red = down ("it's time to buy: …"). Notifications
persist per user, show in a scrollable dropdown, carry an unread badge, and
clicking one deep-links to that stock in the Watchlist view.

## Constraints (decided)

- **Computed client-side, only while the app is open.** No backend job / push —
  MarketPulse has none, and adding Firebase Cloud Functions is out of scope.
- **Price source:** live Finnhub price when available, else the bundled snapshot
  price. Live covers only the top ~40 tickers during US market hours
  (`useLiveQuotes.ts`), so most watchlist stocks are evaluated against the
  snapshot (`STOCKS[t].px`), which refreshes on each new build/deploy.
- **Repeat-alert throttling = ratchet off the last alert.** After an alert fires
  for a ticker, its reference price resets to the price at that alert; the next
  alert (either direction) needs another 5% move from there.
- **Persistence** mirrors the existing hooks: Firebase RTDB when signed in with
  Firebase configured, `localStorage` fallback otherwise (dev / unconfigured).

## Chosen UI (from the mockup gallery)

- **Bell:** count pill top-right, caps at `99+` (gallery "Bell 5").
- **Popover:** card-style rows, grouped **Today / Earlier**, soft scroll-fade at
  the bottom edge, title + count header, sticky Clear-all footer (gallery
  "Popover 3 + 4"). No separate "Mark read" control — opening auto-marks read.
- **Row:** two-line — message + ticker on top, **date** (e.g. "Jul 15", not
  relative time) below-left, a large arrow + signed % block on the right
  (gallery "Row 5"). **Small hover animation** (see below).
- **Empty state:** bell medallion + headline + one line of subtext (gallery
  "Empty 1").
- **Clear-all:** trash icon + label, single action, no confirm (gallery
  "Clear-all 3").

Design language is MarketPulse's light "Steel Navy" theme: accent token
`--gold` is navy `#1b3f73`; `--green:#17864f` / `--red:#c73a2b`; fonts Archivo /
JetBrains Mono / Fraunces; icons hand-drawn inline 24×24 `currentColor` strokes.

## Data model

Two new stores; the existing `watchlist` node is left untouched.

### `watchmeta/<uid>/<ticker>` (RTDB) · `mp_watch_meta` (localStorage)

```
{ addPx: number,   // price when the ticker was added (immutable, for display %)
  ref:   number }  // moving reference for the ratchet; starts = addPx
```

### `notifications/<uid>/<id>` (RTDB push id) · `mp_notifs` (localStorage array)

```
{ ticker: string,
  dir:    "up" | "down",   // decides green/red + which message template
  pct:    number,          // signed % vs addPx at fire time (see "displayed %")
  at:     number,          // epoch ms — drives the date shown and Today/Earlier
  read:   boolean }         // flipped true when the bell is opened
```

Message text is **derived at render** from `dir` + `ticker` + `pct` (not stored),
so wording can change without a migration:
- up → `I hope you bought this: <TICKER> (+<pct>%)`
- down → `it's time to buy: <TICKER> (−<pct>%)`

**Clear all** = delete the whole `notifications/<uid>` node (or `mp_notifs`).

## Meta reconciliation (reqs 11 + 12, one code path)

The notifications hook watches the watchlist list and the price map. On every
change:

- For each watched ticker **without** a `watchmeta` entry, if a current price is
  known, create `{ addPx: price, ref: price }`.
  - New add → captures the price at (approximately) add time → **req 11**.
  - Pre-existing watch with no meta → captures "now" as the baseline, so no
    historical alerts fire for past moves → **req 12**.
- If no price is known yet (off-universe ticker, market closed, not top-40 and no
  snapshot), skip until a price appears. No alerts for that ticker meanwhile.
- Removing a ticker from the watchlist leaves its past notifications intact
  (they're history) but **prunes its `watchmeta` entry**, so if it's re-added
  later the reconciler captures a fresh `addPx`/`ref` baseline rather than
  reusing the stale one.

`toggle()` in `useWatchlist` is **not** modified — reconciliation is the single
source of meta creation.

## Alert engine (the ratchet)

Per watched ticker with a known `ref` and a known `current` price:

```
move = (current - ref) / ref
if move >= 0.05:   fire("up",   current)
elif move <= -0.05: fire("down", current)

fire(dir, current):
  pct = round((current - addPx) / addPx * 100)   // cumulative vs add price
  push notification { ticker, dir, pct, at: now, read: false }
  ref = current                                   // ratchet: reset reference
```

- Evaluated whenever the price map updates (Finnhub 60s cycle) or on load.
- Ratchet reset (`ref = current`) is what prevents spam — the next alert needs a
  fresh 5% move from here.
- A single large jump (>10%) fires once, not repeatedly; magnitude is in `pct`.

### Displayed % — decision to confirm

`pct` is the **cumulative move since the add price** (intuitive: "NVDA is up 12%
since you added it"), while the **trigger** is the 5% step from `ref`. Edge case:
after an up-alert, a reversal that triggers a down-alert can show a small
cumulative `pct` (e.g. a red alert reading "(−1%)"). Alternative would be to show
the ~5% step move instead. **Defaulting to cumulative; flag if you want the step.**

## Notifications hook

```
useNotifications(user, watchlist, priceMap) → {
  notifications: Notification[],   // newest first
  unreadCount: number,             // for the badge (cap display at 99+)
  markAllRead(): void,             // called on popover open
  clearAll(): void,                // called by the trash button
}
```

- Owns the RTDB/local subscription, the meta reconciler, and the alert engine.
- Wired in `App.tsx` next to `useWatchlist` (~line 51); `priceMap` derived from
  the existing `live` map (extended to absolute price) + `STOCKS` snapshot.

### `useLiveQuotes` change

Return an absolute-price map alongside day-%:
`{ live, price, status }` where `price[sym] = j.c` (already fetched at
`useLiveQuotes.ts:63`). Existing `live` (day-%) consumers are unaffected.

## UI wiring

- **Bell** renders in `.site-right` (`App.tsx:223`) as a sibling of `.acctslot`,
  gated on `authReady && user` (req 1) — reuse the fixed-slot pattern so it fades
  in without reflow. Badge = `unreadCount`, display capped at `99+`.
  `aria-label="Notifications"` / `"Notifications, N unread"`.
- **Popover** copies `MultiSelect.tsx`'s click-outside + Escape handling; anchored
  top-right; on ≤640px becomes a fixed near-full-width sheet like `.search-open`.
- **Open → mark read:** opening calls `markAllRead()` (badge → 0 immediately), but
  the row dots persist for the current viewing: the component snapshots the set of
  unread ids at open time into local state and shows dots for those; on the next
  open the snapshot is empty (all already read). → reqs 4-answer, 6, 7.
- **Row click** → close popover, `setNav("watch")`, then `handleOpen(stock, rows)`
  where `stock = STOCKS.find(s => s.t === ticker)`, falling back to
  `handleOpenTicker(ticker)` for off-universe symbols (`App.tsx:66-84`). → req 16.
- **Clear-all** (trash + label) → `clearAll()`. → req 8.
- **Empty state** shown when `notifications.length === 0`. → req 4.

### Row hover animation

On hover: background transitions to `--panel-2`, a 3px navy (`--gold`) left accent
bar scales in from the left, and row content nudges right ~2px; ~150ms ease.
Wrapped in `@media (prefers-reduced-motion: reduce)` to disable. → user request.

## Read / unread / dot lifecycle

1. New notification created with `read: false` → increments `unreadCount` → badge.
2. Bell opened → `markAllRead()` sets every `read: true` → badge clears to 0.
3. Row dots (green/red) render for ids that were unread **at this open**, so the
   user still sees what was new this session; they vanish on the next open.
4. Read rows render muted (grey text, no/greyed dot).

## Requirements traceability

| # | Requirement | Covered by |
|---|-------------|-----------|
| 1 | Bell only when logged in | gated `authReady && user` |
| 2 | Bell icon | hand-drawn bell SVG |
| 3 | Dropdown, scrollable | popover, `max-height` + scroll |
| 4 | Empty-state text | Empty 1 |
| 5 | Badge with new count | unreadCount, cap 99+ |
| 6 | Open marks new as read | `markAllRead()` on open |
| 7 | Left red/green dot on unread | session-snapshot dots |
| 8 | Persist + Clear all | RTDB/local + `clearAll()` |
| 9 | Green alert on +5% from add | ratchet engine (up) |
| 10 | "I hope you bought this: " | derived up template |
| 11 | Save price at add | meta reconciler (new adds) |
| 12 | Backfill existing watches | meta reconciler (missing → now) |
| 13 | Red alert on −5% from add | ratchet engine (down) |
| 14 | "it's time to buy: " | derived down template |
| 15 | Only re-alert on next 5% | `ref = current` ratchet |
| 16 | Click → watchlist + modal | `setNav("watch")` + `handleOpen` |

## Known limitations (ponytail ceilings)

- **No alerts while the app is closed** — inherent to the no-backend decision.
- **Multi-tab race:** two open tabs could both fire the same alert before `ref`
  updates propagate. Accepted; add a per-uid single-writer guard only if dup
  alerts become a real annoyance.
- **Snapshot-priced tickers** (non-top-40 / off-hours) only re-evaluate when a new
  build's snapshot loads, so their alerts are effectively load-time.
- **No max-retention / paging** on stored notifications — the list scrolls and
  Clear-all resets it. Add capping only if counts get unwieldy.

## Testing

One runnable self-check for the alert engine (pure function): given a sequence of
prices and an add price, assert the correct sequence of (dir, pct) alerts and the
final `ref` — covering: first +5% up, a second up only after another 5%, a
reversal down-alert, and no alert for sub-5% wiggles.

## Out of scope / YAGNI

- Backend push / scheduled checks.
- Notification categories beyond up/down (earnings, news, etc.).
- User-configurable threshold (fixed 5%).
- Per-notification dismiss (only bulk Clear-all).
- Cross-device read sync beyond what RTDB already gives.

## Open questions to confirm

1. **Displayed %**: cumulative-since-added (default) vs step-since-last-alert
   (see "Displayed % — decision to confirm").
2. **Date format** for the row: `Jul 15` vs `15 Jul 2026` vs the app's existing
   `fmtMarkDate` style (`ThumbMark.tsx:6`). Default: reuse `fmtMarkDate`.
