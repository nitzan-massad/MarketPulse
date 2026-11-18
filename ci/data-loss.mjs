// Data-loss gate: compares the PREVIOUS data snapshot with the refreshed one and reports every
// way the refresh LOST something instead of updating it. Pure (no fs) except the two loaders at
// the bottom. Used by ci/test-no-data-loss.mjs (the blocking post-scrape "DATA GATE") and by
// ci/replay-data-loss.mjs (the dev tool that tuned LIMITS on git history).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Fields that may never go from a value back to null — one row is already a violation.
export const STRICT = Object.freeze(["n", "px", "mc", "desc", "sec"]);

// Fields that legitimately go null sometimes (a ticker loses analyst coverage, a score is
// withdrawn): the gate only fires when MORE THAN this many rows do it in one run.
// Replay-tuned on the last 60 data-commit pairs (ci/replay-data-loss.mjs 60); observed max
// rows going value -> null in a single run was (2026-11-18, 60 pairs, 513 -> 557 rows):
//   pt 8, up 8, con 1, ss 5   -> limits are roughly 2x headroom over that (con/ss kept tighter
//   because their observed churn is tiny, so a bigger jump there is a real signal).
export const LIMITS = Object.freeze({ pt: 15, up: 15, con: 5, ss: 10 });

export const FORECAST_SHRINK = 0.2; // a file may lose at most 20% of its rows...
export const FORECAST_MIN_ROWS = 5; // ...once it has at least this many

export const FORECAST_MAX_AGE_DAYS = 365; // older rows age out of TipRanks' window: churn, not loss

/** Rows that count toward the shrink rule: human analysts (firm not "TipRanks - <AI model>",
 *  same test as ci/forecast-merge.mjs) rated within 365 days of `now` (ms; pure arg). */
export function countRows(rows, now) {
  const cutoff = now - FORECAST_MAX_AGE_DAYS * 864e5;
  return rows.filter((r) => !/^TipRanks\b/i.test(r?.f || "") && !(Date.parse(r?.d) < cutoff)).length;
}

const has = (v) => v !== null && v !== undefined;

/**
 * @param {{prevRows:object[], nextRows:object[], prevSeen:object, nextSeen:object,
 *          prevFc:Record<string,number>, nextFc:Record<string,number>, dropped?:string[]}} a
 * @returns {string[]} one human line per violation; [] when nothing was lost
 */
export function lossReport({ prevRows = [], nextRows = [], prevSeen = {}, nextSeen = {}, prevFc = {}, nextFc = {}, dropped = [] }) {
  const out = [];
  const drop = new Set(dropped || []);
  const next = new Map(nextRows.map((r) => [r.t, r]));

  // tickers
  const gone = [];
  for (const p of prevRows) if (!next.has(p.t) && !drop.has(p.t)) gone.push(p.t);
  if (gone.length) out.push(`${gone.length} ticker(s) vanished without being expired: ${gone.slice(0, 20).join(", ")}${gone.length > 20 ? ", ..." : ""}`);

  // strict + threshold fields, over tickers present on both sides
  const lost = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, []]));
  for (const p of prevRows) {
    const n = next.get(p.t);
    if (!n) continue;
    for (const k of STRICT) if (has(p[k]) && !has(n[k])) out.push(`${p.t}.${k}: ${JSON.stringify(p[k]).slice(0, 40)} -> null`);
    for (const k of Object.keys(LIMITS)) if (has(p[k]) && !has(n[k])) lost[k].push(p.t);
  }
  for (const [k, ts] of Object.entries(lost))
    if (ts.length > LIMITS[k]) out.push(`${ts.length} rows lost ${k} in one run (limit ${LIMITS[k]}): ${ts.slice(0, 10).join(", ")}${ts.length > 10 ? ", ..." : ""}`);

  // seen.json: first-seen date `d` is immutable; keys only leave via expiry
  for (const [t, v] of Object.entries(prevSeen)) {
    if (!(t in nextSeen)) { if (!drop.has(t)) out.push(`seen.${t}: key gone without expiry`); }
    else if (v?.d !== nextSeen[t]?.d) out.push(`seen.${t}.d changed: ${v?.d} -> ${nextSeen[t]?.d}`);
  }

  // forecasts
  for (const [t, c] of Object.entries(prevFc)) {
    if (!(t in nextFc)) { if (!drop.has(t)) out.push(`forecasts/${t}.json deleted (${c} rows)`); } // an expired ticker's file is pruned with it (replay: 3 of 3 deletions)
    else if (c >= FORECAST_MIN_ROWS && nextFc[t] < c * (1 - FORECAST_SHRINK)) out.push(`forecasts/${t}.json shrank ${c} -> ${nextFc[t]} rows`);
  }
  return out;
}

// ---- loaders (shared by the test and the replay) ----
const readJson = (f, dflt) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return dflt; } };

/** ticker -> countRows() for every per-ticker array file in a forecasts directory. */
export function forecastCounts(dir, now = Date.now()) {
  const o = {};
  if (!existsSync(dir)) return o;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const j = readJson(path.join(dir, f), null);
    if (Array.isArray(j)) o[f.slice(0, -5)] = countRows(j, now);
  }
  return o;
}

/** Snapshot from a directory holding prev-stocks.json / prev-seen.json / prev-forecasts/
 *  (what site.yml copies to $RUNNER_TEMP), or from the working tree when no dir is given. */
export function loadSnapshot(dir, now = Date.now()) {
  return dir
    ? { rows: readJson(path.join(dir, "prev-stocks.json"), []), seen: readJson(path.join(dir, "prev-seen.json"), {}), fc: forecastCounts(path.join(dir, "prev-forecasts"), now) }
    : { rows: readJson("src/data/stocks.json", []), seen: readJson("src/data/seen.json", {}), fc: forecastCounts("public/forecasts", now) };
}
