// CI data refresh via FlareSolverr — a proxy that drives an undetected browser
// to solve Cloudflare's challenge from GitHub's datacenter IP, then returns the
// page body. We request the screener API through it and parse the JSON out.
// (Local manual refresh uses scripts/refresh-data.mjs with Playwright instead.)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { computeKeep, rowFromGetData, forecastFields, fillNulls, nextLastSeen, KEEP_MAX_AGE_DAYS } from "./keep.mjs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const API =
  "https://www.tipranks.com/api/apps/stock/screener?country=us&method=screener&isPrimaryMarket=true&exchange=xnas&exchange=xnys&exchange=arcx&exchange=xase&exchange=bats&page=1&pageSize=120&sortDir=2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (x, p = 2) => (x == null ? null : +Number(x).toFixed(p));

// POST to FlareSolverr; retries also absorb the service's ~30-60s cold start.
async function flareGet(url, tries = 8) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(FS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
      });
      const j = await r.json();
      if (j.status === "ok" && j.solution) return j.solution;
      throw new Error(j.message || "status != ok");
    } catch (e) {
      lastErr = e;
      console.log(`flaresolverr try ${i}/${tries}: ${e.message}`);
      await sleep(8000);
    }
  }
  throw lastErr;
}

// FlareSolverr returns the rendered page; a JSON endpoint comes back wrapped in
// <pre>…</pre> with HTML-escaped entities. Pull the JSON object out of it.
function extractJson(html) {
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  for (const cand of [pre && pre[1], html].filter(Boolean)) {
    const decoded = cand
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const m = decoded.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try { return JSON.parse(m[0]); } catch { /* try next candidate */ }
  }
  throw new Error("could not extract JSON from FlareSolverr response");
}

