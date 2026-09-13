// Guards ci/scrape-feargreed.mjs's trim of CNN's payload.
//
// The bugs this exists to catch, in the order they would actually bite:
//   1. a reshaped CNN document silently producing a gauge with no components
//   2. a score arriving on the wrong scale (the ÷10 class of bug that shipped once before)
//   3. the sparkline's last point drifting away from the headline score
import assert from "node:assert/strict";
import { parseFearGreed } from "./scrape-feargreed.mjs";

const comp = (score, rating) => ({ score, rating, data: [{ x: 1, y: score, rating }] });

function doc(over = {}) {
  const history = [];
  for (let i = 0; i < 250; i++) history.push({ x: i, y: 20 + (i % 40) });
  history[history.length - 1].y = 33.3; // newest point matches the headline
  return {
    fear_and_greed: {
      score: 33.3428571428571,
      rating: "fear",
      timestamp: "2026-09-11T23:59:53+00:00",
      previous_close: 33.1142857142857,
      previous_1_week: 45.228571428571435,
      previous_1_month: 60.08571428571429,
      previous_1_year: 60.34285714285715,
    },
    market_momentum_sp500: comp(24.4, "fear"),
    market_momentum_sp125: comp(30, "fear"),
    stock_price_strength: comp(3.4, "extreme fear"),
    stock_price_breadth: comp(9.2, "extreme fear"),
    put_call_options: comp(42, "fear"),
    market_volatility_vix: comp(50, "neutral"),
    market_volatility_vix_50: comp(55, "neutral"),
    junk_bond_demand: comp(68, "greed"),
    safe_haven_demand: comp(21.4, "extreme fear"),
    fear_and_greed_historical: { data: history },
    ...over,
  };
}

const fg = parseFearGreed(doc());

// ── headline ──────────────────────────────────────────────────────────────────
assert.equal(fg.score, 33.3, "headline score rounds to 1dp, stays on the 0-100 scale");
assert.equal(fg.rating, "fear", "rating carried through verbatim");
assert.equal(fg.asOf, "2026-09-11T23:59:53", "asOf trimmed to seconds, no zone suffix");
assert.equal(fg.previous.week, 45.2, "previous readings rounded the same way");
assert.equal(fg.previous.year, 60.3, "a year-ago reading survives the trim");

// ── components ────────────────────────────────────────────────────────────────
assert.equal(fg.components.length, 7, "exactly the seven documented sub-indicators");
const keys = fg.components.map((c) => c.key);
assert.ok(!keys.includes("market_momentum_sp125"), "sp125 is an alternate lookback, not an eighth component");
assert.ok(!keys.includes("market_volatility_vix_50"), "vix_50 is an alternate lookback, not an eighth component");
assert.equal(fg.components[0].label, "Market momentum", "components carry a display label, not a raw key");
assert.equal(fg.components[1].score, 3.4, "a single-digit component is not confused for a missing one");

// A vanished component means the document reshaped — that must be loud, not a blank row.
assert.throws(() => parseFearGreed(doc({ junk_bond_demand: undefined })), /junk_bond_demand.*missing/,
  "a dropped component fails the run rather than rendering an empty gauge");
assert.throws(() => parseFearGreed({ fear_and_greed_historical: { data: [] } }), /no fear_and_greed block/,
  "loud when the headline block is gone");

// ── scale guard ───────────────────────────────────────────────────────────────
// The mirror of ci/test-ai-scale.mjs: 0-100 on the wire, 0-100 on the page, never rescaled.
assert.throws(() => parseFearGreed(doc({ fear_and_greed: { ...doc().fear_and_greed, score: 333 } })),
  /outside 0-100/, "a 10x score is rejected, not rendered");
assert.throws(() => parseFearGreed(doc({ stock_price_strength: comp(-1, "x") })),
  /outside 0-100/, "a negative component score is rejected");
for (const c of fg.components) {
  assert.ok(c.score >= 0 && c.score <= 100, `${c.key} sits on the 0-100 scale`);
}

// ── history ───────────────────────────────────────────────────────────────────
assert.ok(fg.history.length >= 45 && fg.history.length <= 55,
  `250 daily points sample to ~52 weekly (got ${fg.history.length})`);
assert.equal(fg.history[fg.history.length - 1], 33.3,
  "the newest point is always kept, so the sparkline ends on the headline score");
assert.ok(fg.history.every((v) => typeof v === "number" && Number.isFinite(v)),
  "history is bare numbers — no nulls, no objects");

// Too little history means a truncated payload; better to keep yesterday's file.
const short = doc();
short.fear_and_greed_historical.data = short.fear_and_greed_historical.data.slice(0, 30);
assert.throws(() => parseFearGreed(short), /need 120/, "a truncated history is refused, not written");

console.log("test-feargreed OK");
