# Notification Bell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A header notification bell that alerts a logged-in user when a watchlist stock moves ≥5% from its add price (green up / red down), with a persisted, scrollable dropdown, unread badge, and click-through to the stock's Watchlist modal.

**Architecture:** One pure ratchet engine (`alertEngine.ts`), one persistence+logic hook (`useNotifications.ts`) mirroring `useWatchlist`, one self-contained UI component (`NotificationBell.tsx`) built from the approved mockup, CSS added to the single global `index.css`, wired into `App.tsx`'s header. Prices come from an extended `useLiveQuotes` (live Finnhub `c`, snapshot `px` fallback).

**Tech Stack:** React 18 + TS + Vite, Firebase RTDB + Auth, plain global CSS. No new dependencies.

Spec: `docs/superpowers/specs/2026-07-19-notification-bell-design.md`.

## Global Constraints

- Light "Steel Navy" palette; accent `--gold` is navy `#1b3f73`; `--green:#17864f` / `--red:#c73a2b`. Fonts Archivo / JetBrains Mono / Fraunces. Icons: inline 24×24 `currentColor` stroke SVGs.
- Persistence mirrors existing hooks: Firebase RTDB when signed-in + configured, `localStorage` fallback (`DEV_AUTH` / no `db`). New keys: RTDB `watchmeta/<uid>`, `notifications/<uid>`; local `mp_watch_meta`, `mp_notifs`.
- Threshold fixed at 5%. Ratchet: after an alert, `ref = current`. Displayed `pct` is cumulative vs `addPx`. Date via `fmtMarkDate`.
- No new npm dependencies. No backend. Alerts computed client-side while the app is open.
- Bell renders only when `authReady && user`.

---

### Task 1: Expose absolute price from `useLiveQuotes`

**Files:** Modify `src/useLiveQuotes.ts`

**Produces:** `useLiveQuotes(...)` returns `{ live, price, status }` where `price: Record<string, number>` maps ticker → last Finnhub `c` (current price).

- [ ] Add a `price` state map. In the fetch loop, when `j.c` is a number, set `price[sym] = j.c` alongside the existing `dp` write. Return `price` in the hook result. Existing `live`/`status` consumers unchanged.

---

### Task 2: Pure ratchet engine + self-check (TDD)

**Files:** Create `src/alertEngine.ts`, `src/alertEngine.check.ts`

**Produces:**
```ts
export type Dir = "up" | "down";
export interface Meta { addPx: number; ref: number }
export interface AlertResult { dir: Dir; pct: number; newRef: number }
// Returns an alert (and the new ref to persist) when |current-ref|/ref >= 0.05, else null.
export function evalAlert(current: number, meta: Meta): AlertResult | null;
```

- [ ] **Write the check first** (`alertEngine.check.ts`) with `console.assert`s:
  - added $100 (ref 100): $104 → null; $105 → {dir:"up", pct:5, newRef:105}; then from ref 105: $110.25 → {up, pct:10, newRef:110.25}.
  - from ref 105: $99.75 → {dir:"down", pct:0, newRef:99.75} (reversal shows small cumulative pct — intended).
  - added $100, $80 → {down, pct:-20, newRef:80}.
  - guards: current<=0 or ref<=0 → null.
- [ ] Run it, verify it fails (function not defined): `npx tsc src/alertEngine.check.ts src/alertEngine.ts --outDir /tmp/ae --module esnext --moduleResolution bundler --target es2020 && node /tmp/ae/alertEngine.check.js`
- [ ] Implement `evalAlert`: `move=(current-ref)/ref`; if `move>=0.05` dir="up"; else if `move<=-0.05` dir="down"; else null. `pct=Math.round((current-addPx)/addPx*100)`, `newRef=current`.
- [ ] Re-run the check, verify all asserts pass.

---

### Task 3: `useNotifications` hook

**Files:** Create `src/useNotifications.ts`

**Consumes:** `evalAlert`, `Meta` from Task 2; `User` from `watchlist.ts`; the `db`/`DEV_AUTH` persistence pattern from `watchlist.ts`.

**Produces:**
```ts
export interface Notification { id: string; ticker: string; dir: Dir; pct: number; at: number; read: boolean }
export function useNotifications(
  user: User | null,
  watchlist: string[],
  priceOf: (ticker: string) => number | undefined,
): { notifications: Notification[]; unreadCount: number; markAllRead(): void; clearAll(): void };
```

