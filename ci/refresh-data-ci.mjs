// CI data refresh via FlareSolverr — a proxy that drives an undetected browser
// to solve Cloudflare's challenge from GitHub's datacenter IP, then returns the
// page body. We request the screener API through it and parse the JSON out.
// (Local manual refresh uses scripts/refresh-data.mjs with Playwright instead.)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { computeKeep, rowFromGetData, forecastFields, fillNulls, nextLastSeen, rndPx, KEEP_MAX_AGE_DAYS } from "./keep.mjs";

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
      px: rndPx(t.lastClose), chg: rnd(t.priceChangePct != null ? t.priceChangePct * 100 : null, 2),
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
// #6 — DO NOT sort this queue on lsMs. `ls` is frozen while a ticker is off-pull (that is
// what nextLastSeen does), and every ticker in `missing` is BY DEFINITION off-pull — so the
// ordering never changes and, once `missing` exceeds BACKFILL_LIMIT, the tail past the cap is
// never fetched again. Same trap as file mtime and as the enrich queue. `ba` (backfilled-at,
// stamped in the seen tracker below) advances, so a fetched ticker goes to the back.
const baMs = (t) => Date.parse(prevSeen[t]?.ba || "") || lsMs(t);
const missing = [...keep].filter((t) => !inPull.has(t)).sort((a, b) => baMs(a) - baMs(b));
const backfillTried = new Set();
let refreshed = 0, carried = 0;
for (const t of missing) {
  const prev = prevRows.get(t) || {};
  if (refreshed < BACKFILL_LIMIT) {
    backfillTried.add(t); // attempt, not success — a permanently-dead ticker must not camp at the head
    try {
      const sol = await flareGet(`https://www.tipranks.com/api/stocks/getData/?name=${encodeURIComponent(t)}`);
      const row = rowFromGetData(extractJson(sol.response), prev);
      if (row.t) { seen.set(t, row); refreshed++; continue; }
    } catch (e) { console.log(`  keep ${t}: getData skip (${e.message})`); }
  }
  if (prev.t) { seen.set(t, prev); carried++; } // over cap or fetch failed — keep last-known row
}
for (const t of pinned) if (seen.has(t)) (membership[t] ??= new Set()).add("p");
console.log(`keep set: ${keep.size} (${refreshed} refreshed, ${carried} carried, ${dropped.length} expired, cap ${BACKFILL_LIMIT})`);
// The second cliff: past the cap, prices/consensus/ss go stale too, not just AI data.
// Off-pull grew 3 -> 73 in 12 days, so this fires around Sept-Oct 2026 without a bump.
if (missing.length > BACKFILL_LIMIT * 0.8) {
  console.log(`  WARNING: ${missing.length} kept tickers are off-pull against a cap of ${BACKFILL_LIMIT}`
    + ` — at the cap, rows past it serve stale prices. Raise BACKFILL_LIMIT or lower KEEP_MAX_AGE_DAYS.`);
}

// Enrich from the per-ticker stock-forecast payload — the only per-ticker source for the
// AI-analyst score/rating/target and the sector name. Two jobs: FILL blanks (off-list pins,
// brand-new arrivals), and CORRECT the ai/air/aipt/chg that rowFromGetData carries verbatim
// for off-pull rows — nothing else ever re-checks those, so the AI trio OVERWRITES here
// while fillNulls handles the rest. Why each of those is the way it is (the UNP downgrade
// that stayed visible for 46 runs, the 0-100 scale this overwrite depends on, the queue
// rotation and its cost bound): ci/README.md → Enrich.
const ENRICH_TARGET_RUNS = 3; // full rotation within 3 runs = ~15h at the 5h cron
// Ceiling, because the derived cap below scales with a set that only grows and every unit
// is one FlareSolverr fetch on top of BACKFILL_LIMIT. 120/run rotates the whole ~351-row
// universe inside ENRICH_TARGET_RUNS, so hitting this means the keep set itself is the
// problem — and the WARNING below can then actually fire, which without a ceiling it
// mathematically never could (cap = eligible/3 makes `eligible > cap * 3` false always).
const ENRICH_MAX = 120;
// When this row's AI trio was last known-good: in the pull (the screener ships
// aiAnalystData) or enriched. Reuses lsMs so there is one age concept, not two.
const aiFreshMs = (t) => Math.max(lsMs(t), Date.parse(prevSeen[t]?.ea || "") || 0);
const needsFill = (r) => r.ai == null || r.sec == null;
// A pin is prio 0 only when it is actually STALE. Unconditional prio 0 re-fetched both pins
// every run and, worse, sticky slots scale with the pin count: if pins + permanent blanks
// ever reached the cap, prio-2 rotation would stop dead and staleness would silently return
// to unbounded. Fresh pins fall through to the queue.
const STALE_MS = 3 * 864e5;
const prio = (t, r) => (pinned.includes(t) && Date.now() - aiFreshMs(t) > STALE_MS ? 0 : needsFill(r) ? 1 : 2);
const enrichEligible = [...seen.entries()].filter(([t, r]) => needsFill(r) || !inPull.has(t));
// A FIXED cap cannot bound a growing set (at 40, with off-pull growing ~5.7/day, the 15h
// worst case decays to ~50h within six weeks), so derive it — floor 40 for small sets,
// ceiling ENRICH_MAX for cost. An explicit env value still wins, as the tests rely on.
const ENRICH_LIMIT = Number(process.env.ENRICH_LIMIT)
  || Math.min(ENRICH_MAX, Math.max(40, Math.ceil(enrichEligible.length / ENRICH_TARGET_RUNS)));