const seen = new Map();
const SORT_KEY = { 5: "u", 2: "s" }; // upside / smart score (sortBy 3 = mkt cap still fetched for the universe, but not tagged as a list)
const membership = {}; // ticker -> Set of ranking(s) it appears in
let total = null;
for (const sb of [5, 2, 3]) {
  const sol = await flareGet(API + "&sortBy=" + sb);
  const j = extractJson(sol.response);
  if (total == null) total = j.totalCount ?? null;
  for (const it of j.items || []) {
    const t = it.tradingInformationData || {};
    const e = it.tipRanksEssentialData || {};
    if (t.ticker && SORT_KEY[sb]) (membership[t.ticker] ??= new Set()).add(SORT_KEY[sb]);
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
  console.log(`sortBy=${sb}: ${seen.size} unique rows so far`);
}

if (seen.size < 50) {
  console.error(`only ${seen.size} rows — leaving existing data untouched.`);
  process.exit(1);
}
const inPull = new Set(seen.keys()); // tickers the dynamic screener returned THIS run

// --- keep set: pinned + non-expired previously-seen tickers, refreshed even when
// they fall out of the top-120 sorts. Missing ones are backfilled via getData
// (capped, most-stale-first); the rest carry their last-known row. See ci/keep.mjs.
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
let refreshed = 0, carried = 0;
for (const t of missing) {
  const prev = prevRows.get(t) || {};
  if (refreshed < BACKFILL_LIMIT) {
    try {
      const sol = await flareGet(`https://www.tipranks.com/api/stocks/getData/?name=${encodeURIComponent(t)}`);
      const row = rowFromGetData(extractJson(sol.response), prev);
      if (row.t) { seen.set(t, row); refreshed++; continue; }
    } catch (e) { console.log(`  keep ${t}: getData skip (${e.message})`); }
  }
  if (prev.t) { seen.set(t, prev); carried++; } // over cap or fetch failed — keep last-known row
}
for (const t of pinned) if (seen.has(t)) (membership[t] ??= new Set()).add("p");
console.log(`keep set: ${keep.size} (${refreshed} refreshed, ${carried} carried, ${dropped.length} expired)`);

// Enrich from the per-ticker stock-forecast payload — the only per-ticker source for the
// AI-analyst score/rating/target and the sector name. Two jobs:
//   1. FILL blanks: off-list pins and brand-new arrivals whose screener row lacks AI data.
//   2. CORRECT carried AI data: rows outside this run's pull come from rowFromGetData,
//      which carries ai/air/aipt verbatim (ci/keep.mjs:123-125 — getData genuinely has no
//      AI-analyst fields, so carrying beats blanking). Nothing else ever re-checks them.
//      Selecting on "needs a null filled" alone made that permanent: a carried row has
//      both non-null, so it could never be picked, and a downgrade stayed invisible until
//      the ticker re-entered the pull (UNP showed "Outperform" for ~10 days / ~46 runs
//      after its 2026-07-24 downgrade). Hence `|| !inPull.has(t)` below.
// The AI trio therefore OVERWRITES; fillNulls handles the rest. fillNulls cannot correct
// a stale non-null, and only a value the payload actually supplies may replace one.
// SCALE — this overwrite requires forecastFields to emit `ai` on the screener's 0-100
// scale. It does (ci/keep.mjs), and `node ci/test-ai-scale.mjs` guards it. Were the old
// `/10` ever reinstated, the overwrite would drag every off-pull row onto 0-10 and the
// UI's scoreColor(s.ai, 100) would paint them dark — the fill path already stranded
// AAPL at 8.2 and TER at 7.8 that way, and this pass is what repaired them.
// Cost bound: ENRICH_LIMIT fetches/run, oldest-AI-first, and `ea` (enriched-at, stamped
// in the seen tracker below) rotates the queue instead of re-picking the same head — lsMs
// alone never moves while a ticker is off-pull. Worst-case AI staleness is therefore
// ceil(offPull / (ENRICH_LIMIT - sticky)) runs x the 5h cron. Measured 2026-08-03: 73
// off-pull, and 9 sticky slots that re-cost every run (2 pins by design + 7 rows whose
// forecast payload carries no AI report at all, so they stay blank and keep re-queuing)
// → 31 fresh slots/run → 3 runs ≈ 15h, well inside a rating-change news cycle.
// The off-pull set grows monotonically against KEEP_MAX_AGE_DAYS — raise ENRICH_LIMIT
// once it passes ~120, or the bound stretches past a day.
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT || 40);
// Exactly the fields rowFromGetData carries from the previous row because getData does
// not ship them (see ci/keep.mjs) — so enrich must OVERWRITE these, not fill them.
// `chg` belongs here for the same reason as the AI trio and was the field this pass
// originally forgot: it is Day %, the most time-sensitive column in the table, and it
// was frozen on every off-pull row. Sampled 12/12 wrong, sign wrong in 8 — TER showed
// +12.07 against a live +0.60, ARTV +9.29 against -3.16. The payload we already fetch
// carries it (keep.mjs forecastFields), so repairing it costs no extra request.
const CARRIED_FIELDS = ["ai", "air", "aipt", "chg"];
// When this row's AI trio was last known-good: in the pull (the screener ships
// aiAnalystData) or enriched. Reuses lsMs so there is one age concept, not two.
const aiFreshMs = (t) => Math.max(lsMs(t), Date.parse(prevSeen[t]?.ea || "") || 0);
const needsFill = (r) => r.ai == null || r.sec == null;
const prio = (t, r) => (pinned.includes(t) ? 0 : needsFill(r) ? 1 : 2); // pins, then blanks (incl. new arrivals), then stale carries
const enrichEligible = [...seen.entries()].filter(([t, r]) => needsFill(r) || !inPull.has(t));
const enrichList = enrichEligible
  .sort((a, b) => prio(a[0], a[1]) - prio(b[0], b[1]) || aiFreshMs(a[0]) - aiFreshMs(b[0]))
  .slice(0, ENRICH_LIMIT)
  .map(([t]) => t);
