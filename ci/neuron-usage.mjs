// NEURON ACCOUNTING — measures what Cloudflare actually tells us, estimates what it doesn't,
// and never lets the two look alike in the printed summary.
//
// THE OLD "~15% a day" ESTIMATE WAS WORTHLESS THE MOMENT THE WRITER STOPPED BEING AN 8B MODEL.
// It was a guess made against `@cf/meta/llama-3.1-8b-instruct`; the writer is now
// `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (ci/provider.mjs), there is a real Flux image on
// EVERY post (ci/post-image.mjs), and a descriptor/scene call on every PUBLISHED post
// (ci/company-descriptor.mjs) — three different call shapes against the same 10,000/day pool,
// and nothing anywhere measured or reported what any of them actually cost. This module is
// that measurement.
//
// WHAT CLOUDFLARE ACTUALLY RETURNS (checked against the real, documented API schema — not
// assumed — while building this module; see the per-model comments below and
// ci/README.md's "Neuron accounting" section for the sources):
//   - The TEXT model's JSON response (`result` in ci/provider.mjs's cloudflare branch) carries
//     a real `usage` object: `{ prompt_tokens, completion_tokens, total_tokens }`
//     (Cloudflare's own published response schema for `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
//     — this is a real, measured count of what that ONE call actually did, not a guess) — but
//     it NEVER carries a neuron count directly. Both the writer's candidates and the
//     descriptor call go through this same shape, since they share ci/provider.mjs.
//   - The IMAGE model's response (`@cf/black-forest-labs/flux-1-schnell`) has no documented
//     response schema beyond `{ result: { image: <base64> } }` — no tokens, no usage, nothing
//     to measure at all (ci/post-image.mjs's own parsing, unchanged by this work).
//
import { FLUX_STEPS } from "./post-image.mjs";

// SO: text calls get a MEASURED neuron figure — real token counts straight from Cloudflare,
// converted to neurons via Cloudflare's own documented per-million-token rate for the model in
// use. Image calls get an ESTIMATE — a call count multiplied by Cloudflare's own documented
// per-image rate, since there is no per-call number to measure at all. `formatUsageSummary`
// below prints both halves SEPARATELY and labelled, on purpose — a measured number and an
// estimate must not look alike, per the brief.

/** `@cf/meta/llama-3.3-70b-instruct-fp8-fast`'s documented rate (Cloudflare Workers AI pricing
 *  page, verified live 2026-09-24: "26668 neurons per M input tokens", "204805 neurons per M
 *  output tokens"). Used as the FALLBACK rate for any other model name too (`CF_MODEL` can
 *  override which model actually runs) — `textRateFor` below applies it either way, and
 *  `computeNeuronUsage`'s caller is told when that happened is not tracked further than this
 *  comment, since in practice this pipeline has only ever run one text model at a time. */
const DEFAULT_TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TEXT_NEURON_RATES = {
  [DEFAULT_TEXT_MODEL]: { perMillionInput: 26_668, perMillionOutput: 204_805 },
};

/** `@cf/black-forest-labs/flux-1-schnell`'s documented rate, same source/date as above: 4.80
 *  neurons per 512x512 OUTPUT tile, 9.60 neurons per diffusion step — two separate documented
 *  components of one generation's cost, added together. `FLUX_STEPS` is imported from
 *  ci/post-image.mjs (not restated) so the two can never drift apart; the tile count assumes
 *  that module's own default 1024x1024 output (it never sets width/height on the request), i.e.
 *  4 tiles of 512x512. */
const FLUX_TILE_NEURON_RATE = 4.80;
const FLUX_STEP_NEURON_RATE = 9.60;
const FLUX_DEFAULT_OUTPUT_TILES = 4;

/** Exported so ci/run-telemetry.mjs's cost-per-post/headroom maths (Task: run telemetry) never
 *  restates this number a second place it could drift out of sync with. */
export const DAILY_FREE_NEURONS = 10_000;

/** A fresh, empty accumulator for one run. `model` should be whatever `CF_MODEL` actually
 *  resolves to (main() passes it in) so `computeNeuronUsage` charges the RIGHT documented rate
 *  rather than silently assuming the default model ran. */
export function newUsageTracker(model) {
  return {
    model: model || DEFAULT_TEXT_MODEL,
    calls: { writer: 0, descriptor: 0, image: 0 },
    measuredPromptTokens: 0,
    measuredCompletionTokens: 0,
    measuredTextCalls: 0,
    // A text call that SUCCEEDED but carried no `usage` object at all — should not happen
    // against the documented schema, but never assumed away; falls back to an estimate too,
    // see `computeNeuronUsage`.
    unmeasuredTextCalls: 0,
    imageCalls: 0,
  };
}

