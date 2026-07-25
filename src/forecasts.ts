// Analyst forecasts — per-ticker snapshot pulled from TipRanks' free getData feed
// (name, firm, star rating, price target, prior target, position, date), baked into
// public/forecasts/. Lazy-fetched by the modal; also polled fresh by the review detector.
export interface Forecast {
  n: string | null; // analyst name
  f: string | null; // firm
  st: number | null; // TipRanks star rating 0–5
  r: string | null; // position: Buy / Hold / Sell
  pt: number; // price target
  opt: number | null; // prior target (shows "old → new")
  d: string; // rating date "YYYY-MM-DD"
}

const fcCache = new Map<string, Forecast[] | null>();

// fresh=true bypasses the in-memory cache and revalidates with the server (so the review
// detector sees CI updates); the modal uses the cached path for instant re-opens.
export async function fetchForecasts(ticker: string, fresh = false): Promise<Forecast[] | null> {
  if (!fresh && fcCache.has(ticker)) return fcCache.get(ticker)!;
  let val: Forecast[] | null = null;
  try {
    const r = await fetch(
      `${import.meta.env.BASE_URL}forecasts/${encodeURIComponent(ticker)}.json`,
      fresh ? { cache: "no-cache" } : undefined,
    );
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j) && j.length) val = j;
    }
  } catch {
    /* missing / offline -> no coverage */
  }
  fcCache.set(ticker, val);
  return val;
}
