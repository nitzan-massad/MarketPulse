// Guards ci/scrape-feargreed.mjs's trim of CNN's payload.
//
// The bugs this exists to catch, in the order they would actually bite:
//   1. a reshaped CNN document silently producing a gauge with no components
//   2. a score arriving on the wrong scale (the ÷10 class of bug that shipped once before)
//   3. the sparkline's last point drifting away from the headline score
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseFearGreed } from "./scrape-feargreed.mjs";

const comp = (score, rating) => ({ score, rating, data: [{ x: 1, y: score, rating }] });

function doc(over = {}) {
  const history = [];
  const DAY = 86400000;
  const START = Date.UTC(2025, 8, 15);
  for (let i = 0; i < 250; i++) history.push({ x: START + i * DAY, y: 20 + (i % 40) });
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
assert.equal(fg.history[fg.history.length - 1].v, 33.3,
  "the newest point is always kept, so the sparkline ends on the headline score");
assert.ok(fg.history.every((p) => Number.isFinite(p.v) && p.v >= 0 && p.v <= 100),
  "every history value is a finite 0-100 number");

// ── history dates ─────────────────────────────────────────────────────────────
// Each point carries its own date because the samples are every 5th TRADING day —
// counting back a week per index drifts across holidays, and the chart labels the
// dates of the year's high and low, so a derived date would be quietly wrong.
assert.ok(fg.history.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.d)),
  "every history point carries an ISO date");
assert.equal(fg.history[fg.history.length - 1].d, "2026-05-22",
  "the newest point keeps CNN's own timestamp, not a derived one");
const times = fg.history.map((p) => Date.parse(p.d));
assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]),
  "history runs oldest-first and strictly increases");

const missingX = doc();
missingX.fear_and_greed_historical.data = missingX.fear_and_greed_historical.data.map((p) => ({ y: p.y }));
assert.throws(() => parseFearGreed(missingX), /no timestamp/,
  "a history point without a timestamp fails the run rather than shipping a wrong date");

// Too little history means a truncated payload; better to keep yesterday's file.
const short = doc();
short.fear_and_greed_historical.data = short.fear_and_greed_historical.data.slice(0, 30);
assert.throws(() => parseFearGreed(short), /need 120/, "a truncated history is refused, not written");

// ── the file that actually ships ──────────────────────────────────────────────
// Everything above tests the parser against a fixture. This reads the COMMITTED file,
// which is the thing the app imports and the thing a bad CI run (or a botched conflict
// resolution) would corrupt. Added after a rebase committed a feargreed.json full of
// merge-conflict markers and the whole suite still went green — `npm run build` caught
// it, but the DATA GATE is supposed to catch it first.
const OUT = "src/data/feargreed.json";
if (existsSync(OUT)) {
  const raw = readFileSync(OUT, "utf8");
  assert.ok(!/^(<{7}|={7}|>{7})/m.test(raw), `${OUT} contains merge-conflict markers`);

  let live;
  assert.doesNotThrow(() => { live = JSON.parse(raw); }, `${OUT} is not valid JSON`);

  assert.ok(live.score >= 0 && live.score <= 100, "shipped score is on the 0-100 scale");
  assert.equal(live.components.length, 7, "shipped file carries all seven components");
  assert.ok(live.components.every((c) => c.score >= 0 && c.score <= 100 && c.label),
    "every shipped component has a label and a 0-100 score");

  assert.ok(Array.isArray(live.history) && live.history.length >= 20,
    "shipped history has enough points to draw a year");
  assert.ok(live.history.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.d) && Number.isFinite(p.v)),
    "every shipped history point is {d: ISO date, v: number} — the shape the chart reads");
  const t = live.history.map((p) => Date.parse(p.d));
  assert.ok(t.every((x, i) => i === 0 || x > t[i - 1]), "shipped history is oldest-first");
  assert.equal(live.history[live.history.length - 1].v, live.score,
    "the newest history point matches the headline, so the chart ends where the dial points");
}

console.log("test-feargreed OK");
