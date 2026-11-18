// CI data refresh via FlareSolverr — a proxy that drives an undetected browser
// to solve Cloudflare's challenge from GitHub's datacenter IP, then returns the
// page body. We request the screener API through it and parse the JSON out.
// (Local manual refresh uses scripts/refresh-data.mjs with Playwright instead.)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { computeKeep, forecastFields, applyForecast, enrichQueue, nextLastSeen, rowFromScreener, rowFromAiAnalyst, mergeRow, ENRICH_MAX, ENRICH_TARGET_RUNS, KEEP_MAX_AGE_DAYS } from "./keep.mjs";
import { UNIVERSE_URL, universeMap, planBackfill } from "./backfill-plan.mjs";
import { getText, makeBreaker, health } from "./tr-fetch.mjs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const API =
  "https://www.tipranks.com/api/apps/stock/screener?country=us&method=screener&isPrimaryMarket=true&exchange=xnas&exchange=xnys&exchange=arcx&exchange=xase&exchange=bats&page=1&pageSize=120&sortDir=2";

// Transport lives in ci/tr-fetch.mjs: plain fetch, FlareSolverr on a challenge, and a Cloudflare
// firewall block fails at once (BlockedError) instead of being retried. One breaker per endpoint;
// retries here also absorb FlareSolverr's ~30-60s cold start.
const flareGet = (url, br, tries = 8) => getText(url, { flareUrl: FS_URL, tries, breaker: br });
const screenerBreaker = makeBreaker(), universeBreaker = makeBreaker(), aiBreaker = makeBreaker(), payloadBreaker = makeBreaker();

