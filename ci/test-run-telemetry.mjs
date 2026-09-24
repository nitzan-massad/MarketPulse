// Checks ci/run-telemetry.mjs — per-stage neuron accounting, cost-per-post, candidate waste
// tallying, headroom/history maths, and the summary block. Everything here is pure (no fs, no
// network, no Date.now() reached into) — see the module's own header on why.

import assert from "node:assert";
import {
  classifyRejectionReason, newRunTelemetry, recordStageMs, recordHookAttempt, recordHookPublished,
  recordCandidateOutcomes, neuronsPerPublishedPost, dailyPostCapacity, computeHeadroom, utcDateKey,
  sumNeuronsForDate, trimHistory, buildHistoryRecord, formatSummaryBlock, perStageUsage,
  totalNeuronsForRun, estimateRunCostFromHistory, CRON_RUNS_PER_DAY, NEURON_HISTORY_KEEP,
} from "./run-telemetry.mjs";
import { newUsageTracker, recordTextCall, recordImageCall } from "./neuron-usage.mjs";
import { rankCandidates } from "./post-score.mjs";

// ------------------------------------------------------------- classifyRejectionReason -------
assert.equal(classifyRejectionReason(["unverified numbers not in the hook's facts: 99%"]), "fabricated number");
assert.equal(classifyRejectionReason(["names the ticker AAA instead of the company"]), "contains a ticker");
assert.equal(classifyRejectionReason(["movement verb misdescribes a target/score/forecast number: soared"]), "banned movement verb");
assert.equal(classifyRejectionReason(["claims a timeframe the data cannot support: overnight"]), "misdescribed timeframe");
assert.equal(classifyRejectionReason(["too long (12 words > 8)"]), "over the 8-word cap");
assert.equal(classifyRejectionReason(["duplicate of a recent post (61% word overlap)"]), "duplicate of a recent post");
assert.equal(classifyRejectionReason(["too short (2 words < 3)"]), "too short");
assert.equal(classifyRejectionReason(["no numbers — not a data post"]), "no numbers");
assert.equal(classifyRejectionReason(['banned phrase: "let\'s dive in"']), "banned phrase");
assert.equal(classifyRejectionReason(["AAA appeared in a recent post"]), "ticker repeated from a recent post");
assert.equal(classifyRejectionReason(["3 hashtags"]), "other", "an unrecognised/minor reason falls to \"other\", not a crash");
assert.equal(classifyRejectionReason([]), "other", "an empty reasons array is \"other\", not a throw");
assert.equal(classifyRejectionReason(undefined), "other", "undefined reasons never throws");
// Priority: the MOST SEVERE reason wins when a candidate carries several.
assert.equal(
  classifyRejectionReason(["too long (12 words > 8)", "unverified numbers not in the hook's facts: 99%"]),
  "fabricated number",
  "fabrication outranks a merely-too-long candidate — it is the more decisive, higher-penalty rule",
);

console.log("classifyRejectionReason OK — every scorePost reason bucketed correctly, severity-ordered, never throws on empty/unknown input");

// ------------------------------------------------------------------------ accumulator --------
{
  const t = newRunTelemetry({});
  recordStageMs(t, "writer", 120);
  recordStageMs(t, "writer", 80);
  recordStageMs(t, "descriptor", 40);
  assert.equal(t.stageMs.writer, 200, "stage time accumulates across multiple calls");
  assert.equal(t.stageMs.descriptor, 40);
  assert.equal(t.stageMs.image, 0, "an untouched stage stays at zero, not undefined");
  recordStageMs(t, "writer", -50);
  assert.equal(t.stageMs.writer, 200, "a negative/bogus duration never DECREASES the accumulated time");
}
{
  const t = newRunTelemetry({});
  recordHookAttempt(t, "surprise");
  recordHookAttempt(t, "surprise");
  recordHookPublished(t, "surprise");
  recordHookAttempt(t, "movement");
  assert.deepEqual(t.hookOutcomes.surprise, { attempted: 2, published: 1 });
  assert.deepEqual(t.hookOutcomes.movement, { attempted: 1, published: 0 });
}

