// Backfill planning for kept tickers that fell out of the 3 sorted screener pulls.
// The full-universe screener call (~14k items, every listed ticker) serves most of them in one
// request; only tickers it lacks need a per-ticker stock-aianalyst payload.
export const UNIVERSE_URL = "https://www.tipranks.com/api/apps/stock/screener?country=us&method=screener&page=1&pageSize=20000&sortDir=2";

/** items -> Map<ticker, item>. On duplicate tickers the primary-market listing wins, else the first stays. */
export function universeMap(items) {
  const m = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const td = it?.tradingInformationData;
    const t = td?.ticker;
    if (!t) continue;
    const cur = m.get(t);
    if (!cur || (td.stockListingIsPrimaryMarket === true && cur.tradingInformationData.stockListingIsPrimaryMarket !== true)) m.set(t, it);
  }
  return m;
}

/** Split `missing` into tickers the universe covers and tickers that need a per-ticker payload. */
export function planBackfill(missing, universe) {
  const fromUniverse = [], needPayload = [];
  for (const t of missing) (universe.has(t) ? fromUniverse : needPayload).push(t);
  return { fromUniverse, needPayload };
}
