// Checks ci/neuron-usage.mjs — measured-vs-estimated neuron accounting. No network: every
// number here is fed in directly, exactly the shape ci/provider.mjs/ci/post-image.mjs hand it.

import assert from "node:assert";
import { newUsageTracker, recordTextCall, recordImageCall, computeNeuronUsage, formatUsageSummary } from "./neuron-usage.mjs";

// --- an empty tracker costs nothing -------------------------------------------------
{
  const t = newUsageTracker();
  const usage = computeNeuronUsage(t);
  assert.equal(usage.measuredNeurons, 0, "no calls recorded -> zero measured neurons");
  assert.equal(usage.estimatedNeurons, 0, "no calls recorded -> zero estimated neurons");
  assert.equal(usage.totalNeurons, 0);
  assert.equal(usage.percentOfDailyFree, 0);
}

// --- a text call WITH real usage is MEASURED, not estimated -------------------------
{
  const t = newUsageTracker();
  recordTextCall(t, "writer", { prompt_tokens: 1_000_000, completion_tokens: 0 });
  const usage = computeNeuronUsage(t);
  // Cloudflare's documented rate: 26,668 neurons per M INPUT tokens.
  assert.ok(Math.abs(usage.measuredNeurons - 26_668) < 1, "1M input tokens costs the documented input rate, measured exactly");
  assert.equal(usage.estimatedNeurons, 0, "a fully-measured call contributes nothing to the estimate half");
  assert.equal(t.calls.writer, 1, "the call is counted under its own kind");
}
{
  const t = newUsageTracker();
  recordTextCall(t, "descriptor", { prompt_tokens: 0, completion_tokens: 1_000_000 });
  const usage = computeNeuronUsage(t);
  // Cloudflare's documented rate: 204,805 neurons per M OUTPUT tokens — output is billed far
  // more than input, which is exactly why "lead with a short prompt, keep the reply to 8
  // words" matters for the budget, not just for style.
  assert.ok(Math.abs(usage.measuredNeurons - 204_805) < 1, "1M output tokens costs the documented (much higher) output rate");
}

// --- a text call with NO usage object falls back to the estimate half, not silently to zero --
{
  const t = newUsageTracker();
  recordTextCall(t, "writer", { prompt_tokens: 100, completion_tokens: 50 }); // gives a real average to extrapolate from
  recordTextCall(t, "writer", undefined); // Cloudflare (hypothetically) didn't send usage this time
  assert.equal(t.unmeasuredTextCalls, 1, "a call with no usage object is tracked as unmeasured, not dropped");
  const usage = computeNeuronUsage(t);
  assert.ok(usage.estimatedNeurons > 0, "the unmeasured call still contributes a non-zero estimate");
  assert.ok(usage.measuredNeurons > 0, "the OTHER call is still measured for real");
}

// --- a text call whose usage object has NaN/missing fields is treated as unmeasured, not a
// crash and not a bogus zero-cost measurement.
{
  const t = newUsageTracker();
  recordTextCall(t, "writer", { prompt_tokens: "not a number", completion_tokens: null });
  assert.equal(t.unmeasuredTextCalls, 1, "a malformed usage object is treated as unmeasured");
  assert.equal(t.measuredTextCalls, 0, "and never counted as a real measurement");
}

// --- image calls are ALWAYS an estimate — there is no usage field to measure at all ------
{
  const t = newUsageTracker();
  recordImageCall(t);
  recordImageCall(t);
  const usage = computeNeuronUsage(t);
  assert.equal(usage.measuredNeurons, 0, "image calls never contribute to the measured half");
  assert.ok(usage.estimatedNeurons > 0, "two image calls cost a real, non-zero estimate");
  assert.equal(t.calls.image, 2);
  // Documented rate: 4 tiles (1024x1024 default) x 4.80 + 4 steps x 9.60 = ~57.6/image.
  assert.ok(Math.abs(usage.estimatedNeurons - 2 * 57.6) < 1, "the per-image estimate matches Cloudflare's documented tile+step rate");
}

// --- percentOfDailyFree is against the real 10,000/day pool, not some other number -------
{
  const t = newUsageTracker();
  recordTextCall(t, "writer", { prompt_tokens: 5_000_000, completion_tokens: 0 }); // 133,340 neurons — over 100%
  const usage = computeNeuronUsage(t);
  assert.ok(usage.percentOfDailyFree > 100, "a run that blew through the daily pool reports over 100%, not clamped");
}

// --- formatUsageSummary: the measured and estimated halves are BOTH present and labelled,
// never merged into one unlabelled figure — the whole point of the brief.
{
  const t = newUsageTracker();
  recordTextCall(t, "writer", { prompt_tokens: 500, completion_tokens: 40 });
  recordTextCall(t, "writer", { prompt_tokens: 500, completion_tokens: 40 });
  recordTextCall(t, "descriptor", { prompt_tokens: 300, completion_tokens: 20 });
  recordImageCall(t);
  const line = formatUsageSummary(t);
  assert.ok(/MEASURED/.test(line), "the summary explicitly labels the measured half");
  assert.ok(/ESTIMATED/.test(line), "the summary explicitly labels the estimated half");
  assert.ok(/writer=2/.test(line), "the call breakdown names the writer count");
  assert.ok(/descriptor=1/.test(line), "the call breakdown names the descriptor count");
  assert.ok(/image=1/.test(line), "the call breakdown names the image count");
  assert.ok(/%/.test(line) && /10,000/.test(line), "the summary states the percentage of the real 10,000/day pool");
  assert.equal(/measured/i.test(line) && /estimated/i.test(line), true);
}

console.log("neuron-usage OK — measured token->neuron conversion at Cloudflare's documented rate, " +
            "unmeasured/malformed text calls and every image call falling back to the estimate half, " +
            "and the summary line keeping measured and estimated distinctly labelled");
