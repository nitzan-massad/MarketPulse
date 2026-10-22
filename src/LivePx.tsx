import { createContext, useContext } from "react";
import { fmtPx } from "./lib";

// Live price for any Price cell, without threading props through every section: App provides
// the merged CNBC/Finnhub price map + the hook's `observe`, and a cell falls back to its
// snapshot price when the ticker has no live quote (live off, not yet polled, unknown).
export interface LiveCtxValue {
  price: Record<string, number>;
  observe?: (ticker: string) => (el: HTMLElement | null) => void;
}
export const LiveCtx = createContext<LiveCtxValue>({ price: {} });

// `track`: register the cell for on-screen quoting. Off where the row already registers
// itself (StockTable) or is always quoted anyway (Watchlist).
export function LivePx({ t, px, track = false }: { t: string; px: number | null | undefined; track?: boolean }) {
  const { price, observe } = useContext(LiveCtx);
  const v = price[t] ?? px;
  return <span ref={track ? observe?.(t) : undefined}>{fmtPx(v ?? null)}</span>;
}
