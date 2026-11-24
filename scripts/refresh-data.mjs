// Refreshes src/data/stocks.json + meta.json from the data provider's screener API.
// Runs a real (headless) Chromium so it passes Cloudflare's JS challenge, then
// does the same in-page fetch the app's data was originally pulled with.
import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { UNIVERSE_URL, universeMap, universeItems, ambiguousCarried, planBackfill } from "../ci/backfill-plan.mjs";
import { health } from "../ci/src-fetch.mjs";
import { srcUrl } from "../ci/source.mjs";
import { computeKeep, rowFromScreener, rowFromOutlook, mergeRow, refreshedRow, forecastFields, applyForecast, enrichQueue, nextLastSeen, KEEP_MAX_AGE_DAYS } from "../ci/keep.mjs";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const API = srcUrl("screener");

// runs inside the page (has Cloudflare clearance) — mirrors the original pull
async function pull(page) {
  return page.evaluate(async (base) => {
    const sorts = [5, 2, 3]; // upside, Pulse Score, market cap
    const SORT_KEY = { 5: "u", 2: "s" }; // mkt cap (3) still fetched for the universe, not tagged
    const seen = new Set();
    const items = []; // raw screener items, first occurrence per ticker
    const membership = {}; // ticker -> ranking(s) it appears in
    let total = null;
    for (const sb of sorts) {
      const r = await fetch(base + "&sortBy=" + sb, { headers: { accept: "application/json" } });
      const j = await r.json();
      if (total == null) total = j.totalCount ?? null;
      for (const it of j.items || []) {
        const t = it.tradingInformationData || {};
        const k = SORT_KEY[sb];
        if (t.ticker && k && !(membership[t.ticker] || []).includes(k))
          (membership[t.ticker] ??= []).push(k);
        if (seen.has(t.ticker)) continue;
        seen.add(t.ticker);
        items.push(it); // mapped in Node (rowFromScreener) — this function has no module scope
      }
    }
    return { items, total, membership };
  }, API);
}

// in-page fetches (need the page's Cloudflare clearance). The universe is one ~77 MB call; only
// the `want` tickers' items (every listing of each, for universeMap's tie-break) cross CDP back to
// Node — the same filter as itemsFor in ci/backfill-plan.mjs, inlined because this function runs in
// the page with no module scope. A body with no `items` array comes back as is, so universeItems
// (shared with ci/refresh-data-ci.mjs) still throws on a reshape and it reaches health().
async function fetchUniverse(page, want) {
  return universeItems(await page.evaluate(async ({ url, want }) => {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const j = await r.json();
    if (!Array.isArray(j?.items)) return j;
    const w = new Set(want);
    return { items: j.items.filter((it) => w.has(it?.tradingInformationData?.ticker)) };
  }, { url: UNIVERSE_URL, want }));
}
async function fetchOutlook(page, tickers) {
  return page.evaluate(async (ts) => {
    const out = [];
    for (const t of ts) {
      try {
        const r = await fetch(t, { headers: { accept: "application/json" } });
        out.push(await r.json());
      } catch { out.push(null); }
    }
    return out;
  }, tickers.map((t) => srcUrl("analysis", t)));
}
async function fetchForecasts(page, tickers) {
  return page.evaluate(async (ts) => {
    const out = [];
    for (const t of ts) {
      try {
        const r = await fetch(t, { headers: { accept: "application/json" } });
        out.push(await r.json());
      } catch { out.push(null); }
    }
    return out;
  }, tickers.map((t) => srcUrl("forecast", t)));
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, locale: "en-US" });
const page = await ctx.newPage();