const enrichList = enrichEligible
  .sort((a, b) => prio(a[0], a[1]) - prio(b[0], b[1]) || aiFreshMs(a[0]) - aiFreshMs(b[0]))
  .slice(0, ENRICH_LIMIT)
  .map(([t]) => t);
let enriched = 0, noReport = 0;
const enrichTried = new Set();
for (const t of enrichList) {
  enrichTried.add(t); // stamp the attempt, not the success: a ticker with no forecast payload must not block the queue head forever
  try {
    const sol = await flareGet(`https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-forecast/payload.json`);
    const f = forecastFields(extractJson(sol.response), t);
    // #9 — an empty result was a SILENT no-op that still counted as enriched and still
    // stamped `ea`, so the row rotated to the back with no signal and could never re-queue
    // as prio-1. Usually a bundle/_id mismatch, i.e. our bug, not missing data.
    if (!Object.keys(f).length) { noReport++; console.log(`  enrich ${t}: no forecast fields in payload`); continue; }
    const row = fillNulls(seen.get(t), f);
    // `!= null` alone is not enough: rnd() yields NaN on a reshaped/non-numeric score, and
    // JSON.stringify(NaN) is null — so the "never blank a good value" promise would break
    // exactly when the payload changes shape. Carry on reshape, blank only on an explicit
    // null, matching the doctrine ssFromGetData states in ci/keep.mjs.
    // #8 — write the AI trio ATOMICALLY. Field-by-field, a payload with `score` but no
    // `ratingId` shipped a fresh 69 next to a stale "Outperform" — the exact UNP symptom
    // this pass exists to fix, reintroduced at half scale. Either the whole trio lands or
    // none of it does. `chg` is independent of the AI report, so it is applied separately.
    const usable = (v) => v != null && !(typeof v === "number" && !Number.isFinite(v));
    const trio = ["ai", "air", "aipt"];
    if (trio.every((k) => usable(f[k]))) for (const k of trio) row[k] = f[k];
    else if (trio.some((k) => usable(f[k]))) console.log(`  enrich ${t}: partial AI report, trio not applied`);
    if (usable(f.chg)) row.chg = f.chg;
    enriched++;
  } catch (e) { console.log(`  enrich ${t}: forecast skip (${e.message})`); }
}
const offPull = enrichEligible.filter(([t]) => !inPull.has(t)).length; // count BEFORE the slice — the old log counted after, so it saturated at ENRICH_LIMIT and read 36 when 73 were off-pull
console.log(`enriched ${enriched}/${enrichList.length} row(s) via stock-forecast (${offPull} off-pull, cap ${ENRICH_LIMIT}, ${noReport} with no report)`);
// Nothing else watches this: once eligible rows outpace the cap, AI/chg staleness quietly
// grows past a day again. Reachable only because ENRICH_MAX bounds the derived cap — while
// the cap was purely `eligible / ENRICH_TARGET_RUNS` this condition was arithmetically
// unsatisfiable, so the guard read as protection and was in fact dead code.
if (enrichEligible.length > ENRICH_LIMIT * ENRICH_TARGET_RUNS) {
  console.log(`  WARNING: ${enrichEligible.length} rows need enriching but the cap is ${ENRICH_LIMIT}`
    + ` — full rotation now takes ~${Math.ceil(enrichEligible.length / ENRICH_LIMIT)} runs.`
    + ` Raise ENRICH_MAX (currently ${ENRICH_MAX}) or lower KEEP_MAX_AGE_DAYS.`);
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
// Rotation stamps. Both are "attempted at", not "succeeded at": a permanently-dead ticker
// must go to the back of its queue rather than camp at the head every run. Both MUST be
// stamped or the corresponding queue re-picks the same head forever — `ls` cannot serve,
// because nextLastSeen deliberately freezes it for exactly these off-pull tickers.
for (const t of enrichTried) if (firstSeen[t]) firstSeen[t].ea = today;
for (const t of backfillTried) if (firstSeen[t]) firstSeen[t].ba = today;
writeFileSync("src/data/seen.json", JSON.stringify(firstSeen));
const freshCount = Object.values(firstSeen).filter((v) => v.d !== "baseline").length;
console.log(`seen.json: ${Object.keys(firstSeen).length} tickers, ${freshCount} dated`);
