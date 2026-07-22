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
    ss: j.tipranksStockScore?.score ?? prev.ss ?? null,
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
    ai: rep.score != null ? rnd(rep.score / 10, 1) : null, // forecast score is 0–100; app's ai is 0–10
    air: airName(rep.ratingId),
    aipt: rnd(rep.rating?.priceTarget?.value),
    desc: c.description ?? null,
  };
}

// Fill only the null/absent fields of `row` from `extra` (never overwrite real values).
export function fillNulls(row, extra) {
  for (const [k, v] of Object.entries(extra || {})) if (row[k] == null && v != null) row[k] = v;
  return row;
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
    { sec: "Tech", ai: 9.1, air: "Outperform", aipt: 14, chg: 1.2 },
  );
  assert(row.up === 50, "upside = (15-10)/10 = 50%");
  assert(row.con === "StrongBuy", "rating 5 → StrongBuy (compact, matches app vocab)");
  assert(row.b === 3 && row.h === 1 && row.s === 0, "buy/hold/sell from latest all-analyst consensus");
  assert(row.sec === "Tech" && row.ai === 9.1 && row.aipt === 14 && row.chg === 1.2, "carries sec/ai/aipt/chg from prev");
  assert(row.ss === 8 && row.mc === 2000, "smart score + market cap in millions");

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
  assert(f.ai === 7.8, "AI score 78 → 7.8 (÷10)");
  assert(f.air === "Outperform", "ratingId 'outperform' → 'Outperform'");
  assert(f.aipt === 367 && f.pt === 448.82 && f.up === 39.2, "AI target + best target + upside%");
  assert(f.con === "StrongBuy", "enumId 5 → StrongBuy");
  assert(f.chg === 3.54, "daily gain 0.03538 → 3.54%");
  assert(sectorName("consumerCyclical") === "ConsumerCyclical", "multi-word sector slug normalizes");
  assert(Object.keys(forecastFields(fj, "MISSING")).length === 0, "unknown ticker → {}");

  // fillNulls — only blanks get filled
  const base = { ai: null, sec: "Energy", ss: 6 };
  fillNulls(base, { ai: 7.8, sec: "Technology", ss: null });
  assert(base.ai === 7.8 && base.sec === "Energy" && base.ss === 6, "fills null ai, keeps real sec/ss");
  console.log("keep.mjs self-check OK");
}
