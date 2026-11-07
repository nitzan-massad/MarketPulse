// Backfill/refresh public/forecasts/<T>.json from TipRanks' getData `experts`
// feed, via FlareSolverr (same Cloudflare-bypass the data refresh uses). Strictly
// additive + per-ticker failure-tolerant: a bad ticker is skipped, never fatal, so
// this can't break the main refresh. Fills tickers that are MISSING a file or are
// older than STALE_DAYS, stalest first so LIMIT rotates through the whole universe
// (pass ALL=1 to force everyone). Cap with LIMIT (default 90).
//
// ponytail: "when did we last fetch this" lives in the committed _asOf.json sidecar,
// NOT in the file's mtime. Git stores no mtimes, so actions/checkout stamps every file
// with the checkout time — an mtime check makes all 300+ files look seconds old, nothing
// is ever refreshed, and only brand-new tickers get fetched. That's exactly what happened
// between 2026-07-24 and 2026-08-02. The sidecar survives checkout because git tracks it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isChallenge, parseForecastHtml, usablePage, withStars } from "./forecast-html.mjs";
import { mergeForecasts, shouldFetchPage } from "./forecast-merge.mjs";
import { nearEarningsNow } from "./scrape-earnings.mjs";
import { cachedFirst, isPayloadFor, takeGetData } from "./getdata-cache.mjs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const LIMIT = Number(process.env.LIMIT || 90);
const STALE_DAYS = Number(process.env.STALE_DAYS || 3);
const ALL = process.env.ALL === "1";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // just these tickers (ci/track-requests)
// Union the SSR page into the JSON path instead of only falling back to it when JSON gave
// nothing. Default ON; SSR_MERGE=0 is an exact rollback to the old fallback behaviour without
// a revert. Costs one page fetch per ticker in the rotation (~+8 min, ~+34 MB per run,
// measured over 418 tickers) and buys +42.6% rows with 83% of tickers getting fresher data.
// See ci/forecast-merge.mjs and ci/PLAN-ssr-merge.md.
const MERGE = process.env.SSR_MERGE !== "0";
// Overridable so a live run can be pointed at a throwaway directory to verify the merge
// against real TipRanks pages without touching the committed files. CI never sets it.
const OUT = process.env.OUT || "public/forecasts";
// getData bodies the snapshot step fetched minutes ago this run (see ci/getdata-cache.mjs).
const CACHE = process.env.GETDATA_CACHE || null;
const ASOF = `${OUT}/_asOf.json`; // { ticker: ISO } — build-reviews-recent skips it (not an array)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATING = { 1: "Buy", 2: "Hold", 3: "Sell" };

// the lite run (ONLY) has a user waiting: 3 tries, not 6 x (up to 60s + 6s) per URL
// A Cloudflare page is always retried like an error; `ok` adds a per-URL check (e.g. "is JSON").
// Never fold the Cloudflare test into `ok`: a challenge's inline `_cf_chl_opt={}` parses as JSON
// `{}`, which read as "no experts" and shrank MA to its page rows in the E2E fault run.
async function flareGet(url, ok = () => true, tries = ONLY ? 3 : 6) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(FS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
      });
      const j = await r.json();
      if (j.status === "ok" && j.solution) {
        const html = j.solution.response || "";
        if (isChallenge(html)) throw new Error("Cloudflare page");
        if (!ok(html)) throw new Error("unusable response");
        return html;
      }
      throw new Error(j.message || "status != ok");
    } catch (e) {
      lastErr = e;
      await sleep(6000);
    }
  }
  throw lastErr;
}

// getData comes back as JSON, sometimes wrapped in <pre> with HTML entities
function extractJson(html) {
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  for (const cand of [pre && pre[1], html].filter(Boolean)) {
    const decoded = cand
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const m = decoded.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try { return JSON.parse(m[0]); } catch { /* try next */ }
  }
  throw new Error("no JSON in response");
}

// experts[] -> our Forecast[]: real ranked analysts with a price target, newest first
function toForecasts(data) {
  const out = [];
  for (const e of data.experts || []) {
    if (!e.name || e.aiModel || !e.includedInConsensus) continue; // skip AI/unranked rows
    const r0 = (e.ratings || [])[0]; // ratings are newest-first
    if (!r0) continue;
    const pt = r0.convertedPriceTarget ?? r0.priceTarget;
    if (pt == null) continue; // a forecast needs a target
    const rk = (e.rankings || []).find((x) => x.stars != null) || {};
    out.push({
      n: e.name,
      f: e.firm || null,
      st: rk.stars ?? null,
      r: RATING[r0.ratingId] ?? null,
      pt: +Number(pt).toFixed(2),
      opt: r0.convertedOldPriceTarget ?? r0.oldPriceTarget ?? null,
      d: (r0.date || "").slice(0, 10),
    });
  }
  out.sort((a, b) => (b.d || "").localeCompare(a.d || ""));
  return out;
}