/**
 * Record one SUCCESSFUL text call (a writer candidate or a descriptor call) — never a failed
 * one, since a rejected/errored call was never actually billed by Cloudflare. `kind` is
 * `"writer"` or `"descriptor"`; `usage` is exactly whatever Cloudflare returned under
 * `result.usage` for THIS call (`undefined` if the shape ever lacks it).
 */
export function recordTextCall(tracker, kind, usage) {
  tracker.calls[kind] = (tracker.calls[kind] ?? 0) + 1;
  const prompt = Number(usage?.prompt_tokens);
  const completion = Number(usage?.completion_tokens);
  if (Number.isFinite(prompt) && Number.isFinite(completion)) {
    tracker.measuredPromptTokens += prompt;
    tracker.measuredCompletionTokens += completion;
    tracker.measuredTextCalls++;
  } else {
    tracker.unmeasuredTextCalls++;
  }
}

/** Record one SUCCESSFUL Flux call — see the module header on why this can only ever feed the
 *  ESTIMATE half of the summary (the image endpoint's response carries no usage field to
 *  measure, full stop). */
export function recordImageCall(tracker) {
  tracker.calls.image = (tracker.calls.image ?? 0) + 1;
  tracker.imageCalls++;
}

function textRateFor(model) {
  return TEXT_NEURON_RATES[model] ?? TEXT_NEURON_RATES[DEFAULT_TEXT_MODEL];
}

/**
 * The full neuron accounting for one run so far: a MEASURED figure from real token counts
 * (whatever fraction of text calls actually reported `usage`), plus an ESTIMATE for everything
 * that didn't (any unmeasured text call, and EVERY image call) — summed into one total, but the
 * two halves are always returned separately, never pre-merged, so a caller can never
 * accidentally present an estimate as a measurement.
 */
export function computeNeuronUsage(tracker) {
  const rate = textRateFor(tracker.model);
  const measuredNeurons =
    (tracker.measuredPromptTokens / 1_000_000) * rate.perMillionInput +
    (tracker.measuredCompletionTokens / 1_000_000) * rate.perMillionOutput;

  // The only number available for a text call Cloudflare didn't hand real tokens back for:
  // this run's own measured average per call, when there is at least one real sample to
  // average (closer to reality than a blind guess) — or a small fixed floor (a short system
  // prompt + an 8-word reply is a few hundred tokens either way) when NOTHING this run was
  // measured at all, which should not happen against the documented schema but is never
  // assumed away.
  const avgMeasuredPerTextCall = tracker.measuredTextCalls
    ? measuredNeurons / tracker.measuredTextCalls
    : ((rate.perMillionInput + rate.perMillionOutput) / 2 / 1_000_000) * 300;
  const estimatedTextNeurons = tracker.unmeasuredTextCalls * avgMeasuredPerTextCall;

  const neuronsPerImage = FLUX_DEFAULT_OUTPUT_TILES * FLUX_TILE_NEURON_RATE + FLUX_STEP_NEURON_RATE * FLUX_STEPS;
  const estimatedImageNeurons = tracker.imageCalls * neuronsPerImage;

  const estimatedNeurons = estimatedTextNeurons + estimatedImageNeurons;
  const totalNeurons = measuredNeurons + estimatedNeurons;

  return {
    measuredNeurons,
    estimatedNeurons,
    totalNeurons,
    percentOfDailyFree: (totalNeurons / DAILY_FREE_NEURONS) * 100,
  };
}

/** The one summary line the brief asks for — printed once at the end of a run
 *  (ci/generate-posts.mjs's main()). Calls broken down by kind, then the neuron total as
 *  MEASURED + ESTIMATED, never merged into one unlabelled number, then that total as a percent
 *  of the 10,000/day free allocation. */
export function formatUsageSummary(tracker) {
  const { measuredNeurons, estimatedNeurons, totalNeurons, percentOfDailyFree } = computeNeuronUsage(tracker);
  const totalCalls = tracker.calls.writer + tracker.calls.descriptor + tracker.calls.image;
  return (
    `neuron usage — ${totalCalls} Cloudflare call(s) ` +
    `(writer=${tracker.calls.writer}, descriptor=${tracker.calls.descriptor}, image=${tracker.calls.image}) — ` +
    `${Math.round(measuredNeurons)} neurons MEASURED (real token usage) + ` +
    `${Math.round(estimatedNeurons)} neurons ESTIMATED (documented per-call rates) = ` +
    `~${Math.round(totalNeurons)} neurons, ${percentOfDailyFree.toFixed(1)}% of the ` +
    `${DAILY_FREE_NEURONS.toLocaleString()}/day free allocation`
  );
}
