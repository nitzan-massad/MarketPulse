import { cnbcRequest, normSym, type CnbcMap } from "./quotes";
import { freshQuote, putQuotes } from "./quoteStore";
import { WORKER_URL } from "./workerUrl";

// Hovering a row for a moment warms its 1D chart in the Worker's cache (60 s), so the click
// that follows finds it ready instead of waiting ~0.5-1 s on a cold CNBC call. Intent-gated
// (HOVER_MS) so a mouse sweeping across the table doesn't fire a request per row; once per
// ticker per minute. Fire-and-forget: a failure only means the click does the work.
const HOVER_MS = 150;
const WARM_TTL_MS = 60_000;
const warmedAt = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

function warm(ticker: string): void {
  const sym = normSym(ticker);
  if (!sym || Date.now() - (warmedAt.get(sym) ?? 0) < WARM_TTL_MS) return;
  warmedAt.set(sym, Date.now());
  void fetch(`${WORKER_URL}/bars?symbol=${encodeURIComponent(sym)}&range=1D`).catch(() => {});
}

/** Spread onto a row/card: `<tr {...warmChart(s.t)}>`. */
export function warmChart(ticker: string) {
  return {
    onMouseEnter: () => {
      clearTimeout(timer);
      timer = setTimeout(() => warm(ticker), HOVER_MS);
    },
    onMouseLeave: () => clearTimeout(timer),
  };
}

// Search: the dropdown's quotes are fetched while the user is still choosing — one /quotes call
// for the ones the page doesn't hold yet (into the shared store the modal reads) — and the top
// SEARCH_WARM_CHARTS results' 1D charts are warmed (each uncached one costs a CNBC call, so not
// all 12 on every pause in the typing). Debounced: only the list the typing settles on.
const SEARCH_SETTLE_MS = 300;
const SEARCH_WARM_CHARTS = 3;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** An empty list cancels a pending prefetch (dropdown closed, or a result already picked). */
export function prefetchStocks(tickers: string[]): void {
  clearTimeout(searchTimer);
  if (!tickers.length) return;
  searchTimer = setTimeout(() => {
    const need = cnbcRequest(tickers.filter((t) => !freshQuote(t)));
    if (need.length)
      void fetch(`${WORKER_URL}/quotes?symbols=${need.map(encodeURIComponent).join(",")}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j?.quotes && typeof j.quotes === "object") putQuotes(j.quotes as CnbcMap);
        })
        .catch(() => {});
    for (const t of tickers.slice(0, SEARCH_WARM_CHARTS)) warm(t);
  }, SEARCH_SETTLE_MS);
}
