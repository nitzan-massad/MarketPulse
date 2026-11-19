// Backfill planning for kept tickers that fell out of the 3 sorted screener pulls.
// The full-universe screener call (~14k items, every listed ticker) serves most of them in one
// request; only tickers it lacks need a per-ticker stock-aianalyst payload.
export const UNIVERSE_URL = "https://www.tipranks.com/api/apps/stock/screener?country=us&method=screener&page=1&pageSize=20000&sortDir=2";

// Company names for the duplicate-ticker tie-break: case, punctuation and legal suffixes differ
// between the screener ("Aluminum Corp. of China Ltd") and the stored row (from either source).
const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|sa|ag|nv|se|the)\b/g;
const normName = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();

/**
 * items -> Map<ticker, item>. The universe lists some tickers more than once (OTC/foreign lines,
 * a different company reusing the symbol). Per ticker: the only item; else the one primary-market
 * listing; else the one whose name matches last run's row (`prev`: Map<ticker, row>). Anything
 * still ambiguous is SKIPPED — pushed to `ambiguous` for a health line — so it falls to the
 * per-ticker payload (then carry). Keeping the first item used to graft another company's price
 * and consensus onto the row.
 */
export function universeMap(items, { prev, ambiguous } = {}) {
  const groups = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const t = it?.tradingInformationData?.ticker;
    if (!t) continue;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(it);
  }
  const m = new Map();
  for (const [t, list] of groups) {
    const primary = list.filter((it) => it.tradingInformationData.stockListingIsPrimaryMarket === true);
    let cands = primary.length ? primary : list;
    if (cands.length > 1) {
      const want = normName(prev?.get(t)?.n);
      cands = want ? cands.filter((it) => normName(it.tradingInformationData.companyName) === want) : [];
    }
    if (cands.length === 1) m.set(t, cands[0]);
    else ambiguous?.push(t);
  }
  return m;
}

/** The universe body's item list. A body that parsed but has no `items` array is a reshape: throw
 *  so the caller reports it (health "universe pull failed") instead of passing it as an empty map.
 *  Shared by both refresh scripts — the local one had `.items || []`, which hid exactly that. */
export function universeItems(body) {
  const items = body?.items;
  if (!Array.isArray(items)) throw new Error("no items");
  return items;
}

/** Split `missing` into tickers the universe covers and tickers that need a per-ticker payload. */
export function planBackfill(missing, universe) {
  const fromUniverse = [], needPayload = [];
  for (const t of missing) (universe.has(t) ? fromUniverse : needPayload).push(t);
  return { fromUniverse, needPayload };
}
