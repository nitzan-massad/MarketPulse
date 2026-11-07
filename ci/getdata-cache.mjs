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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { rowFromGetData } from "./keep.mjs";

/** A getData body that parses (via `parse`) into a real row for THIS ticker. The one definition of
 *  "usable payload", shared by the cache read and the live fetch: a page that merely contains a
 *  `{...}` (an error page's `{"status":404}`, a challenge's `_cf_chl_opt={}`) parses to an object
 *  with no experts and once read as "no coverage", shrinking the file to its page rows. */
export function isPayloadFor(parse, text, t) {
  try { return rowFromGetData(parse(text)).t === t; } catch { return false; }
}

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
  const hit = targets.filter((t) => existsSync(cachePath(dir, t)));
  const hitSet = new Set(hit);
  return [...hit, ...targets.filter((t) => !hitSet.has(t))];
}