- [ ] Subscribe to `notifications/<uid>` (RTDB) / read `mp_notifs` (local); keep `notifications` sorted by `at` desc; `unreadCount = count(!read)`.
- [ ] Subscribe to `watchmeta/<uid>` (RTDB) / `mp_watch_meta` (local) into a `meta` map.
- [ ] **Reconciler effect** (reqs 11+12): for each ticker in `watchlist` with no `meta[ticker]` and a known `priceOf(ticker)`, write `{ addPx: price, ref: price }`. Prune `meta` entries for tickers no longer in `watchlist`.
- [ ] **Alert effect**: on `priceOf`/`meta`/`watchlist` change, for each watched ticker with meta + known price, call `evalAlert`; if non-null, `push` a notification `{ticker, dir, pct, at: Date.now(), read:false}` and update `meta[ticker].ref = newRef`. Debounce so one price cycle evaluates once; guard against re-firing (ref update is the guard).
- [ ] `markAllRead()`: set `read:true` on all (RTDB multi-path update / local rewrite). `clearAll()`: remove `notifications/<uid>` / clear `mp_notifs`.

---

### Task 4: `NotificationBell` component

**Files:** Create `src/components/NotificationBell.tsx`

**Consumes:** the Task 3 hook result + a `onOpenTicker(ticker: string)` callback (from App).

**Produces:** `<NotificationBell notifications unreadCount onMarkAllRead onClearAll onOpenTicker />` — a bell button (in `.site-right`) with badge, and the popover (Popover 3+4 layout: title+count, Today/Earlier groups, card rows in Row-5 layout, scroll-fade, sticky trash Clear-all footer, Empty-1 empty state).

- [ ] Bell button: inline bell SVG; badge shows `unreadCount` (cap `99+`), hidden when 0 or while open-session. `aria-label`, `aria-haspopup`, `aria-expanded`.
- [ ] Popover: copy `MultiSelect.tsx` click-outside (mousedown) + Escape close. On open → `onMarkAllRead()`; snapshot the set of currently-unread ids into local state for session dots.
- [ ] Rows: group by Today (same calendar day as now) / Earlier; render dot (green/up, red/down; muted if not in session-new set), message via template, ticker, `fmtMarkDate(at)`, big arrow+pct. Row click → `onOpenTicker(ticker)` then close.
- [ ] Empty state when `notifications.length===0`. Clear-all (trash+label) → `onClearAll()`.

---

### Task 5: CSS

**Files:** Modify `src/index.css` (append a `/* notifications */` block)

- [ ] Port the approved mockup styles under a `.nb-` prefix (bell/badge, popover shell, group label, card row + Row-5 internals, dots, big pct, footer clear, empty state, hover animation with `prefers-reduced-motion` guard, mobile full-width sheet). Reuse existing tokens; no new tokens.

---

### Task 6: Wire into `App.tsx`

**Files:** Modify `src/App.tsx`

**Consumes:** `useNotifications`, `NotificationBell`, existing `handleOpen`/`handleOpenTicker`/`setNav`, `useLiveQuotes` `price`, `STOCKS`.

- [ ] Build `priceOf(ticker)`: `price[ticker] ?? STOCKS.find(s=>s.t===ticker)?.px`.
- [ ] `const notif = useNotifications(user, watchlist, priceOf)`.
- [ ] Render `<NotificationBell .../>` in `.site-right` before `.acctslot`, gated on `authReady && user`.
- [ ] `onOpenTicker(ticker)`: `setNav("watch")`; `const s = STOCKS.find(x=>x.t===ticker)`; `s ? handleOpen(s, watchRows) : handleOpenTicker(ticker)`.

---

### Task 7: Verify

- [ ] `npx tsc --noEmit` clean.
- [ ] `npm run build` succeeds.
- [ ] `node /tmp/ae/alertEngine.check.js` — all asserts pass.
- [ ] Manual smoke via `npm run dev`: signed-in bell appears; open clears badge; empty state; clear-all.

## Self-review

- Spec coverage: reqs 1–16 map to Tasks 1–6 (see spec traceability table); alert ratchet = Task 2; persistence + Clear-all = Task 3; UI = Tasks 4–5; nav = Task 6.
- No placeholders: engine test values are concrete; hook/engine signatures fixed and reused consistently across tasks.
- Types: `Dir`, `Meta`, `Notification`, `evalAlert`, `useNotifications` names match across Tasks 2→3→4→6.
