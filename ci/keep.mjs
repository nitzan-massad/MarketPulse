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
  const carried = (prev && (prev.ls || prev.d)) || "";
  return Number.isFinite(Date.parse(carried)) ? carried : today;
}

const rnd = (x, p = 2) => (x == null ? null : +Number(x).toFixed(p));
// rating/enumId (1–5) → the app's compact consensus vocab (see src/types.ts + src/lib.ts:
// the UI lowercases + substring-matches "strongbuy"/"strongsell", so NO spaces).
const CON_NAME = { 1: "StrongSell", 2: "Sell", 3: "Neutral", 4: "Buy", 5: "StrongBuy" };

// forecast sector slug (e.g. "technology", "consumerCyclical") → the app's PascalCase
// sector string, matched by normalizing both sides (lowercase, strip non-alphanumeric).
const APP_SECTORS = ["BasicMaterials", "CommunicationServices", "ConsumerCyclical", "ConsumerDefensive", "Energy", "Financial", "General", "Healthcare", "Industrials", "RealEstate", "Technology", "Utilities"];
const SEC_BY_NORM = Object.fromEntries(APP_SECTORS.map((s) => [s.toLowerCase(), s]));
export const sectorName = (slug) => (slug ? SEC_BY_NORM[String(slug).toLowerCase().replace(/[^a-z0-9]/g, "")] ?? null : null);
// AI rating slug ("outperform") → app's "Outperform"/"Neutral"/"Underperform" (capitalize first)
export const airName = (slug) => (slug ? String(slug)[0].toUpperCase() + String(slug).slice(1) : null);

// --- `ss` (Smart Score) from getData ------------------------------------------
// TipRanks emits `score: null` as a REAL value meaning "this stock has no Smart
// Score". Verified live: ASTI and BCDA both return the FULL tipranksStockScore
// object (returnOnAssets, momentum, assetGrowth, …) with `"score": null`, while
// GOOGL comes back 10 and DNLI 6 from the very same shape.
//
// So the presence of the KEY — not the nullness of the value — is what tells the two
// cases apart:
//   `score` present (even null) → TipRanks answered; null propagates → UI renders "—"
//   object or key absent        → payload reshaped / renamed → carry prev.ss
// A plain `?? prev.ss` collapses both into "carry", so a legitimate null resurrected
// the last known number and served it as if freshly read: ASTI stayed frozen at ss 2
// from 2026-07-23 across 7 market-moving runs, and could never recover to "—" while it
// stayed off the screener list. (An explicitly `null` *object* is lumped in with absent —
// unobserved in the wild, and carrying is the conservative reading of it.)
//
// TRADE-OFF, stated deliberately: if TipRanks ever drops `tipranksStockScore` entirely
// (or renames `score`), EVERY keep-path ticker silently holds its previous `ss` — that is
// today's behaviour and the safe side of the line, because a vanished field is a scraper
// bug, not a data change, and freezing beats blanking 350 rows on our own parse error.
// An explicit null is the opposite: it IS the data, so we fail visibly and show "—".
// That is also what makes the two write paths agree instead of disagree — the screener
// path uses `?? null` (refresh-data-ci.mjs:73), which is exactly why on-list no-score
// tickers like BCDA already render "—". And a wholesale screener failure can't quietly
// blank the file either: the row-count guard at refresh-data-ci.mjs:83-86 aborts the run
// before anything is written. Nor can a garbage per-ticker response reach here — both
// callers accept the mapped row only `if (row.t)`, and otherwise carry the whole previous
// row. Visible "—" on a real null, carry only on a real reshape.
function ssFromGetData(j, prev) {
  const s = j.tipranksStockScore;
  // `typeof s === "object"` is not redundant: `in` THROWS on a truthy primitive, and the
  // `?.score` this replaced degraded to prev.ss cleanly. scripts/refresh-data.mjs calls
  // rowFromGetData outside any try/catch, so a scalar here would abort the local refresh
  // rather than carry. Belongs in the "reshaped payload -> carry" branch, same as absent.
  return s && typeof s === "object" && "score" in s ? s.score ?? null : prev.ss ?? null;
}

// Build a stocks.json row from a getData JSON blob, carrying over fields getData
// can't supply (sec/ai/air/aipt/chg) from the ticker's previous row.
export function rowFromGetData(j, prev = {}) {
  const prices = j.prices || [];
  const px = prices.length ? prices[prices.length - 1].p : null;
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
    px: rnd(px),
    chg: prev.chg ?? null,                       // no daily-change field in getData — carry
    pt: rnd(pt),
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
  const s = (fj?.models?.stocks || []).find((x) => x._id === ticker);
  if (!s) return {};
  const c = s.company || {};
  const rep = s.report || {};
  const daily = s.prices?.daily || {};
  const best = s.analystRatings?.best || {};
  const up = best.priceTarget?.upside;
  return {
    n: c.name ?? c.companyName ?? null,
    sec: sectorName(c.sector),
    px: rnd(daily.priceUSD ?? daily.price),
    chg: daily.gain != null ? rnd(daily.gain * 100, 2) : null,
    pt: rnd(best.priceTarget?.value),
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
    aipt: rnd(rep.rating?.priceTarget?.value),
    desc: c.description ?? null,
  };
}

// Fill only the null/absent fields of `row` from `extra` (never overwrite real values).
export function fillNulls(row, extra) {
  for (const [k, v] of Object.entries(extra || {})) if (row[k] == null && v != null) row[k] = v;
  return row;
}

// --- AI-score scale guard -----------------------------------------------------
// `ai` is written by TWO independent paths — the screener (`aiAnalystData.overallScore`
// in refresh-data-ci.mjs) and `forecastFields` above (`report.score`). Both are 0–100.
// A `/10` in forecastFields wrote the two pinned rows on a 0–10 scale (TER 7.8 for a
// real 71) and nobody noticed for 58 commits, because one small number in isolation is
// indistinguishable from a genuinely low score.
//
// What IS detectable is the MIXTURE: if the column really were 0–10, EVERY value would
// be ≤ 10. So the two failure signatures are
//   1. some values ≤ FLOOR while others are > FLOOR → two scales in one column;
//   2. every value ≤ FLOOR over a large sample     → the whole column got rescaled.
// ASSUMPTION: no ticker legitimately scores ≤ 10 on the 0–100 scale. Live evidence:
// of 344 non-null rows the real spread is 39–85 and the 1st percentile is 41 — nothing
// has ever come in under 30. If TipRanks ever publishes a genuine single-digit score
// this trips; that is the deliberate trade-off for a check that can't be fooled. (A bare
// max/min ratio was rejected: it false-positives on any legitimately wide spread, e.g.
// 8 → 85 is a ratio of 10.6 and perfectly valid data.)
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
