// Backfill/refresh public/bullbear/<T>.json from TipRanks' stock-analysis payload
// (the AI Bulls Say / Bears Say thesis), via FlareSolverr — same Cloudflare-bypass the
// forecast scrape uses. Fills tickers MISSING a file or older than STALE_DAYS, stalest
// first so LIMIT rotates through the whole universe (pass ALL=1 to force everyone).
// Strictly additive + per-ticker failure-tolerant: a bad ticker is skipped, never fatal.
// ponytail: flareGet/extractJson are duplicated from scrape-forecasts.mjs on purpose —
// two ~15-line copies beat a shared module that would touch the known-good forecast
// script; factor into ci/flare.mjs if a third consumer appears.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const LIMIT = Number(process.env.LIMIT || 90);
const STALE_DAYS = Number(process.env.STALE_DAYS || 3);
const ALL = process.env.ALL === "1";
const OUT = "public/bullbear";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// payload.json comes back as JSON, sometimes wrapped in <pre> with HTML entities
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

// aiAnalysis.keyPoints[] -> { bull:[{t,b}], bear:[{t,b}] } (typically 3 + 3)
function toBullBear(data) {
  const kp = data?.models?.stocks_extra?.[0]?.aiAnalysis?.keyPoints || [];
  const pick = (s) =>
    kp.filter((x) => x.sentiment === s && x.title).map((x) => ({ t: x.title, b: x.description || "" }));
  return { bull: pick("bullish"), bear: pick("bearish") };
}

// the payload carries no content date, so stamp when WE refreshed it
const ASOF = new Date().toISOString().slice(0, 10);

const stocks = JSON.parse(readFileSync("src/data/stocks.json", "utf8"));
const staleBefore = Date.now() - STALE_DAYS * 864e5;
const age = (t) => { try { return statSync(`${OUT}/${t}.json`).mtimeMs; } catch { return 0; } };
const targets = stocks
  .map((s) => s.t)
  .filter((t) => ALL || !existsSync(`${OUT}/${t}.json`) || age(t) < staleBefore)
  .sort((a, b) => age(a) - age(b)) // stalest (incl. missing = 0) first
  .slice(0, LIMIT);

mkdirSync(OUT, { recursive: true });
console.log(`bullbear backfill: ${targets.length} ticker(s) (LIMIT=${LIMIT}, ALL=${ALL})`);
let ok = 0, empty = 0, fail = 0;
for (const t of targets) {
  try {
    const url = `https://www.tipranks.com/stocks/${encodeURIComponent(t.toLowerCase())}/stock-analysis/payload.json`;
    const bb = toBullBear(extractJson(await flareGet(url)));
    if (bb.bull.length || bb.bear.length) {
      writeFileSync(`${OUT}/${t}.json`, JSON.stringify({ ...bb, asOf: ASOF }));
      ok++;
      console.log(`  ${t}: ${bb.bull.length}↑ ${bb.bear.length}↓ ✓`);
    } else {
      empty++;
      console.log(`  ${t}: none`);
    }
  } catch (e) {
    fail++;
    console.log(`  ${t}: skip (${e.message})`);
  }
}
console.log(`done: ${ok} written, ${empty} empty, ${fail} failed`);