const stocks = JSON.parse(readFileSync("src/data/stocks.json", "utf8"));
const staleBefore = Date.now() - STALE_DAYS * 864e5;
const asOf = existsSync(ASOF) ? JSON.parse(readFileSync(ASOF, "utf8")) : {};
const age = (t) => Date.parse(asOf[t]) || 0; // never fetched -> 0 -> front of the queue
// Companies within 2 days of an earnings report are refreshed EVERY run, on top of LIMIT —
// that is when new analyst reviews land. The rest rotate stalest-first as before.
const near = ONLY ? new Set() : nearEarningsNow();
const hot = stocks.map((s) => s.t).filter((t) => near.has(t));
const targets = [...hot, ...stocks
  .map((s) => s.t)
  .filter((t) => !near.has(t) && (ONLY ? ONLY.includes(t) : ALL || age(t) < staleBefore))
  .sort((a, b) => age(a) - age(b)) // stalest (incl. never-fetched = 0) first
  .slice(0, LIMIT)];

// Clamped: 0/NaN/negative would start no worker and "succeed" having fetched nothing.
const PARALLEL = Math.max(1, Math.floor(Number(process.env.PARALLEL)) || 1);
mkdirSync(OUT, { recursive: true });
console.log(`forecasts backfill: ${targets.length} ticker(s), ${hot.length} near earnings (LIMIT=${LIMIT}, ALL=${ALL}, SSR_MERGE=${MERGE ? 1 : 0}, PARALLEL=${PARALLEL})`);
const now = new Date().toISOString();
let ok = 0, empty = 0, fail = 0, viaHtml = 0, gained = 0, fromCache = 0, tableless = 0;
// ponytail: a fixed pool of PARALLEL workers over one shared FlareSolverr; each request is a
// headless Chrome, so the ceiling is runner CPU, not TipRanks: 3 on the 4-vCPU runner
// (90 tickers: P1 973s, P3 655s, P10 1378s). More needs more cores or more FlareSolverr instances.
const queue = cachedFirst(targets, CACHE);
// ponytail: _asOf is flushed every 20 stamps and on SIGTERM/SIGINT, atomically (tmp + rename), so a
// step timeout or cancel keeps the rotation progress it made instead of re-picking the same
// tickers next run; files already written are committed either way. Ceiling: up to 19 stamps lost
// on a hard SIGKILL — those tickers are simply refetched next run.
let stamped = 0;
const saveAsOf = () => { writeFileSync(`${ASOF}.tmp`, JSON.stringify(asOf, null, 1)); renameSync(`${ASOF}.tmp`, ASOF); };
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { saveAsOf(); console.log(`${sig}: _asOf saved (${stamped} stamped)`); process.exit(143); });
async function scrape(t) {
  try {
    let data = null;
    const cached = takeGetData(CACHE, t);
    // same test the writer applied (a real row for THIS ticker); anything else -> fetch live
    if (cached && isPayloadFor(extractJson, cached, t)) { data = extractJson(cached); fromCache++; } // else fetch live
    data ??= extractJson(await flareGet(`https://www.tipranks.com/api/stocks/getData/?name=${encodeURIComponent(t)}`, (h) => isPayloadFor(extractJson, h, t)));
    let fc = toForecasts(data);
    const jsonCount = fc.length;
    // The API paywall-anonymizes its FRESHEST rows, so the JSON path is systematically behind
    // on every ticker — not just the micro-caps where it returned nothing. The SSR page renders
    // names and targets in full, so we union the two rather than only falling back when JSON
    // came up empty. See ci/forecast-merge.mjs for the merge rules and the measured effect.
    if (shouldFetchPage(fc, data, MERGE)) {
      const url = `https://www.tipranks.com/stocks/${encodeURIComponent(t.toLowerCase())}/forecast`;
      let page = await flareGet(url);
      // ponytail: one refetch for a table-less page, then merge it anyway (JSON rows only). A full
      // retry loop here would turn a TipRanks redesign into a frozen run past the step timeout.
      if (!usablePage(page, jsonCount)) page = await flareGet(url);
      if (!usablePage(page, jsonCount)) tableless++;
      const rows = withStars(parseForecastHtml(page), data);
      if (MERGE) {
        // Additive per analyst: a page that parses to nothing leaves the JSON result untouched.
        const merged = mergeForecasts(rows, fc);
        if (merged.length > fc.length) viaHtml++;
        fc = merged;
      } else if (rows.length) {
        fc = rows; viaHtml++;
      }
    }
    if (fc.length) {
      writeFileSync(`${OUT}/${t}.json`, JSON.stringify(fc)); ok++;
      gained += fc.length - jsonCount;
      console.log(`  ${t}: ${fc.length} ✓${fc.length > jsonCount ? ` (+${fc.length - jsonCount} via page)` : ""}`);
    }
    else { empty++; console.log(`  ${t}: none`); }
    // ponytail: stamp on empty too, so a ticker TipRanks genuinely has no experts for
    // rotates out instead of hogging a LIMIT slot every run. It still gets retried each
    // STALE_DAYS. Failures are NOT stamped — those are transient, retry next run.
    asOf[t] = now;
    if (++stamped % 20 === 0) saveAsOf();
  } catch (e) {
    fail++;
    console.log(`  ${t}: skip (${e.message})`);
  }
}
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (queue.length) await scrape(queue.shift());
}));
saveAsOf();
// tripwire: many table-less pages while the JSON has rows = TipRanks changed the page markup
if (tableless) console.log(`${tableless > 10 ? "::warning::" : ""}forecasts: ${tableless} page(s) had no analyst table despite JSON rows${tableless > 10 ? " — did the TipRanks forecast page markup change?" : ""}`);
console.log(`done: ${ok} written (${viaHtml} gained rows from the page, +${gained} rows total), ${empty} empty, ${fail} failed, ${fromCache} getData reused from the snapshot step`);
