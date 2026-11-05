// One-run hand-off of raw getData responses from ci/refresh-data-ci.mjs (keep-set backfill)
// to ci/scrape-forecasts.mjs, which fetches the SAME URL for the same tickers minutes later.
// Measured on 4 scheduled runs (2026-11-04/05): 31-40% of the forecast step's getData tickers
// had just been fetched by the backfill, and under PARALLEL=3 each getData costs ~13s (nearly
// every request in that step hits a Cloudflare challenge) — ~9-18 min of a 55-94 min step.
//
// Off unless GETDATA_CACHE names a directory; site.yml points both steps at runner.temp, so
// nothing here is ever committed and nothing outlives the job. Local scripts and the
// track-requests lite run never set it and always fetch live.
//
// Every failure degrades to "not cached" -> a live fetch. A cache write can never cost the
// backfill its row, and a bad cache entry can never cost the forecast step a ticker.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export const cachePath = (dir, t) => `${dir}/${encodeURIComponent(t)}.txt`;

/** Store a getData response body that already parsed into a real row. */
export function saveGetData(dir, t, text) {
  if (!dir || typeof text !== "string" || !text) return false;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(dir, t), text);
    return true;
  } catch { return false; }
}

/** Return the cached body once (it is deleted on read), or null. */
export function takeGetData(dir, t) {
  if (!dir) return null;
  const p = cachePath(dir, t);
  try {
    const s = readFileSync(p, "utf8");
    try { unlinkSync(p); } catch { /* still usable */ }
    return s || null;
  } catch { return null; }
}

/** Cached tickers first, each group in its original order. The JSON is merged with an SSR
 *  page fetched live; working cached tickers first keeps the two sources minutes apart rather
 *  than up to the whole step apart. Same set, so nothing is skipped or added. */
export function cachedFirst(targets, dir) {
  if (!dir) return [...targets];
  const has = (t) => { try { readFileSync(cachePath(dir, t)); return true; } catch { return false; } };
  const hit = targets.filter(has);
  const hitSet = new Set(hit);
  return [...hit, ...targets.filter((t) => !hitSet.has(t))];
}