let data = null;
for (let attempt = 1; attempt <= 4 && !(data && data.items.length >= 50); attempt++) {
  try {
    await page.goto(srcUrl("screenerPage"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(6000); // let the Cloudflare challenge clear
    if (/just a moment/i.test(await page.title())) await page.waitForTimeout(8000);
    data = await pull(page);
    console.log(`attempt ${attempt}: ${data.items.length} rows`);
  } catch (e) {
    console.error(`attempt ${attempt} failed:`, e.message);
    await page.waitForTimeout(5000);
  }
}
if (!data || data.items.length < 50) {
  await browser.close();
  console.error("Did not get enough rows — leaving existing data untouched.");
  process.exit(1);
}

// --- keep set: pinned + non-expired previously-seen tickers, backfilled via the universe pull
// when they fall out of the top-120 sorts (capped, most-stale-first). See ci/keep.mjs.
// last-known rows: the mapper's `undefined` ("can't see it") falls back to these
const prevRows = new Map();
try { for (const r of JSON.parse(readFileSync("src/data/stocks.json", "utf8"))) prevRows.set(r.t, r); } catch { /* first run */ }
// the page returns raw items; they are mapped here, through the same functions as the CI refresh
const mapped = data.items.map((it) => rowFromScreener(it, { inPull: true }));
const seen = new Map(mapped.map((r) => [r.t, mergeRow(prevRows.get(r.t), r)]));
const membership = data.membership; // ticker -> array of ranking flags
// AI-analyst top decile gets the "a" flag (from the screener's own scores, before any carry-over)
{
  const aiArr = mapped.map((r) => r.ai).filter((x) => x != null).sort((a, b) => a - b);
  const aiTop = aiArr.length ? aiArr[Math.ceil(0.9 * aiArr.length) - 1] : Infinity;
  for (const r of mapped) if (r.ai != null && r.ai >= aiTop) (membership[r.t] ??= []).push("a");
}
const inPull = new Set(seen.keys());

let pinned = [];
try { pinned = JSON.parse(readFileSync("src/data/pinned.json", "utf8")); } catch { /* none */ }
// watchlists + recent views (keepalive) and "Track this stock" requests (tracked) — see computeKeep
const alive = { tracked: {} };
try { alive.tracked = JSON.parse(readFileSync("src/data/tracked.json", "utf8")); } catch { /* none */ }
try { Object.assign(alive, JSON.parse(readFileSync("src/data/keepalive.json", "utf8"))); } catch { /* none */ }
let prevSeen = {};
try { prevSeen = JSON.parse(readFileSync("src/data/seen.json", "utf8")); } catch { /* first run */ }

const BACKFILL_LIMIT = Number(process.env.BACKFILL_LIMIT || 300);
const { keep, dropped } = computeKeep(pinned, prevSeen, Date.now(), KEEP_MAX_AGE_DAYS, alive);
const lsMs = (t) => Date.parse(prevSeen[t]?.ls || prevSeen[t]?.d || "") || 0;
// Not lsMs: `ls` is frozen for off-pull tickers and every entry here IS off-pull, so the
// order would never change and the tail past BACKFILL_LIMIT would never be fetched. `ba`
// (backfilled-at) advances. Mirrors ci/refresh-data-ci.mjs.
const baMs = (t) => Date.parse(prevSeen[t]?.ba || "") || lsMs(t);
const missing = [...keep].filter((t) => !inPull.has(t)).sort((a, b) => baMs(a) - baMs(b));
let universe = new Map();
let skipped = []; // ambiguous duplicates: a health line only if they end up carried (below)
if (missing.length) {
  try {
    const ambiguous = [];
    universe = universeMap(await fetchUniverse(page, missing), { prev: prevRows, ambiguous });
    // duplicate ticker, no primary listing, no name match: skipped (payload/carry), never guessed
    skipped = ambiguous;
    if (skipped.length) console.log(`  universe: ambiguous duplicates skipped (payload/carry): ${skipped.join(",")}`);
  } catch (e) { health("universe pull failed"); console.error(`universe pull failed (${e.message}): backfilling from payloads only`); }
}
const { fromUniverse, needPayload } = planBackfill(missing, universe);
const toFetch = [];
let fromUni = 0, refreshed = 0, carried = 0;
const carriedSet = new Set();
const carry = (t) => { const prev = prevRows.get(t); if (prev) { seen.set(t, prev); carried++; carriedSet.add(t); } };
// refreshedRow, not mergeRow: a source with no row for t is a carry, never a refresh (ci/keep.mjs)
for (const t of fromUniverse) {
  const row = refreshedRow(prevRows.get(t), rowFromScreener(universe.get(t), { inPull: false }));
  if (row) { seen.set(t, row); fromUni++; toFetch.push(t); } else needPayload.push(t);
}
const payloadList = needPayload.slice(0, BACKFILL_LIMIT);
const fetched = payloadList.length ? await fetchOutlook(page, payloadList) : [];
payloadList.forEach((t, i) => {
  toFetch.push(t); // attempt, not success — for the `ba` rotation stamp
  const row = fetched[i] && refreshedRow(prevRows.get(t), rowFromOutlook(fetched[i], t));
  if (row) { seen.set(t, row); refreshed++; } else carry(t);
});
for (const t of needPayload.slice(BACKFILL_LIMIT)) carry(t); // over cap — keep last-known row
const ambCarried = ambiguousCarried(skipped, carriedSet);
if (ambCarried.length) health(`universe: ${ambCarried.length} ambiguous duplicate ticker(s) carried: ${ambCarried.join(",")}`);
for (const t of pinned) if (seen.has(t) && !(membership[t] || []).includes("p")) (membership[t] ??= []).push("p");
console.log(`backfill: ${fromUni} universe, ${refreshed} payload, ${carried} carried (of ${missing.length} missing)`);
console.log(`keep set: ${keep.size} (${fromUni + refreshed} refreshed, ${carried} carried, ${dropped.length} expired)`);

// Enrich from the per-ticker stock-forecast payload. The selection, the cap and the
// application rules are IMPORTED from ci/keep.mjs, not copied: this script once held its
// own copy, diverged, and silently reproduced a bug CI had already fixed — it selected only
// rows with a NULL ai/sec, so an off-pull ticker whose ai/air/aipt/chg were CARRIED from
// the previous row was never eligible. Locally that meant UNP kept showing "Outperform"/74
// for days after the provider downgraded it to Neutral/69. Only the Playwright fetch is local.
const aiFreshMs = (t) => Math.max(lsMs(t), Date.parse(prevSeen[t]?.ea || "") || 0);
const { list: enrichList, cap: ENRICH_LIMIT } =
  enrichQueue(seen.entries(), { inPull, pinned, aiFreshMs, limit: process.env.ENRICH_LIMIT });
const forecasts = enrichList.length ? await fetchForecasts(page, enrichList) : [];
await browser.close();
let enriched = 0, noReport = 0;
const enrichTried = new Set(enrichList); // attempt, not success — so `ea` rotates the queue
forecasts.forEach((fj, i) => {
  if (!fj) return;
  const t = enrichList[i];
  const f = forecastFields(fj, t);
  if (!Object.keys(f).length) { noReport++; return; }
  const landed = applyForecast(seen.get(t), f);
  if (landed === "partial") console.log(`  enrich ${t}: partial AI report, trio left as it was`);
  if (landed === "fill") console.log(`  enrich ${t}: partial AI report, filled a blank trio`);
  enriched++;
});
console.log(`enriched ${enriched}/${enrichList.length} row(s) via stock-forecast (cap ${ENRICH_LIMIT}, ${noReport} with no report)`);

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
// same rotation stamp CI writes — without it a local run resets the enrich queue clock
for (const t of enrichTried) if (firstSeen[t]) firstSeen[t].ea = today;
for (const t of toFetch) if (firstSeen[t]) firstSeen[t].ba = today;
writeFileSync("src/data/seen.json", JSON.stringify(firstSeen));
