// Backfill/refresh public/forecasts/<T>.json from TipRanks' getData `experts`
// feed, via FlareSolverr (same Cloudflare-bypass the data refresh uses). Strictly
// additive + per-ticker failure-tolerant: a bad ticker is skipped, never fatal, so
// this can't break the main refresh. By default only fills tickers that are MISSING
// a file (pass ALL=1 to re-scrape everyone). Cap with LIMIT (default 60).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const LIMIT = Number(process.env.LIMIT || 60);
const ALL = process.env.ALL === "1";
const OUT = "public/forecasts";
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
const targets = stocks
  .map((s) => s.t)
  .filter((t) => ALL || !existsSync(`${OUT}/${t}.json`))
  .slice(0, LIMIT);

mkdirSync(OUT, { recursive: true });
console.log(`forecasts backfill: ${targets.length} ticker(s) (LIMIT=${LIMIT}, ALL=${ALL})`);
let ok = 0, empty = 0, fail = 0;
for (const t of targets) {
  try {
    const html = await flareGet(`https://www.tipranks.com/api/stocks/getData/?name=${encodeURIComponent(t)}`);
    const fc = toForecasts(extractJson(html));
    if (fc.length) { writeFileSync(`${OUT}/${t}.json`, JSON.stringify(fc)); ok++; console.log(`  ${t}: ${fc.length} ✓`); }
    else { empty++; console.log(`  ${t}: none`); }
  } catch (e) {
    fail++;
    console.log(`  ${t}: skip (${e.message})`);
  }
}
console.log(`done: ${ok} written, ${empty} empty, ${fail} failed`);