let enriched = 0;
const enrichTried = new Set();
for (const t of enrichList) {
  enrichTried.add(t); // stamp the attempt, not the success: a ticker with no forecast payload must not block the queue head forever
  try {
    const sol = await flareGet(`https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-forecast/payload.json`);
    const f = forecastFields(extractJson(sol.response), t);
    const row = fillNulls(seen.get(t), f);
    // `!= null` alone is not enough: rnd() yields NaN on a reshaped/non-numeric score, and
    // JSON.stringify(NaN) is null — so the "never blank a good value" promise would break
    // exactly when the payload changes shape. Carry on reshape, blank only on an explicit
    // null, matching the doctrine ssFromGetData states in ci/keep.mjs.
    for (const k of CARRIED_FIELDS) {
      const v = f[k];
      if (v == null) continue;
      if (typeof v === "number" && !Number.isFinite(v)) continue;
      row[k] = v;
    }
    enriched++;
  } catch (e) { console.log(`  enrich ${t}: forecast skip (${e.message})`); }
}
const offPull = enrichEligible.filter(([t]) => !inPull.has(t)).length; // count BEFORE the slice — the old log counted after, so it saturated at ENRICH_LIMIT and read 36 when 73 were off-pull
console.log(`enriched ${enriched}/${enrichList.length} row(s) via stock-forecast (${offPull} off-pull, cap ${ENRICH_LIMIT})`);
// Nothing else watches this: once eligible rows outpace the cap, AI/chg staleness quietly
// grows past a day again. Off-pull grew 3 -> 73 in 12 days (~5.7/day), so this WILL fire.
if (enrichEligible.length > ENRICH_LIMIT * 2) {
  console.log(`  WARNING: ${enrichEligible.length} rows need enriching but the cap is ${ENRICH_LIMIT}`
    + ` — full rotation now takes ~${Math.ceil(enrichEligible.length / ENRICH_LIMIT)} runs. Raise ENRICH_LIMIT.`);
}

mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/stocks.json", JSON.stringify([...seen.values()]));
writeFileSync(
  "src/data/meta.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), universe: total, shown: seen.size }, null, 2) + "\n",
);
console.log(`wrote ${seen.size} rows; universe ${total}`);

// maintain the seen tracker: freeze first-seen fields (d/ss/ai/con/l), stamp
// brand-new tickers, and update `ls` (last-seen-in-dynamic-list) which drives expiry.
const today = new Date().toISOString(); // full timestamp so New Arrivals can show hours-ago for fresh names
const firstSeen = {};
// AI "top 10%" flag — no screener sort exists for AI, so use the 90th-pct cut (as Best of the Best does)
const aiArr = [...seen.values()].map((r) => r.ai).filter((x) => x != null).sort((a, b) => a - b);
const aiTop = aiArr.length ? aiArr[Math.ceil(0.9 * aiArr.length) - 1] : Infinity;
for (const [t, r] of seen) if (r.ai != null && r.ai >= aiTop) (membership[t] ??= new Set()).add("a");
for (const [t, r] of seen) {
  const prev = prevSeen[t];
  if (prev) firstSeen[t] = { ...prev, ls: nextLastSeen(prev, inPull.has(t), today) };
  // brand-new: dynamic arrivals get today's date (New Arrivals); pins-only get "baseline" so they don't flood it
  else firstSeen[t] = { d: inPull.has(t) ? today : "baseline", ls: today, ss: r.ss, ai: r.ai, con: r.con, l: [...(membership[t] || [])] };
}
// `ea` = AI trio last re-checked. Sends this run's picks to the back of the enrich queue
// so the off-pull set rotates through it; `ls` alone is frozen while a ticker is off-pull.
for (const t of enrichTried) if (firstSeen[t]) firstSeen[t].ea = today;
writeFileSync("src/data/seen.json", JSON.stringify(firstSeen));
const freshCount = Object.values(firstSeen).filter((v) => v.d !== "baseline").length;
console.log(`seen.json: ${Object.keys(firstSeen).length} tickers, ${freshCount} dated`);