// FlareSolverr returns the rendered page; a JSON endpoint comes back wrapped in
// <pre>…</pre> with HTML-escaped entities. Pull the JSON object out of it.
function extractJson(html) {
  try { return JSON.parse(html); } catch { /* wrapped in <pre> or HTML: fall through */ }
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

// last-known rows: the screener mapper's `undefined` ("can't see it") falls back to these
const prevRows = new Map();
try { for (const r of JSON.parse(readFileSync("src/data/stocks.json", "utf8"))) prevRows.set(r.t, r); } catch { /* first run */ }
const seen = new Map();
const SORT_KEY = { 5: "u", 2: "s" }; // upside / smart score (sortBy 3 = mkt cap still fetched for the universe, but not tagged as a list)
const membership = {}; // ticker -> Set of ranking(s) it appears in
let total = null;
for (const sb of [5, 2, 3]) {
  const j = extractJson(await flareGet(API + "&sortBy=" + sb, screenerBreaker));
  if (total == null) total = j.totalCount ?? null;
  for (const it of j.items || []) {
    const t = it.tradingInformationData || {};
    const e = it.tipRanksEssentialData || {};
    if (t.ticker && SORT_KEY[sb]) (membership[t.ticker] ??= new Set()).add(SORT_KEY[sb]);
    if (seen.has(t.ticker)) continue;
    // every row goes through the shared mappers: undefined fields keep the last-known value
    seen.set(t.ticker, mergeRow(prevRows.get(t.ticker), rowFromScreener(it, { inPull: true })));
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
// watchlists + recent views (keepalive) and "Track this stock" requests (tracked) — see computeKeep
const alive = { tracked: {} };
try { alive.tracked = JSON.parse(readFileSync("src/data/tracked.json", "utf8")); } catch { /* none */ }
try { Object.assign(alive, JSON.parse(readFileSync("src/data/keepalive.json", "utf8"))); } catch { /* none */ }
let prevSeen = {};
try { prevSeen = JSON.parse(readFileSync("src/data/seen.json", "utf8")); } catch { /* first run */ }

const BACKFILL_LIMIT = Number(process.env.BACKFILL_LIMIT || 300);
const { keep, dropped } = computeKeep(pinned, prevSeen, Date.now(), KEEP_MAX_AGE_DAYS, alive);
// the expired tickers, for the data-loss gate (ci/test-no-data-loss.mjs): their removal is expected
if (process.env.DROPPED) writeFileSync(process.env.DROPPED, JSON.stringify(dropped));
const lsMs = (t) => Date.parse(prevSeen[t]?.ls || prevSeen[t]?.d || "") || 0;
// #6 — DO NOT sort this queue on lsMs. `ls` is frozen while a ticker is off-pull (that is
// what nextLastSeen does), and every ticker in `missing` is BY DEFINITION off-pull — so the
// ordering never changes and, once `missing` exceeds BACKFILL_LIMIT, the tail past the cap is
// never fetched again. Same trap as file mtime and as the enrich queue. `ba` (backfilled-at,
// stamped in the seen tracker below) advances, so a fetched ticker goes to the back.
const baMs = (t) => Date.parse(prevSeen[t]?.ba || "") || lsMs(t);
const missing = [...keep].filter((t) => !inPull.has(t)).sort((a, b) => baMs(a) - baMs(b));
const backfillTried = new Set();
// Off-pull rows come from the full-universe screener call (one request, ~14k items) where
// possible; only tickers it lacks need a per-ticker stock-aianalyst payload. The raw response
// is ~77 MB: parse once, keep only the map.
let universe = new Map(), universeTotal = 0;
if (missing.length) {
  try {
    let body = await getText(UNIVERSE_URL, { flareUrl: FS_URL, tries: 2, timeoutMs: 120_000, breaker: universeBreaker });
    const items = extractJson(body).items;
    body = null;
    universe = universeMap(items);
    universeTotal = Array.isArray(items) ? items.length : 0;
  } catch (e) { health("universe pull failed"); console.log(`  universe pull failed (${e.message}): backfilling from payloads only`); }
}
const { fromUniverse, needPayload } = planBackfill(missing, universe);
const today = new Date().toISOString();
let fromUni = 0, fromPayload = 0, carried = 0;
for (const t of fromUniverse) {
  const row = mergeRow(prevRows.get(t), rowFromScreener(universe.get(t), { inPull: false }));
  if (row?.t) { seen.set(t, row); fromUni++; backfillTried.add(t); } else needPayload.push(t);
}
const deadline = Date.now() + 10 * 60_000;
for (const t of needPayload) {
  const prev = prevRows.get(t);
  if (Date.now() < deadline && fromPayload < BACKFILL_LIMIT && !aiBreaker.open()) {
    backfillTried.add(t); // attempt, not success — a permanently-dead ticker must not camp at the head
    try {
      const body = await getText(`https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-aianalyst/payload.json`, { flareUrl: FS_URL, tries: 3, breaker: aiBreaker });
      const row = mergeRow(prev, rowFromAiAnalyst(extractJson(body), t));
      if (row?.t) { seen.set(t, row); fromPayload++; continue; }
    } catch (e) { console.log(`  keep ${t}: aianalyst skip (${e.message})`); }
  } else if (aiBreaker.open() && !aiBreaker.reported) { aiBreaker.reported = true; health("breaker open: stock-aianalyst"); console.log("  aianalyst breaker open: skipping the rest, carrying last-known rows"); }
  if (prev?.t) { seen.set(t, prev); carried++; } // past the deadline/cap or fetch failed — keep last-known row
}
console.log(`backfill: ${fromUni} universe, ${fromPayload} payload, ${carried} carried (of ${missing.length} missing; universe ${universe.size}/${universeTotal} items)`);
if (carried > missing.length * 0.3) health(`backfill carried ${carried}/${missing.length}`);
for (const t of pinned) if (seen.has(t)) (membership[t] ??= new Set()).add("p");
console.log(`keep set: ${keep.size} (${fromUni + fromPayload} refreshed, ${carried} carried, ${dropped.length} expired, payload cap ${BACKFILL_LIMIT})`);
// Only tickers the universe pull lacks cost a per-ticker request; past the cap they carry stale prices.
if (needPayload.length > BACKFILL_LIMIT * 0.8) {
  console.log(`  WARNING: ${needPayload.length} kept tickers need a per-ticker payload against a cap of ${BACKFILL_LIMIT}`
    + ` — at the cap, rows past it serve stale prices. Raise BACKFILL_LIMIT or lower KEEP_MAX_AGE_DAYS.`);
}

// Enrich from the per-ticker stock-forecast payload — the only per-ticker source for the
// AI-analyst score/rating/target and the sector name. Two jobs: FILL blanks (off-list pins,
// brand-new arrivals), and CORRECT the ai/air/aipt/chg that off-pull rows carry verbatim
// for off-pull rows — nothing else ever re-checks those, so the AI trio OVERWRITES here
// (atomically) while blanks fill normally. Why each of those is the way it is (the UNP
// downgrade that stayed visible for 46 runs, the 0-100 scale this overwrite depends on, the
// queue rotation and its cost bound): ci/README.md → Enrich.
// When this row's AI trio was last known-good: in the pull (the screener ships
// aiAnalystData) or enriched. Reuses lsMs so there is one age concept, not two.
const aiFreshMs = (t) => Math.max(lsMs(t), Date.parse(prevSeen[t]?.ea || "") || 0);
// Selection, the cap and the payload-application rules all live in ci/keep.mjs so this
// script and scripts/refresh-data.mjs cannot drift apart again. Only the fetch is local.
const { list: enrichList, eligible: enrichEligible, cap: ENRICH_LIMIT } =
  enrichQueue(seen.entries(), { inPull, pinned, aiFreshMs, limit: process.env.ENRICH_LIMIT });
let enriched = 0, noReport = 0;
const enrichTried = new Set();
for (const t of enrichList) {
  if (payloadBreaker.open()) {
    if (!payloadBreaker.reported) { payloadBreaker.reported = true; health("breaker open: stock-forecast payload"); console.log("  payload breaker open: skipping the rest of the enrich queue"); }
    break; // not attempted -> not stamped, so these keep their place in the queue
  }
  enrichTried.add(t); // stamp the attempt, not the success: a ticker with no forecast payload must not block the queue head forever
  try {
    const f = forecastFields(extractJson(await flareGet(`https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-forecast/payload.json`, payloadBreaker)), t);
    // #9 — an empty result was a SILENT no-op that still counted as enriched and still
    // stamped `ea`, so the row rotated to the back with no signal and could never re-queue
    // as prio-1. Usually a bundle/_id mismatch, i.e. our bug, not missing data.
    if (!Object.keys(f).length) { noReport++; console.log(`  enrich ${t}: no forecast fields in payload`); continue; }
    // Fills blanks, then lands the AI trio atomically — and deliberately keeps the trio out
    // of the fill pass, or a partial report would ship a fresh score beside a stale rating.
    // See applyForecast in ci/keep.mjs.
    const landed = applyForecast(seen.get(t), f);
    if (landed === "partial") console.log(`  enrich ${t}: partial AI report, trio left as it was`);
    if (landed === "fill") console.log(`  enrich ${t}: partial AI report, filled a blank trio`);
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
// (`today` is declared above, before the backfill) full timestamp so New Arrivals can show hours-ago for fresh names
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
