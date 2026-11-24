// Backfill planning for kept tickers that fell out of the 3 sorted screener pulls.
// The full-universe screener call (~14k items, every listed ticker) serves most of them in one
// request; only tickers it lacks need a per-ticker analysis payload.
import { srcUrl } from "./source.mjs";

export const UNIVERSE_URL = srcUrl("universe");

// Company names for the duplicate-ticker tie-break (and keep.mjs legalName): case, punctuation and legal suffixes differ
// between the screener ("Aluminum Corp. of China Ltd") and the stored row (from either source).
const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|lp|sa|ag|nv|se|the)\b/g;
export const normName = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(SUFFIX, " ").replace(/\s+/g, " ").trim();

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
      // stored n is the display name now (R3); rows written before that hold the legal name
      cands = want ? cands.filter((it) => [it.tradingInformationData.companyDisplayName, it.tradingInformationData.companyName].some((x) => normName(x) === want)) : [];
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

/** Cheap `ok` predicate for the universe fetch (ci/src-fetch.mjs getText): looks like JSON (or a
 *  FlareSolverr <pre> wrapper) and names `items`. Without it a plain 200 maintenance/error page that
 *  isChallenge misses was returned as is, the parse threw, and FlareSolverr was never tried. Not a
 *  full parse: the body is ~77 MB. */
export const universeOk = (b) => typeof b === "string" && /^\s*[{<]/.test(b) && /"items"|&quot;items&quot;/.test(b);

/** Only the items for `tickers` (every listing of each, so universeMap's duplicate tie-break still
 *  sees them all). The universe is ~14k items; the kept-but-missing set is a few hundred. */
export function itemsFor(items, tickers) {
  const want = new Set(tickers);
  return (Array.isArray(items) ? items : []).filter((it) => want.has(it?.tradingInformationData?.ticker));
}

/** Ambiguous duplicate tickers that ended up CARRIED (no universe row, no payload row). Only these
 *  are a health line: one covered by its payload is fine, and a permanent duplicate reported every
 *  run would turn every run red. */
export const ambiguousCarried = (ambiguous, carried) => ambiguous.filter((t) => carried.has(t));

/** Split `missing` into tickers the universe covers and tickers that need a per-ticker payload. */
export function planBackfill(missing, universe) {
  const fromUniverse = [], needPayload = [];
  for (const t of missing) (universe.has(t) ? fromUniverse : needPayload).push(t);
  return { fromUniverse, needPayload };
}
