// ============================================================================================
// LOCKED LOGIC — do not change without a direct instruction from the repo owner.
// The thresholds, the ratchet, the re-fire guard and what an alert displays are product
// decisions, not implementation details. alertEngine.check.ts pins every case of the alert
// matrix; editing its expectations to make a change pass IS changing this logic, and needs
// the same explicit order. Refactors that keep every check green unedited are fine.
// ============================================================================================
//
// Pure ratchet engine for watchlist price alerts. Dependency-free on purpose so
// it can be unit-checked without React or Firebase — see alertEngine.check.ts.
//
// A ticker carries { addPx, ref }: addPx is the price when it was added (fixed;
// the alert's small gray % is the move since it), ref is the moving reference that ratchets after
// each alert so we don't spam. An alert fires when the move from ref crosses ±5%;
// on firing, ref resets to the current price. The alert's % is that move from ref
// (since the last alert), not the cumulative move since the ticker was added.

export type Dir = "up" | "down";

export interface Meta {
  addPx: number; // price when the ticker was added to the watchlist
  ref: number; // reference for the next alert; starts equal to addPx
  addAt?: number; // epoch ms when it was added; absent on tickers added before this field
}

export interface AlertResult {
  dir: Dir;
  pct: number; // signed % vs ref at fire time (since the last alert, or since added)
  newRef: number; // ref to persist so the next alert needs another 5% from here
}

export const ALERT_THRESHOLD = 0.05; // ±5%

export function evalAlert(current: number, meta: Meta): AlertResult | null {
  const { addPx, ref } = meta;
  // ignore missing / non-positive prices (unknown quote, off-universe ticker)
  if (!(current > 0) || !(ref > 0) || !(addPx > 0)) return null;

  const move = (current - ref) / ref;
  let dir: Dir;
  if (move >= ALERT_THRESHOLD) dir = "up";
  else if (move <= -ALERT_THRESHOLD) dir = "down";
  else return null;

  return { dir, pct: Math.round(move * 100), newRef: current };
}

// After an alert fires at price P, the ratchet must not fire again until price moves
// another ±threshold from P. `meta.ref` encodes that, but it is persisted asynchronously
// (Firebase), and a not-yet-echoed reset can be reverted by onValue's full-map replace —
// which let one continuous MU drop fire both a 5% and a 7% alert off a stale ref. This
// synchronous guard closes that window: given the in-memory price at the last fire, it
// reports whether `current` is still within one threshold of it (i.e. must be suppressed).
export function reFireSuppressed(current: number, lastFiredPx: number | undefined): boolean {
  if (!(current > 0) || !(lastFiredPx! > 0)) return false;
  return Math.abs((current - lastFiredPx!) / lastFiredPx!) < ALERT_THRESHOLD;
}

type Prices = Record<string, number | undefined>;
export type MetaWrite = [ticker: string, meta: Meta | null]; // null = delete
export interface PriceAlert {
  ticker: string;
  dir: Dir;
  since: number; // % since the previous alert (or since added, for the first)
  total: number; // % since the ticker was added, at fire time
  addAt?: number; // when it was added (absent on older meta)
}

/** Meta upkeep (useNotifications' reconcile effect): a newly watched ticker with a price gets
 *  { addPx: price, ref: price, addAt: now } — no alert; an unwatched one is deleted and its re-fire memory
 *  dropped, so re-adding it starts from a fresh baseline. Mutates `lastFired` (a React ref). */
export function reconcileMeta(
  watchlist: string[],
  prices: Prices,
  meta: Record<string, Meta>,
  lastFired: Record<string, number>,
  now = Date.now(),
): MetaWrite[] {
  const writes: MetaWrite[] = [];
  for (const t of watchlist) {
    const px = prices[t];
    if (!meta[t] && typeof px === "number") writes.push([t, { addPx: px, ref: px, addAt: now }]);
  }
  for (const t of Object.keys(meta)) {
    if (!watchlist.includes(t)) {
      writes.push([t, null]);
      delete lastFired[t];
    }
  }
  return writes;
}

/** One pass of the ratchet over the watchlist (useNotifications' fire effect). `meta.ref`
 *  resets async via Firebase, and a not-yet-echoed reset can be reverted by onValue's full-map
 *  replace — which let one 7% MU drop fire both a 5% and a 7% alert off the stale ref — so the
 *  in-memory last-fire price (`lastFired`, mutated here) gates every fire. */
export function fireAlerts(
  watchlist: string[],
  prices: Prices,
  meta: Record<string, Meta>,
  lastFired: Record<string, number>,
): { alerts: PriceAlert[]; writes: MetaWrite[] } {
  const alerts: PriceAlert[] = [];
  const writes: MetaWrite[] = [];
  for (const t of watchlist) {
    const m = meta[t];
    const cur = prices[t];
    if (!m || typeof cur !== "number") continue;
    const res = evalAlert(cur, m);
    if (!res || reFireSuppressed(cur, lastFired[t])) continue;
    lastFired[t] = cur;
    const total = Math.round(((cur - m.addPx) / m.addPx) * 100);
    // conditional spread, not `addAt: undefined` — Firebase set() rejects undefined values
    alerts.push({ ticker: t, dir: res.dir, since: res.pct, total, ...(m.addAt ? { addAt: m.addAt } : {}) });
    writes.push([t, { ...m, ref: res.newRef }]);
  }
  return { alerts, writes };
}

/** What a price notification row shows: the big signed % (since the last alert; rows saved
 *  before `since` existed carry only the legacy cumulative `pct`) and the small gray suffix
 *  line with the % since the ticker was tracked: "−30% since 10/03", or "since tracked" when
 *  the add time predates `addAt`. Absent on legacy rows. */
export function alertView(
  n: { since?: number; pct?: number; total?: number; addAt?: number },
  fmtDate: (ms: number) => string,
): { pct: string; total: string | null } {
  const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v)}%`;
  const total = n.total == null ? null : `${signed(n.total)} since ${n.addAt ? fmtDate(n.addAt) : "tracked"}`;
  return { pct: signed(n.since ?? n.pct ?? 0), total };
}
