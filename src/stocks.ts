// The stock list every section reads: stocks.json, plus "Track this stock" rows that are live in
// RTDB `trackedRows` but not bundled yet (see trackedRows.ts). stocks.json is NOT in the JS bundle:
// `?url` emits it as a hashed asset (cacheable across deploys; index.html preloads it, see
// vite.config.ts), fetched here at import. The list is [] until it lands (App shows a loading
// state); tracked rows pop in when the live trackedRows listener fires, and again whenever the lite
// run publishes one. Per-ticker payloads for those rows come from the same listener
// (`trackedPayload`) instead of a public/ fetch that would 404; `useTrackedRev` re-runs a
// consumer's load when its ticker's entry changes.
import { useSyncExternalStore } from "react";
import stocksUrl from "./data/stocks.json?url";
import { mergeTracked, parseTracked, type TrackedKind, type TrackedStock } from "./trackedRows";
import type { Stock } from "./types";
import { onTrackedRows } from "./watchlist";

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

let tracked = new Map<string, TrackedStock>();
let settle: (m: Map<string, TrackedStock>) => void;
/** Resolves on the first listener value: until then a non-bundled ticker can't know whether it's tracked. */
const trackedP = new Promise<Map<string, TrackedStock>>((r) => (settle = r));
onTrackedRows((raw) => {
  void bundleP.then((b) => {
    tracked = parseTracked(raw, b.t);
    settle(tracked);
    publish(mergeTracked(b.list, tracked)); // also wakes useTrackedRev subscribers
  });
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
 *  CI had none. Always the LATEST listener value, so callers check it before their own cache. */
export function trackedPayload(ticker: string, kind: TrackedKind): Promise<unknown> {
  return bundleP.then((b) =>
    b.t.has(ticker) ? undefined : trackedP.then(() => (tracked.has(ticker) ? tracked.get(ticker)![kind] : undefined)),
  );
}

/** Changes whenever this ticker's tracked entry appears or is rewritten — put it in an effect's
 *  deps so the open stock window re-loads forecasts / Bulls-Bears / P/E the moment CI publishes. */
export const useTrackedRev = (ticker: string): TrackedStock | undefined =>
  useSyncExternalStore(subscribe, () => tracked.get(ticker));
