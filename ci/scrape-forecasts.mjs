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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseForecastHtml, withStars } from "./forecast-html.mjs";
import { mergeForecasts, shouldFetchPage } from "./forecast-merge.mjs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const LIMIT = Number(process.env.LIMIT || 90);
const STALE_DAYS = Number(process.env.STALE_DAYS || 3);
const ALL = process.env.ALL === "1";
// Union the SSR page into the JSON path instead of only falling back to it when JSON gave
// nothing. Default ON; SSR_MERGE=0 is an exact rollback to the old fallback behaviour without
// a revert. Costs one page fetch per ticker in the rotation (~+8 min, ~+34 MB per run,
// measured over 418 tickers) and buys +42.6% rows with 83% of tickers getting fresher data.
// See ci/forecast-merge.mjs and ci/PLAN-ssr-merge.md.
const MERGE = process.env.SSR_MERGE !== "0";
// Overridable so a live run can be pointed at a throwaway directory to verify the merge
// against real TipRanks pages without touching the committed files. CI never sets it.
const OUT = process.env.OUT || "public/forecasts";
const ASOF = `${OUT}/_asOf.json`; // { ticker: ISO } — build-reviews-recent skips it (not an array)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATING = { 1: "Buy", 2: "Hold", 3: "Sell" };

async function flareGet(url, tries = 6) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(FS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
      });
      const j = await r.json();
      if (j.status === "ok" && j.solution) return j.solution.response || "";
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
const targets = stocks
  .map((s) => s.t)
  .filter((t) => ALL || age(t) < staleBefore)
  .sort((a, b) => age(a) - age(b)) // stalest (incl. never-fetched = 0) first
  .slice(0, LIMIT);

mkdirSync(OUT, { recursive: true });
console.log(`forecasts backfill: ${targets.length} ticker(s) (LIMIT=${LIMIT}, ALL=${ALL}, SSR_MERGE=${MERGE ? 1 : 0})`);
const now = new Date().toISOString();
let ok = 0, empty = 0, fail = 0, viaHtml = 0, gained = 0;
for (const t of targets) {
  try {
    const html = await flareGet(`https://www.tipranks.com/api/stocks/getData/?name=${encodeURIComponent(t)}`);
    const data = extractJson(html);
    let fc = toForecasts(data);
    const jsonCount = fc.length;
    // The API paywall-anonymizes its FRESHEST rows, so the JSON path is systematically behind
    // on every ticker — not just the micro-caps where it returned nothing. The SSR page renders
    // names and targets in full, so we union the two rather than only falling back when JSON
    // came up empty. See ci/forecast-merge.mjs for the merge rules and the measured effect.
    if (shouldFetchPage(fc, data, MERGE)) {
      const page = await flareGet(`https://www.tipranks.com/stocks/${encodeURIComponent(t.toLowerCase())}/forecast`);
      const rows = withStars(parseForecastHtml(page), data);
      if (MERGE) {
        // Strictly additive: a page that parses to nothing leaves the JSON result untouched.
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
  } catch (e) {
    fail++;
    console.log(`  ${t}: skip (${e.message})`);
  }
}
writeFileSync(ASOF, JSON.stringify(asOf, null, 1));
console.log(`done: ${ok} written (${viaHtml} gained rows from the page, +${gained} rows total), ${empty} empty, ${fail} failed`);
