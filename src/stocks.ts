// The stock list every section reads: stocks.json, plus "Track this stock" rows that are live in
// RTDB `trackedRows` but not bundled yet (see trackedRows.ts). stocks.json is NOT in the JS bundle:
// `?url` emits it as a hashed asset (cacheable across deploys; index.html preloads it, see
// vite.config.ts), fetched here at import. The list is [] until it lands (App shows a loading
// state); tracked rows pop in when the one-time read lands. Per-ticker payloads for those rows
// come from the same read (`trackedPayload`) instead of a public/ fetch that would 404.
import { useSyncExternalStore } from "react";
import stocksUrl from "./data/stocks.json?url";
import { mergeTracked, parseTracked, type TrackedKind, type TrackedStock } from "./trackedRows";
import type { Stock } from "./types";
import { trackedRowsRaw } from "./watchlist";

let rows: Stock[] = [];
const subs = new Set<() => void>();
const publish = (next: Stock[]) => {
  rows = next;
  subs.forEach((f) => f());
};

// ponytail: a failed fetch leaves the list empty (App stays on "Loading") — a reload retries.
// Add a retry/error banner if Pages ever flakes on it.
const bundleP: Promise<{ list: Stock[]; t: ReadonlySet<string> }> = fetch(stocksUrl)
  .then((r) => (r.ok ? (r.json() as Promise<Stock[]>) : []))
  .catch(() => [] as Stock[])
  .then((list) => {
    publish(list);
    return { list, t: new Set(list.map((s) => s.t)) };
  });

/** Resolves once stocks.json has landed (tracked rows may still be in flight). */
export const stocksLoaded: Promise<Stock[]> = bundleP.then(() => rows);

const trackedP: Promise<Map<string, TrackedStock>> = Promise.all([bundleP, trackedRowsRaw]).then(([b, raw]) => {
  const m = parseTracked(raw, b.t);
  const next = mergeTracked(b.list, m);
  if (next !== b.list) publish(next);
  return m;
});

const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
const snapshot = () => rows;

/** stocks.json + tracked rows. [] until stocks.json lands, then re-renders when the tracked rows
 *  arrive (if there are any). */
export const useStocks = (): Stock[] => useSyncExternalStore(subscribe, snapshot);

/** Current list outside React (names for notifications, stable callbacks). */
export const currentStocks = (): Stock[] => rows;

/** The full list once the tracked read has settled — for a deep link to a ticker the bundle
 *  lacks, which would otherwise open as off-universe a beat before its tracked row arrives. */
export const stocksReady: Promise<Stock[]> = trackedP.then(() => rows);

/** `undefined`: not a tracked-only ticker, fetch public/ as usual — resolves as soon as stocks.json
 *  is in for every bundled ticker, so they never wait on RTDB. Otherwise the payload, or null if
 *  CI had none. */
export function trackedPayload(ticker: string, kind: TrackedKind): Promise<unknown> {
  return bundleP.then((b) =>
    b.t.has(ticker) ? undefined : trackedP.then((m) => (m.has(ticker) ? m.get(ticker)![kind] : undefined)),
  );
}
