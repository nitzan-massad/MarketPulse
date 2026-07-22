// Refreshes src/data/stocks.json + meta.json from TipRanks' screener API.
// Runs a real (headless) Chromium so it passes Cloudflare's JS challenge, then
// does the same in-page fetch the app's data was originally pulled with.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { computeKeep, rowFromGetData, forecastFields, fillNulls, nextLastSeen, KEEP_MAX_AGE_DAYS } from "../ci/keep.mjs";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const API =
  "https://www.tipranks.com/api/apps/stock/screener?country=us&method=screener&isPrimaryMarket=true&exchange=xnas&exchange=xnys&exchange=arcx&exchange=xase&exchange=bats&page=1&pageSize=120&sortDir=2";

// runs inside the page (has Cloudflare clearance) — mirrors the original pull
async function pull(page) {
  return page.evaluate(async (base) => {
    const sorts = [5, 2, 3]; // upside, smart score, market cap
    const SORT_KEY = { 5: "u", 2: "s" }; // mkt cap (3) still fetched for the universe, not tagged
    const seen = new Map();
    const membership = {}; // ticker -> ranking(s) it appears in
    const rnd = (x, p = 2) => (x == null ? null : +Number(x).toFixed(p));
    let total = null;
    for (const sb of sorts) {
      const r = await fetch(base + "&sortBy=" + sb, { headers: { accept: "application/json" } });
      const j = await r.json();
      if (total == null) total = j.totalCount ?? null;
      for (const it of j.items || []) {
        const t = it.tradingInformationData || {};
        const e = it.tipRanksEssentialData || {};
        const k = SORT_KEY[sb];
        if (t.ticker && k && !(membership[t.ticker] || []).includes(k))
          (membership[t.ticker] ??= []).push(k);
        if (seen.has(t.ticker)) continue;
        const bpt = e.bestPriceTargetData || {};
        const bc = e.bestAnalystsConsensusData || {};
        const d = bc.distribution || {};
        const ai = it.aiAnalystData || {};
        seen.set(t.ticker, {
          t: t.ticker, n: t.companyName, sec: t.sector?.name || null,
          px: rnd(t.lastClose), chg: rnd(t.priceChangePct != null ? t.priceChangePct * 100 : null, 2),
          pt: rnd(bpt.convertedPriceTarget), up: rnd(bpt.upside != null ? bpt.upside * 100 : null, 1),
          con: bc.analystConsensus?.name || null, b: d.buy || 0, h: d.hold || 0, s: d.sell || 0,
          ss: e.tipRanksSmartScoreData?.tipRanksSmartScore ?? null,
          ai: rnd(ai.overallScore, 1),
          air: (typeof ai.overallRating === "object" ? ai.overallRating?.name : ai.overallRating) ?? null,
          aipt: rnd(ai.priceTarget), mc: t.marketCap != null ? Math.round(t.marketCap / 1e6) : null,
          desc: t.description || null,
        });
      }
    }
    const rows = [...seen.values()];
    const aiArr = rows.map((r) => r.ai).filter((x) => x != null).sort((a, b) => a - b);
    const aiTop = aiArr.length ? aiArr[Math.ceil(0.9 * aiArr.length) - 1] : Infinity;
    for (const r of rows) if (r.ai != null && r.ai >= aiTop) (membership[r.t] ??= []).push("a");
    return { rows, total, membership };
  }, API);
}

// in-page per-ticker fetches (need the page's Cloudflare clearance)
async function fetchGetData(page, tickers) {
  return page.evaluate(async (ts) => {
    const out = [];
    for (const t of ts) {
      try {
        const r = await fetch(`https://www.tipranks.com/api/stocks/getData/?name=${encodeURIComponent(t)}`, { headers: { accept: "application/json" } });
        out.push(await r.json());
      } catch { out.push(null); }
    }
    return out;
  }, tickers);
}
async function fetchForecasts(page, tickers) {
  return page.evaluate(async (ts) => {
    const out = [];
    for (const t of ts) {
      try {
        const r = await fetch(`https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-forecast/payload.json`, { headers: { accept: "application/json" } });
        out.push(await r.json());
      } catch { out.push(null); }
    }
    return out;
  }, tickers);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, locale: "en-US" });
const page = await ctx.newPage();

