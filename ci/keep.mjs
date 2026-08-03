// Shared "keep set" logic for the data refresh (used by ci/refresh-data-ci.mjs
// and scripts/refresh-data.mjs). A ticker is KEPT — refreshed every run even when
// it falls out of the top-120 screener sorts — if it is either:
//   1. pinned  (listed in src/data/pinned.json — never expires), or
//   2. seen in the dynamic list within the last KEEP_MAX_AGE_DAYS.
// Kept-but-missing tickers are backfilled from the per-ticker getData feed
// (the same endpoint scrape-forecasts uses); rowFromGetData maps that feed to a
// stocks.json row, merging fresh fields over the ticker's last-known row so the
// fields getData doesn't expose (sector name, AI-analyst score/rating/target,
// daily change) carry over instead of going blank.
import assert from "node:assert";

export const KEEP_MAX_AGE_DAYS = 365;

const MS_PER_DAY = 86_400_000;

// last-seen-in-dynamic-list timestamp for a seen.json entry (ms), or null.
// Falls back to first-seen `d`; a missing/"baseline"/unparseable date → null (never expires).
export function lastSeenMs(entry) {
  const raw = entry && (entry.ls || entry.d);
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// keep = pinned ∪ { previously-seen tickers not expired }. Pins never expire.
export function computeKeep(pinned, prevSeen, nowMs, maxAgeDays = KEEP_MAX_AGE_DAYS) {
  const keep = new Set(pinned);
  const dropped = [];
  for (const [t, e] of Object.entries(prevSeen || {})) {
    if (keep.has(t)) continue; // pinned — always kept
    const ls = lastSeenMs(e);
    if (ls != null && nowMs - ls > maxAgeDays * MS_PER_DAY) dropped.push(t);
    else keep.add(t);
  }
  return { keep, dropped };
}

// The `ls` (last-seen-in-dynamic-list) to store for a ticker this run. In the pull
// → today. Absent from the pull → keep its parseable last-seen; if it never had one
// (legacy "baseline" seed entries) start the clock now, so expiry applies uniformly.
export function nextLastSeen(prev, isInPull, today) {
  if (isInPull) return today;
  // Try `ls` then fall back to `d`: taking `ls` unconditionally meant ONE corrupt write
  // restarted the 365-day expiry clock even though a valid first-seen date sat right there.
  for (const cand of [prev?.ls, prev?.d]) {
    if (typeof cand === "string" && Number.isFinite(Date.parse(cand))) return cand;
  }
  return today;
}

const rnd = (x, p = 2) => (x == null ? null : +Number(x).toFixed(p));
// Prices, not scores: 2dp destroys a sub-dollar quote (0.0034 -> 0, rendered "$0.00" by
// fmtPx). Sub-$1 tickers are not hypothetical here — 42 of 351 shipped rows are under $1,
// the cheapest at $0.17 — and a delisting-track penny stock is exactly the row a watcher
// is watching. 4dp below $1, 2dp above. Every px writer uses this: ci/keep.mjs (both
// mappers), ci/refresh-data-ci.mjs and scripts/refresh-data.mjs — they disagreed once and
// that is the whole class of bug this file keeps fixing.
export const rndPx = (x) => (x == null ? null : Number(x) < 1 ? rnd(x, 4) : rnd(x, 2));
// rating/enumId (1–5) → the app's compact consensus vocab (see src/types.ts + src/lib.ts:
// the UI lowercases + substring-matches "strongbuy"/"strongsell", so NO spaces).
const CON_NAME = { 1: "StrongSell", 2: "Sell", 3: "Neutral", 4: "Buy", 5: "StrongBuy" };

// forecast sector slug (e.g. "technology", "consumerCyclical") → the app's PascalCase
// sector string, matched by normalizing both sides (lowercase, strip non-alphanumeric).
const APP_SECTORS = ["BasicMaterials", "CommunicationServices", "ConsumerCyclical", "ConsumerDefensive", "Energy", "Financial", "General", "Healthcare", "Industrials", "RealEstate", "Technology", "Utilities"];
const SEC_BY_NORM = Object.fromEntries(APP_SECTORS.map((s) => [s.toLowerCase(), s]));
export const sectorName = (slug) => (slug ? SEC_BY_NORM[String(slug).toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null : null);
// AI rating slug ("outperform") → app's "Outperform"/"Neutral"/"Underperform" (capitalize first)
// Title-case each WORD, not just character 0: a multi-word ratingId like "strong_buy" used
// to ship "Strong_buy" — a value in neither the app's AI-rating vocabulary nor a valid
// display string. TipRanks only emits outperform/neutral/underperform today, so this is
// insurance against a vocabulary change, not a live bug.
export const airName = (slug) => {
  if (!slug) return null;
  const words = String(slug).trim().split(/[\s_-]+/).filter(Boolean);
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : null;
};

// --- `ss` (Smart Score) from getData ------------------------------------------
// The KEY's presence, not the value's nullness, separates the two cases:
//   `score` present (even null) → TipRanks answered; null propagates → UI renders "—"
//   object or key absent        → payload reshaped/renamed → carry prev.ss
// A plain `?? prev.ss` collapses both, resurrecting a stale number as if freshly read.
// Visible "—" on a real null, carry only on a real reshape — the trade-off that choice
// makes, and the live evidence for it, are in ci/README.md → Smart Score.
function ssFromGetData(j, prev) {
  const s = j.tipranksStockScore;
  // `typeof s === "object"` is not redundant: `in` THROWS on a truthy primitive, and
  // scripts/refresh-data.mjs calls rowFromGetData outside any try/catch, so a scalar here
  // would abort the local refresh rather than carry. Same branch as absent.
  if (!(s && typeof s === "object" && "score" in s)) return prev.ss ?? null;
  if (s.score == null) return null; // explicit null IS the answer
  // ss was the ONE numeric field bypassing rnd(), so {score:"7"} wrote the STRING "7" into
  // stocks.json, which then hit sortRows' string branch and localeCompared against numbers.
  // A non-numeric score is a reshaped payload, not a value: carry rather than launder.
  const n = Number(s.score);
  return Number.isFinite(n) ? n : prev.ss ?? null;
}

// Build a stocks.json row from a getData JSON blob, carrying over fields getData
// can't supply (sec/ai/air/aipt/chg) from the ticker's previous row.
export function rowFromGetData(j, prev = {}) {
  const prices = j.prices || [];
  // A null/!object last element used to throw here, and scripts/refresh-data.mjs calls
  // rowFromGetData outside any try/catch — so one malformed price row aborted the whole
  // local refresh. Same failure class the ssFromGetData typeof guard exists for.
  const lastPx = prices.length ? prices[prices.length - 1] : null;
  const px = lastPx && typeof lastPx === "object" ? rndPx(lastPx.p) : null;
  const ptc = j.ptConsensus || [];
  const ptE = ptc.find((p) => p.bench === 1) || ptc.find((p) => p.period === 0) || ptc[0]; // "best analysts" target
  const pt = ptE ? ptE.priceTarget : null;
  const up = pt != null && px ? ((pt - px) / px) * 100 : null;
  const con = (j.consensuses || []).find((c) => c.isLatest && c.mStars === 1)
    || (j.consensuses || []).find((c) => c.isLatest)
    || (j.consensuses || [])[0];
  const mc = j.marketCapUSD ?? j.marketCap;
  return {
    t: j.ticker,
    n: j.companyName ?? prev.n ?? null,
    sec: prev.sec ?? null,                       // getData exposes only a numeric sectorID — carry the name
    px,                                          // already rndPx'd above (the upside calc uses it)
    chg: prev.chg ?? null,                       // no daily-change field in getData — carry
    pt: rndPx(pt),                              // a target is a price too — 2dp zeroed a sub-dollar one
    up: rnd(up, 1),
    con: con ? CON_NAME[con.rating] ?? prev.con ?? null : prev.con ?? null,
    b: con ? con.nB || 0 : prev.b || 0,
    h: con ? con.nH || 0 : prev.h || 0,
    s: con ? con.nS || 0 : prev.s || 0,
    ss: ssFromGetData(j, prev),                  // explicit `score: null` = "no Smart Score" — see above
    ai: prev.ai ?? null,                         // AI-analyst data not in getData — carry
    air: prev.air ?? null,
    aipt: prev.aipt ?? null,
    mc: mc != null ? Math.round(mc / 1e6) : prev.mc ?? null,
    desc: j.description ?? prev.desc ?? null,
  };
}

// Fields from the per-ticker stock-forecast payload (www.tipranks.com/stocks/<t>/
// stock-forecast/payload.json) — this is the ONLY per-ticker source for the AI-analyst
// score/rating/target and sector name (getData exposes neither). Select the requested
// ticker by `_id` (peers in the bundle are stubs). Returns nulls for fields it lacks
// (ss/mc) so fillNulls leaves those alone.
export function forecastFields(fj, ticker) {
  // Array.isArray, not `|| []`: a reshaped `stocks` object has no .find and threw. And a
  // falsy ticker must never match an _id-less stub row, which would graft one stock's
  // fields onto another.
  const list = fj?.models?.stocks;
  const s = ticker && Array.isArray(list) ? list.find((x) => x && x._id === ticker) : undefined;
  if (!s) return {};
  const c = s.company || {};
  const rep = s.report || {};
  const daily = s.prices?.daily || {};
  const best = s.analystRatings?.best || {};
  const up = best.priceTarget?.upside;
  return {
    n: c.name ?? c.companyName ?? null,
    sec: sectorName(c.sector),
    px: rndPx(daily.priceUSD ?? daily.price),
    chg: daily.gain != null ? rnd(daily.gain * 100, 2) : null,
    pt: rndPx(best.priceTarget?.value),
    up: up != null ? rnd(up * 100, 1) : null,
    con: best.enumId != null ? CON_NAME[best.enumId] ?? null : null,
    b: best.buy, h: best.hold, s: best.sell,
    // `ai` is 0–100 on BOTH sources — do NOT rescale. report.score verified live at
    // TER 71 / AAPL 75 / NVDA 79, the same scale as the screener's aiAnalystData.overallScore
    // (refresh-data-ci.mjs, live spread 39–85). See the aiScaleError guard below.
    ai: rnd(rep.score, 1),
    air: airName(rep.ratingId),
    // AI price target in dollars, not a score — verified against the live price:
    // TER 406 vs px 367.69, AAPL 348 vs 308.91, NVDA 223 vs 200.75. No scaling.
    aipt: rndPx(rep.rating?.priceTarget?.value),
    desc: c.description ?? null,
  };
}

// Fill only the null/absent fields of `row` from `extra` (never overwrite real values).
export function fillNulls(row, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (row[k] != null || v == null) continue;
    // rnd() returns NaN (not null) for non-numeric input, and JSON.stringify(NaN) is null —
    // so filling with NaN wrote a null that LOOKED like a real fetch. refresh-data-ci.mjs
    // guards this for its overwrite fields; fillNulls has to guard it for the fill path.
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    row[k] = v;
  }
  return row;
}

// --- enrich: queue selection + payload application ----------------------------
// Both refresh scripts (ci/refresh-data-ci.mjs and scripts/refresh-data.mjs) drive the
// same enrich pass, and they used to hold a copy each. They diverged once and silently
// reproduced a bug CI had already fixed, so the logic lives HERE and they import it.
// Only the transport differs (FlareSolverr vs Playwright) — that stays in the callers.
export const ENRICH_TARGET_RUNS = 3; // full rotation within 3 runs = ~15h at the 5h cron
// Ceiling, because the derived cap scales with a set that only grows and every unit is one
// fetch on top of BACKFILL_LIMIT. 120/run rotates the whole ~351-row universe inside
// ENRICH_TARGET_RUNS, so hitting this means the keep set itself is the problem — and the
// caller's WARNING can then actually fire, which without a ceiling it mathematically never
// could (cap = eligible/3 makes `eligible > cap * 3` false always).
export const ENRICH_MAX = 120;
export const ENRICH_STALE_MS = 3 * 864e5;
export const AI_TRIO = ["ai", "air", "aipt"];
export const needsFill = (r) => r.ai == null || r.sec == null;
// `!= null` alone is not enough: rnd() yields NaN on a reshaped/non-numeric score, and
// JSON.stringify(NaN) is null — so the "never blank a good value" promise would break
// exactly when the payload changes shape.
const usable = (v) => v != null && !(typeof v === "number" && !Number.isFinite(v));

// Which rows to enrich this run, in order. `rows` is seen.entries(); `aiFreshMs(t)` is when
// the row's AI trio was last known-good (in the pull, or enriched). A pin is prio 0 only
// when actually STALE — unconditional prio 0 burned a slot every run, and sticky slots
// scale with the pin count, so a big enough pin list would stop prio-2 rotation dead.
export function enrichQueue(rows, { inPull, pinned = [], aiFreshMs, now = Date.now(), limit }) {
  const eligible = [...rows].filter(([t, r]) => needsFill(r) || !inPull.has(t));
  // A FIXED cap cannot bound a growing set (at 40, with off-pull growing ~5.7/day, the 15h
  // worst case decays to ~50h within six weeks), so derive it — floor 40 for small sets,
  // ceiling ENRICH_MAX for cost. An explicit caller/env value still wins.
  const cap = Number(limit) || Math.min(ENRICH_MAX, Math.max(40, Math.ceil(eligible.length / ENRICH_TARGET_RUNS)));
  const prio = (t, r) => (pinned.includes(t) && now - aiFreshMs(t) > ENRICH_STALE_MS ? 0 : needsFill(r) ? 1 : 2);
  const list = [...eligible]
    .sort((a, b) => prio(a[0], a[1]) - prio(b[0], b[1]) || aiFreshMs(a[0]) - aiFreshMs(b[0]))
    .slice(0, cap)
    .map(([t]) => t);
  return { list, eligible, cap };
}

// Apply a forecastFields result to a row. Returns "trio" | "partial" | "fill" | "none".
//
// The AI trio is written ATOMICALLY, and when the row already HOLDS a trio value it is
// excluded from the fillNulls pass. Running fillNulls over the whole payload defeated the
// atomicity: a payload with `score` but no `ratingId` landed a fresh 69 in a null `ai`
// beside a stale "Outperform" in `air` — the exact UNP symptom this pass exists to fix —
// and the atomic block below could not undo it, so it logged "trio not applied" about a
// row it had already corrupted.
//
// But the hazard is mixing EPOCHS, not writing a partial trio: it needs a stale value to
// be inconsistent WITH. On a row whose trio is entirely blank there is nothing to mix, and
// refusing the fill made things worse — the row could never be completed, so needsFill()
// stayed true and it camped at prio 1 burning a fetch every run, forever. So: blank trio →
// fill whatever the payload has (missing fields keep rendering "—"); any trio value present
// → all three land or none do. `chg` is independent of the AI report and applies on its own.
export function applyForecast(row, f) {
  const hasStale = AI_TRIO.some((k) => row[k] != null);
  const rest = { ...f };
  if (hasStale) for (const k of AI_TRIO) delete rest[k];
  fillNulls(row, rest);
  if (usable(f.chg)) row.chg = f.chg; // overwrite, not fill — nothing else re-checks it
  if (AI_TRIO.every((k) => usable(f[k]))) {
    for (const k of AI_TRIO) row[k] = f[k];
    return "trio";
  }
  if (!AI_TRIO.some((k) => usable(f[k]))) return "none";
  // A partial report against a blank trio DID land (via the fill above) — distinguish it,
  // or the log claims nothing was written and the counters cannot tell the two apart.
  return hasStale ? "partial" : "fill";
}

// --- AI-score scale guard -----------------------------------------------------
// `ai` is written by two independent paths (the screener's `aiAnalystData.overallScore` and
// `forecastFields`' `report.score`) and both are 0–100. One small number in isolation is
// indistinguishable from a genuinely low score, so this checks the MIXTURE instead:
//   1. some values ≤ FLOOR while others are > FLOOR → two scales in one column;
//   2. every value ≤ FLOOR over a large sample     → the whole column got rescaled;
//   3. most values missing                         → the column was emptied, a worse
//      failure that arms 1 and 2 are blind to (they compare values that no longer exist).
// ASSUMPTION: no ticker legitimately scores ≤ 10 on 0–100. Evidence, the rejected
// alternatives, and what trips this: ci/README.md → AI score scale.
export const AI_SCALE_FLOOR = 10;
const AI_SCALE_MIN_SAMPLE = 20; // below this, "all values are small" proves nothing

// Returns a human-readable error string, or null when the column looks single-scaled.
export function aiScaleError(rows, floor = AI_SCALE_FLOOR) {
  const total = (rows || []).length;
  const scored = (rows || []).filter((r) => r && r.ai != null && Number.isFinite(Number(r.ai)));
  // An emptied column is a worse failure than a rescaled one, and the scale checks below
  // are blind to it — they compare values that no longer exist and silently return null.
  // Guard it explicitly: normal is ~344/351 scored, so a wholesale wipe is unmistakable.
  if (total >= AI_SCALE_MIN_SAMPLE && scored.length < total * 0.5) {
    return `ai is missing on ${total - scored.length}/${total} row(s) — only ${scored.length} `
      + `scored. Normal is nearly all rows; an emptied column means the AI source or its `
      + `mapping broke, not that TipRanks stopped scoring.`;
  }
  if (!scored.length) return null;
  const low = scored.filter((r) => Number(r.ai) <= floor);
  const high = scored.filter((r) => Number(r.ai) > floor);
  const name = (r) => `${r.t ?? "?"}=${r.ai}`;
  if (low.length && high.length) {
    const hi = high.map((r) => Number(r.ai));
    return `ai mixes two scales: ${low.length}/${scored.length} row(s) are ≤ ${floor} `
      + `(0–10 scale) while the rest span ${Math.min(...hi)}–${Math.max(...hi)} (0–100). `
      + `Offenders: ${low.map(name).join(", ")}. `
      + `Both sources are 0–100 — see forecastFields/aiScaleError in ci/keep.mjs.`;
  }
  if (!high.length && scored.length >= AI_SCALE_MIN_SAMPLE) {
    return `ai looks entirely 0–10: all ${scored.length} non-null values are ≤ ${floor} `
      + `(max ${Math.max(...scored.map((r) => Number(r.ai)))}). The column should be 0–100.`;
  }
  return null;
}

// ponytail: self-check — run `node ci/keep.mjs`. Fails loudly if the keep/expiry
// or getData mapping breaks. No test framework on purpose.
if (import.meta.url === `file://${process.argv[1]}`) {
  const now = Date.parse("2026-07-21T00:00:00Z");
  const prevSeen = {
    OLD: { d: "2025-01-01T00:00:00Z", ls: "2025-01-01T00:00:00Z" }, // >365d absent → drop
    NEW: { d: "2026-06-01T00:00:00Z", ls: "2026-06-01T00:00:00Z" }, // <365d → keep
    PINOLD: { ls: "2020-01-01T00:00:00Z" },                          // pinned → keep despite age
  };
  const { keep, dropped } = computeKeep(["PINOLD", "BRANDNEW"], prevSeen, now, 365);
  assert(dropped.includes("OLD") && !keep.has("OLD"), "OLD should expire");
  assert(keep.has("NEW"), "NEW should be kept");
  assert(keep.has("PINOLD"), "pinned ticker never expires");
  assert(keep.has("BRANDNEW"), "pin not yet seen is still kept");

  const today = "2026-07-21T00:00:00Z";
  assert(nextLastSeen({ ls: "2026-01-01T00:00:00Z" }, true, today) === today, "in pull → today");
  assert(nextLastSeen({ ls: "2026-01-01T00:00:00Z" }, false, today) === "2026-01-01T00:00:00Z", "absent → carry parseable ls");
  assert(nextLastSeen({ d: "baseline" }, false, today) === today, "legacy baseline absent → start clock now");
  assert(nextLastSeen(undefined, false, today) === today, "no prior → today");

  const row = rowFromGetData(
    {
      ticker: "X", companyName: "XCo", prices: [{ p: 10 }],
      ptConsensus: [{ bench: 1, priceTarget: 15 }],
      consensuses: [{ isLatest: 1, mStars: 1, rating: 5, nB: 3, nH: 1, nS: 0 }],
      tipranksStockScore: { score: 8 }, marketCapUSD: 2e9, description: "d",
    },
    { sec: "Tech", ai: 91, air: "Outperform", aipt: 14, chg: 1.2 },
  );
  assert(row.up === 50, "upside = (15-10)/10 = 50%");
  assert(row.con === "StrongBuy", "rating 5 → StrongBuy (compact, matches app vocab)");
  assert(row.b === 3 && row.h === 1 && row.s === 0, "buy/hold/sell from latest all-analyst consensus");
  assert(row.sec === "Tech" && row.ai === 91 && row.aipt === 14 && row.chg === 1.2, "carries sec/ai/aipt/chg from prev");
  assert(row.ss === 8 && row.mc === 2000, "smart score + market cap in millions");

  // ss — an explicit `score: null` is DATA ("TipRanks has no Smart Score for this
  // stock", live on ASTI/BCDA); a MISSING field is a reshaped payload. Only the second
  // may fall back to prev. See ssFromGetData above for the trade-off.
  const ssOf = (j, prev) => rowFromGetData({ ticker: "X", ...j }, prev).ss;
  assert(ssOf({ tipranksStockScore: { score: null } }, { ss: 7 }) === null, "explicit score:null beats prev.ss — no score means '—', not a stale 7");
  assert(ssOf({}, { ss: 7 }) === 7, "no tipranksStockScore at all → payload reshaped, carry prev.ss");
  assert(ssOf({ tipranksStockScore: {} }, { ss: 7 }) === 7, "object present but no `score` key → carry prev.ss");
  assert(ssOf({ tipranksStockScore: { score: 4 } }, { ss: 7 }) === 4, "a real score still wins over prev.ss");
  assert(ssOf({ tipranksStockScore: { score: 0 } }, { ss: 7 }) === 0, "score 0 is a value, not a blank (nullish test, not falsy)");
  assert(ssOf({ tipranksStockScore: { score: null } }, {}) === null && ssOf({}, {}) === null, "no prev to carry → null either way");
  // a truthy PRIMITIVE must carry, not throw: `in` throws on one, and scripts/refresh-data.mjs
  // calls rowFromGetData outside any try/catch, so a scalar reshape would abort the local refresh
  for (const junk of [7, "x", true, [], 0, null, undefined]) {
    assert(ssOf({ tipranksStockScore: junk }, { ss: 7 }) === 7, `tipranksStockScore=${JSON.stringify(junk)} → carry prev.ss, never throw`);
  }

  // forecastFields — real TER shape from the HAR
  const fj = { models: { stocks: [
    { _id: "PEER" }, // peer stub, must be ignored
    { _id: "TER", company: { name: "Teradyne", sector: "technology", description: "d" },
      prices: { daily: { priceUSD: 333.76, gain: 0.03538 } },
      report: { score: 78, ratingId: "outperform", rating: { priceTarget: { value: 367 } } },
      analystRatings: { best: { priceTarget: { value: 448.82, upside: 0.3923 }, buy: 10, hold: 1, sell: 0, enumId: 5 } } },
  ] } };
  const f = forecastFields(fj, "TER");
  assert(f.sec === "Technology", "slug 'technology' → 'Technology'");
  assert(f.ai === 78, "AI score 78 stays 78 — 0–100, same scale as the screener (NOT ÷10)");
  assert(f.air === "Outperform", "ratingId 'outperform' → 'Outperform'");
  assert(f.aipt === 367 && f.pt === 448.82 && f.up === 39.2, "AI target + best target + upside%");
  assert(f.con === "StrongBuy", "enumId 5 → StrongBuy");
  assert(f.chg === 3.54, "daily gain 0.03538 → 3.54%");
  assert(sectorName("consumerCyclical") === "ConsumerCyclical", "multi-word sector slug normalizes");
  assert(Object.keys(forecastFields(fj, "MISSING")).length === 0, "unknown ticker → {}");

  // fillNulls — only blanks get filled
  const base = { ai: null, sec: "Energy", ss: 6 };
  fillNulls(base, { ai: 78, sec: "Technology", ss: null });
  assert(base.ai === 78 && base.sec === "Energy" && base.ss === 6, "fills null ai, keeps real sec/ss");
  // ...and never overwrites — which is why the two 0–10 rows can't self-heal here.
  const stuck = { ai: 7.8 };
  fillNulls(stuck, { ai: 71 });
  assert(stuck.ai === 7.8, "fillNulls leaves a wrong-but-non-null ai alone (needs the enrich path to overwrite)");

  // applyForecast — the fill pass must NOT reach the AI trio. A partial report landing a
  // fresh `ai` next to a stale `air` is the UNP symptom; it happened through fillNulls,
  // which the old caller ran over the whole payload before the atomic block.
  {
    const stale = () => ({ t: "UNP", ai: null, air: "Outperform", aipt: 328, chg: 4.02, sec: null });
    const partial = { ai: 69, air: null, aipt: null, sec: "Industrials" };
    const r1 = stale();
    assert(applyForecast(r1, partial) === "partial", "score without ratingId is a partial report");
    assert(r1.ai === null && r1.air === "Outperform" && r1.aipt === 328,
      "THE REGRESSION: a partial report must not fill a null `ai` beside a stale `air`");
    assert(r1.sec === "Industrials", "non-trio blanks still fill on a partial report");
    const r2 = stale();
    assert(applyForecast(r2, { ai: 69, air: "Neutral", aipt: 333, chg: 0.92 }) === "trio", "a complete report lands");
    assert(r2.ai === 69 && r2.air === "Neutral" && r2.aipt === 333 && r2.chg === 0.92, "the whole trio overwrites, chg too");
    const r3 = stale();
    assert(applyForecast(r3, { ai: NaN, air: "Neutral", aipt: 333 }) === "partial" && r3.ai === null,
      "NaN makes the trio unusable — and must not be filled in as a fake null either");
    const r4 = stale();
    applyForecast(r4, { chg: 0.6 });
    assert(r4.chg === 0.6, "chg refreshes even when the trio is absent");
    const r5 = { t: "X", ai: 74, air: "Outperform", aipt: 328 };
    applyForecast(r5, { ai: 69, air: null, aipt: null });
    assert(r5.ai === 74 && r5.air === "Outperform", "a partial report leaves a fully-populated trio alone");
    // ...but a BLANK trio has no epoch to mix with, so a partial report must still land, or
    // the row can never be completed and camps at prio 1 burning a fetch every run forever.
    const r6 = { t: "KAPA", ai: null, air: null, aipt: null, sec: "General" };
    assert(applyForecast(r6, { ai: 69, air: "Outperform", aipt: null }) === "fill", "a partial report on a blank trio DID write");
    assert(r6.ai === 69 && r6.air === "Outperform" && r6.aipt === null, "what the payload had lands; the rest stays '—'");
    assert(!needsFill(r6), "and the row stops being a permanent prio-1 resident");
  }

  // enrichQueue — off-pull rows are eligible even with a full trio (that is the whole point:
  // nothing else re-checks a carried trio), and the queue must ROTATE on aiFreshMs.
  {
    const rows = [["A", { ai: 70, sec: "Tech" }], ["B", { ai: null, sec: null }], ["C", { ai: 70, sec: "Tech" }]];
    const inPull = new Set(["A"]); // B and C are off-pull
    const fresh = { A: 100, B: 50, C: 10 };
    const q = enrichQueue(rows, { inPull, pinned: [], aiFreshMs: (t) => fresh[t], limit: 2 });
    assert(q.list[0] === "B", "a row needing a fill outranks a merely-stale one");
    assert(q.eligible.map(([t]) => t).join() === "B,C", "an in-pull row with a full trio is not eligible; off-pull C is");
    assert(enrichQueue(rows, { inPull: new Set(), pinned: [], aiFreshMs: (t) => fresh[t], limit: 3 }).list.join() === "B,C,A",
      "everything off-pull is eligible, ordered oldest-first after the fill-first tier");
    assert(enrichQueue(rows, { inPull, pinned: ["C"], aiFreshMs: () => 0, now: 1e12, limit: 1 }).list[0] === "C",
      "a STALE pin takes the first slot");
    assert(enrichQueue(rows, { inPull, pinned: ["C"], aiFreshMs: () => 1e12, now: 1e12, limit: 1 }).list[0] === "B",
      "a FRESH pin does not — it falls through to the queue");
    assert(enrichQueue([], { inPull: new Set(), aiFreshMs: () => 0 }).cap === 40, "small sets get the floor of 40");
    const many = Array.from({ length: 900 }, (_, i) => [`T${i}`, { ai: null, sec: null }]);
    assert(enrichQueue(many, { inPull: new Set(), aiFreshMs: () => 0 }).cap === ENRICH_MAX, "big sets get the ceiling");
  }

  // aiScaleError — the guard that makes the ÷10 class of bug un-shippable.
  assert(aiScaleError([{ t: "A", ai: 71 }, { t: "B", ai: 46 }, { t: "C", ai: null }]) === null, "uniform 0–100 column is fine");
  assert(aiScaleError([{ t: "A", ai: 85 }, { t: "B", ai: 11 }]) === null, "wide single-scale spread is fine (no max/min ratio test)");
  const mixed = aiScaleError([{ t: "TER", ai: 7.8 }, { t: "AAPL", ai: 8.2 }, { t: "NVDA", ai: 79 }]);
  assert(mixed && mixed.includes("TER=7.8") && mixed.includes("AAPL=8.2"), "÷10 rows among 0–100 rows are caught and named");
  assert(aiScaleError(Array.from({ length: 25 }, (_, i) => ({ t: `T${i}`, ai: 5 + i / 10 }))) !== null, "a whole column ≤10 is caught too");
  assert(aiScaleError([{ t: "A", ai: 7.8 }]) === null, "too small a sample to judge → no verdict");
  assert(aiScaleError([]) === null && aiScaleError(null) === null, "no data → no verdict");
  // an EMPTIED column used to slip through: the scale arms compare values that no longer
  // exist, so 351 nulls returned null and the check printed "OK — 0/351 rows scored"
  assert(aiScaleError(Array.from({ length: 351 }, (_, i) => ({ t: `T${i}`, ai: null }))) !== null, "a wiped ai column is caught, not reported OK");
  assert(aiScaleError(Array.from({ length: 351 }, (_, i) => ({ t: `T${i}`, ai: i < 176 ? null : 50 }))) !== null, "losing over half the column is caught");
  assert(aiScaleError(Array.from({ length: 351 }, (_, i) => ({ t: `T${i}`, ai: i < 7 ? null : 50 }))) === null, "the normal ~7 genuinely-unscored rows are fine");
  console.log("keep.mjs self-check OK");
}
