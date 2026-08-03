// Scale-mixing guard for the AI-analyst score. Run: node ci/test-ai-scale.mjs
//
// The bug this guards against: `forecastFields` in ci/keep.mjs divided the stock-forecast
// payload's `report.score` by 10 on a false premise ("the app's ai is 0–10"). Both sources
// are 0–100 — the screener writes `aiAnalystData.overallScore` undivided, and the frontend
// renders `scoreColor(s.ai, 100)` and a literal `/100` in StockModal. Because that path only
// ever ran for the two pinned tickers, exactly two rows of 344 shipped on the wrong scale —
// TER at 7.8 for a real 71, frozen for 58 commits, painted deep red in every table.
//
// One small number is unfalsifiable on its own; a MIXTURE of scales is not. `aiScaleError`
// (ci/keep.mjs) encodes that, with the "no legitimate score ≤ 10" assumption stated there.
// This file points it at the data we actually ship, and re-checks that the mapping itself
// no longer rescales — the guard and the fix, so neither can rot without the other.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { aiScaleError, forecastFields } from "./keep.mjs";

const path = new URL("../src/data/stocks.json", import.meta.url);
const rows = JSON.parse(readFileSync(path, "utf8"));

// 1. the mapping must not rescale: 78 in → 78 out (this is what regressed)
const fj = { models: { stocks: [{ _id: "TER", report: { score: 78 } }] } };
assert.equal(forecastFields(fj, "TER").ai, 78, "forecastFields must NOT divide report.score by 10");

// 1b. POSITIVE CONTROL — the check below trusts `aiScaleError`'s verdict on the real file,
// so prove the guard still bites before believing an "OK". Without this, neutering
// aiScaleError to `return null` would make this file pass forever while the data rots.
// The control is derived from the SHIPPED rows, not a synthetic column: rescale them by
// the exact /10 that regressed and the guard must name the offenders.
assert.ok(
  aiScaleError([{ t: "CTRL", ai: 7.8 }, { t: "OK", ai: 79 }]),
  "positive control: aiScaleError no longer flags a 0-10 row mixed into a 0-100 column — the guard has been neutered",
);
const scoredRows = rows.filter((r) => r.ai != null && Number.isFinite(Number(r.ai)));
if (scoredRows.length >= 2) {
  const rescaled = rows.map((r, i) => (i === 0 && r.ai != null ? { ...r, ai: +(Number(r.ai) / 10).toFixed(1) } : r));
  assert.ok(
    aiScaleError(rescaled),
    "positive control: rescaling ONE shipped row by /10 no longer trips the guard — a repeat of the original bug would ship undetected",
  );
}
// Note: `aiScaleError(rows, floor)` must be called WITHOUT a floor here. The parameter is
// the low/high split point, so LOWERING it silences the guard rather than tightening it.

// 2. the shipped data must be on one scale
const err = aiScaleError(rows);
const scored = rows.filter((r) => r.ai != null);
if (err) {
  console.error(`FAIL src/data/stocks.json (${rows.length} rows, ${scored.length} scored)\n  ${err}`);
  console.error("  Fix the rows, don't relax the guard: `ai` is 0–100 on both sources.");
  process.exit(1);
}
const vals = scored.map((r) => Number(r.ai));
console.log(
  `ai-scale OK — ${scored.length}/${rows.length} rows scored, spread ${Math.min(...vals)}–${Math.max(...vals)} (0–100)`,
);