let data = null;
for (let attempt = 1; attempt <= 4 && !(data && data.rows.length >= 50); attempt++) {
  try {
    await page.goto("https://www.tipranks.com/screener/stocks", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(6000); // let the Cloudflare challenge clear
    if (/just a moment/i.test(await page.title())) await page.waitForTimeout(8000);
    data = await pull(page);
    console.log(`attempt ${attempt}: ${data.rows.length} rows`);
  } catch (e) {
    console.error(`attempt ${attempt} failed:`, e.message);
    await page.waitForTimeout(5000);
  }
}
if (!data || data.rows.length < 50) {
  await browser.close();
  console.error("Did not get enough rows — leaving existing data untouched.");
  process.exit(1);
}

// --- keep set: pinned + non-expired previously-seen tickers, backfilled via getData
// when they fall out of the top-120 sorts (capped, most-stale-first). See ci/keep.mjs.
const seen = new Map(data.rows.map((r) => [r.t, r]));
const membership = data.membership; // ticker -> array of ranking flags
const inPull = new Set(seen.keys());

let pinned = [];
try { pinned = JSON.parse(readFileSync("src/data/pinned.json", "utf8")); } catch { /* none */ }
let prevSeen = {};
try { prevSeen = JSON.parse(readFileSync("src/data/seen.json", "utf8")); } catch { /* first run */ }
const prevRows = new Map();
try { for (const r of JSON.parse(readFileSync("src/data/stocks.json", "utf8"))) prevRows.set(r.t, r); } catch { /* first run */ }

const BACKFILL_LIMIT = Number(process.env.BACKFILL_LIMIT || 300);
const { keep, dropped } = computeKeep(pinned, prevSeen, Date.now(), KEEP_MAX_AGE_DAYS);
const lsMs = (t) => Date.parse(prevSeen[t]?.ls || prevSeen[t]?.d || "") || 0;
const missing = [...keep].filter((t) => !inPull.has(t)).sort((a, b) => lsMs(a) - lsMs(b));
const toFetch = missing.slice(0, BACKFILL_LIMIT);
const fetched = toFetch.length ? await fetchGetData(page, toFetch) : [];

let refreshed = 0, carried = 0;
const carry = (t) => { const prev = prevRows.get(t); if (prev) { seen.set(t, prev); carried++; } };
fetched.forEach((j, i) => {
  const t = toFetch[i];
  const row = j && rowFromGetData(j, prevRows.get(t) || {});
  if (row && row.t) { seen.set(t, row); refreshed++; } else carry(t);
});
for (const t of missing.slice(BACKFILL_LIMIT)) carry(t); // over cap — keep last-known row
for (const t of pinned) if (seen.has(t) && !(membership[t] || []).includes("p")) (membership[t] ??= []).push("p");
console.log(`keep set: ${keep.size} (${refreshed} refreshed, ${carried} carried, ${dropped.length} expired)`);

// enrich rows still missing AI-score/sector via the per-ticker stock-forecast payload
// (pins & brand-new arrivals first; fills blanks only; capped) — needs the page open.
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 300);
const prio = (t) => (pinned.includes(t) ? 0 : inPull.has(t) && !prevSeen[t] ? 1 : 2);
const enrichList = [...seen.entries()]
  .filter(([, r]) => r.ai == null || r.sec == null)
  .sort((a, b) => prio(a[0]) - prio(b[0]))
  .slice(0, ENRICH_LIMIT)
  .map(([t]) => t);
const forecasts = enrichList.length ? await fetchForecasts(page, enrichList) : [];
await browser.close();
let enriched = 0;
forecasts.forEach((fj, i) => { if (fj) { fillNulls(seen.get(enrichList[i]), forecastFields(fj, enrichList[i])); enriched++; } });
console.log(`enriched ${enriched}/${enrichList.length} row(s) via stock-forecast`);

mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/stocks.json", JSON.stringify([...seen.values()]));
writeFileSync(
  "src/data/meta.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), universe: data.total, shown: seen.size }, null, 2) + "\n",
);
console.log(`wrote ${seen.size} rows; universe ${data.total}`);

// maintain the seen tracker (freeze first-seen fields, update `ls` for expiry) — see refresh-data-ci.mjs
const today = new Date().toISOString(); // full timestamp so New Arrivals can show hours-ago for fresh names
const firstSeen = {};
for (const [t, r] of seen) {
  const prev = prevSeen[t];
  if (prev) firstSeen[t] = { ...prev, ls: nextLastSeen(prev, inPull.has(t), today) };
  else firstSeen[t] = { d: inPull.has(t) ? today : "baseline", ls: today, ss: r.ss, ai: r.ai, con: r.con, l: membership[t] || [] };
}
writeFileSync("src/data/seen.json", JSON.stringify(firstSeen));