// ------------------------------------------------------------- recordCandidateOutcomes --------
{
  const t = newRunTelemetry({});
  const hook = { kind: "surprise", ticker: "NVDA", name: "Nvidia", facts: { upside: 42, analysts: 25 } };
  const texts = [
    "Let's dive in! A game-changer.",                          // no numbers -> rejected
    "42% upside, 25 analysts covering it.",                    // real, in-band -> should win
    "99% upside on totally invented numbers here today.",      // fabricated -> rejected
    "42% upside, 25 analysts covering it, definitely for real.", // same real number, too long -> rejected (over cap)
  ];
  const ranked = rankCandidates(texts, { hook, recent: [] });
  const winner = ranked[0].score >= 30 ? ranked[0] : null;
  recordCandidateOutcomes(t, { ranked, winnerText: winner ? winner.text : null });
  assert.equal(t.candidates.generated, 4, "every candidate is counted as generated");
  assert.equal(t.candidates.used, winner ? 1 : 0, "exactly the winner (if any) is \"used\"");
  assert.equal(
    t.candidates.used + t.candidates.outscored + t.candidates.rejected,
    t.candidates.generated,
    "every candidate lands in exactly one bucket — none counted twice, none dropped",
  );
  assert.ok(Object.keys(t.rejectionReasons).length > 0, "at least one rejection reason was tallied");
}
{
  // No winner at all: every candidate is either outscored (>=30 but not chosen — impossible
  // when there IS no winner, so this degenerates to "every candidate that scored >=30 would
  // have BEEN the winner") or rejected. Exercised directly with winnerText: null.
  const t = newRunTelemetry({});
  const ranked = [{ text: "a", score: 10, reasons: ["no numbers — not a data post"] }];
  recordCandidateOutcomes(t, { ranked, winnerText: null });
  assert.equal(t.candidates.rejected, 1);
  assert.equal(t.rejectionReasons["no numbers"], 1);
}
{
  const t = newRunTelemetry({});
  recordCandidateOutcomes(t, { ranked: [], winnerText: null });
  assert.equal(t.candidates.generated, 0, "an empty ranked list never throws and adds nothing");
}

console.log("recordCandidateOutcomes OK — every candidate bucketed exactly once (used/outscored/rejected), reasons tallied");

// ------------------------------------------------------------------ cost / capacity -----------
assert.equal(neuronsPerPublishedPost(500, 0), null, "zero published posts -> no cost-per-post (never a divide-by-zero number)");
assert.equal(neuronsPerPublishedPost(500, null), null);
assert.equal(neuronsPerPublishedPost(500, 5), 100, "500 neurons / 5 posts = 100 neurons/post");
assert.equal(dailyPostCapacity(null), null, "no cost-per-post -> no daily capacity figure");
assert.equal(dailyPostCapacity(0), null, "a zero cost never implies infinite capacity");
assert.equal(dailyPostCapacity(100), 100, "10,000 / 100 = 100 posts/day");
assert.equal(dailyPostCapacity(3000), 3, "rounds DOWN — a fraction of a post is not a post");
assert.ok(Math.abs(CRON_RUNS_PER_DAY - 4.8) < 1e-9, "the cron cadence this compares against is 24/5 = 4.8 runs/day");

console.log("cost/capacity OK — neurons-per-post and daily-capacity maths, including the null-on-no-data cases");

// ------------------------------------------------------------------------- headroom -----------
{
  const h = computeHeadroom(2000, 500);
  assert.equal(h.usedTotal, 2500);
  assert.equal(h.remaining, 7500);
  assert.ok(Math.abs(h.percentUsed - 25) < 1e-9);
}
{
  const h = computeHeadroom(9800, 500);
  assert.equal(h.remaining, 0, "headroom never goes negative — the real floor is zero, not debt");
}
{
  const h = computeHeadroom(undefined, undefined);
  assert.equal(h.usedTotal, 0, "missing/undefined inputs degrade to zero, never NaN");
  assert.equal(Number.isNaN(h.percentUsed), false);
}

console.log("computeHeadroom OK — sums correctly, clamps at zero, never produces NaN on bad input");

// --------------------------------------------------------------------------- history ----------
assert.equal(utcDateKey(Date.UTC(2026, 8, 24, 23, 59)), "2026-09-24", "the UTC date, not a local one — the allocation resets at 00:00 UTC");
assert.equal(utcDateKey(Date.UTC(2026, 8, 24, 0, 0)), "2026-09-24");

{
  const history = [
    { date: "2026-09-23", totalNeurons: 100 },
    { date: "2026-09-24", totalNeurons: 200 },
    { date: "2026-09-24", totalNeurons: 50 },
    { date: "2026-09-24", totalNeurons: "not a number" },
  ];
  assert.equal(sumNeuronsForDate(history, "2026-09-24"), 250, "sums only today's records, ignoring a malformed one rather than NaN-poisoning the total");
  assert.equal(sumNeuronsForDate(history, "2099-01-01"), 0, "a date with no records at all sums to zero");
  assert.equal(sumNeuronsForDate(undefined, "2026-09-24"), 0, "undefined history never throws");
}
{
  const history = Array.from({ length: 10 }, (_, i) => ({ n: i }));
  const trimmed = trimHistory(history, 3);
  assert.deepEqual(trimmed.map((r) => r.n), [7, 8, 9], "keeps the MOST RECENT `keep` records, oldest dropped first");
  assert.equal(trimHistory(history, 100).length, 10, "keep larger than the list just returns everything");
  assert.deepEqual(trimHistory(undefined, 5), [], "undefined history trims to an empty array, not a throw");
}
{
  assert.equal(estimateRunCostFromHistory([]), null, "no history at all -> no estimate (never a made-up number)");
  const history = [{ totalNeurons: 100 }, { totalNeurons: 200 }, { totalNeurons: 300 }];
  assert.equal(estimateRunCostFromHistory(history, { sampleSize: 3 }), 200, "a plain average of the sampled recent runs");
}

console.log("history maths OK — UTC date keys, per-date summing (malformed records ignored), bounded trimming, and the recent-average cost estimate");

// ---------------------------------------------------------------------- buildHistoryRecord -----
{
  const writer = newUsageTracker("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  const descriptor = newUsageTracker();
  const image = newUsageTracker();
  recordTextCall(writer, "writer", { prompt_tokens: 400, completion_tokens: 20 });
  recordImageCall(image);
  const t = newRunTelemetry({ writer, descriptor, image });
  recordHookAttempt(t, "surprise");
  recordHookPublished(t, "surprise");

  const record = buildHistoryRecord(t, { publishedCount: 1, ts: Date.UTC(2026, 8, 24, 12, 0) });
  assert.equal(record.date, "2026-09-24");
  assert.equal(record.publishedCount, 1);
  assert.equal(record.calls.writer, 1);
  assert.equal(record.calls.image, 1);
  assert.ok(record.totalNeurons > 0, "a real total is computed");
  assert.equal(record.totalNeurons, Math.round((record.measuredNeurons + record.estimatedNeurons) * 100) / 100,
    "measured + estimated reconstructs the total exactly");
  // Small on purpose (see the module header) — no raw candidate text, no reasons arrays.
  const json = JSON.stringify(record);
  assert.ok(json.length < 2000, "one history record stays compact — this lands in git every run");
  assert.ok(Math.abs(totalNeuronsForRun(t) - record.totalNeurons) < 0.01,
    "totalNeuronsForRun agrees with the record it feeds (record rounds to 2dp for storage)");
}

console.log("buildHistoryRecord OK — compact, correct totals, matches totalNeuronsForRun");

// ------------------------------------------------------------------------ perStageUsage -------
{
  const p = perStageUsage({});
  assert.deepEqual(p.writer, { measuredNeurons: 0, estimatedNeurons: 0, totalNeurons: 0, percentOfDailyFree: 0 },
    "a missing tracker for a stage degrades to a correct all-zero entry, not a throw");
}

// -------------------------------------------------------------------- formatSummaryBlock ------
{
  const writer = newUsageTracker();
  const descriptor = newUsageTracker();
  const image = newUsageTracker();
  recordTextCall(writer, "writer", { prompt_tokens: 500, completion_tokens: 40 });
  recordTextCall(descriptor, "descriptor", { prompt_tokens: 300, completion_tokens: 20 });
  recordImageCall(image);
  const t = newRunTelemetry({ writer, descriptor, image });
  recordStageMs(t, "writer", 1000);
  recordStageMs(t, "descriptor", 300);
  recordStageMs(t, "image", 2500);
  recordHookAttempt(t, "surprise");
  recordHookPublished(t, "surprise");
  recordHookAttempt(t, "movement");
  t.candidates = { generated: 5, used: 1, outscored: 1, rejected: 3 };
  t.rejectionReasons = { "fabricated number": 2, "over the 8-word cap": 1 };

  const headroom = computeHeadroom(0, totalNeuronsForRun(t));
  const block = formatSummaryBlock(t, { publishedCount: 1, headroom, historyNote: "3 run(s) in history." });
  assert.equal(typeof block, "string");
  assert.ok(block.includes("NEURON USAGE SUMMARY"), "has a clear title");
  assert.ok(block.includes("writer") && block.includes("descriptor") && block.includes("image"), "names all three stages");
  assert.ok(block.includes("neurons/post"), "reports the cost-per-post figure");
  assert.ok(block.includes("fits in the free tier") || block.includes("fit in the free tier"), "reports the daily capacity implication");
  assert.ok(block.includes("fabricated number: 2"), "reports the rejection reason breakdown");
  assert.ok(block.includes("surprise 1/1") && block.includes("movement 0/1"), "reports per-hook-kind outcomes");
  assert.ok(block.includes("Headroom"), "reports headroom");
  assert.ok(block.includes("3 run(s) in history."), "carries the caller's history note through verbatim");

  // No post published: must not crash formatting a "no cost-per-post" branch.
  const t2 = newRunTelemetry({ writer: newUsageTracker(), descriptor: newUsageTracker(), image: newUsageTracker() });
  const block2 = formatSummaryBlock(t2, { publishedCount: 0, headroom: computeHeadroom(0, 0) });
  assert.ok(/no post published/i.test(block2), "explicitly says so rather than printing a bogus 0 neurons/post");
}

console.log("formatSummaryBlock OK — one aligned block naming every stage, cost-per-post, daily capacity, waste breakdown, hook-kind outcomes, and headroom");

console.log("run-telemetry OK — rejection classification, candidate/hook accounting, cost/headroom/history maths, and the summary block, all pure and all offline");
