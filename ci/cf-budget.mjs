// THE SHARED "IS TODAY'S FREE ALLOCATION GONE" FLAG. Cloudflare Workers AI's 10,000
// neurons/day is ONE account-wide budget, shared by every model this pipeline calls — the
// writer's candidates (ci/provider.mjs), the descriptor (ci/company-descriptor.mjs, same
// provider), and the image (ci/post-image.mjs, its own direct fetch). A 429 carrying error
// code 4006 ("you have used up your daily free allocation of 10,000 neurons") means every
// OTHER Cloudflare call this run — and every call for the rest of today, until the daily
// reset — will fail the exact same way.
//
// BEFORE THIS MODULE, that looked like five (or fifty) identical "candidate failed:
// cloudflare 429" lines — one per doomed parallel candidate, repeated for every hook the run
// tried afterward — with the real cause (a specific, documented exhaustion code, not a
// generic rate limit) never even printed. This is the fix: detect that one specific code,
// log ONE clear line naming it the first time it is seen, and let every other call site
// (ci/provider.mjs's cloudflare batch, ci/post-image.mjs's generateImage,
// ci/company-descriptor.mjs's describeCompany) skip straight to "there is no point calling"
// instead of making — and separately logging — the same doomed request all over again.
//
// MODULE-LEVEL STATE IS DELIBERATE HERE, unlike the rest of this pipeline's "no class, inject
// everything" posture (ci/provider.mjs, ci/post-image.mjs, ci/company-photo.mjs all take an
// injectable `fetchImpl` instead). This represents ONE real, singular fact about the ONE
// Cloudflare account a single `node ci/generate-posts.mjs` process talks to for its entire
// run — not a dependency worth threading through half a dozen function signatures just to
// keep it out of a module-level variable. `resetForTest()` exists solely so a check can
// restore a clean slate between assertions in the same process (see ci/test-cf-budget.mjs) —
// production code never calls it.

/** Cloudflare's own documented code for "daily free neuron allocation exhausted" — the one
 *  this whole module exists to recognise. Not a generic 429/rate-limit code. */
export const CF_DAILY_ALLOCATION_EXHAUSTED_CODE = 4006;

let exhausted = false;

export function isExhausted() {
  return exhausted;
}

/**
 * True when `err` is (or carries) Cloudflare's specific daily-allocation-exhausted error.
 * Checked first against a `.cfCode` property — set by ci/provider.mjs's cloudflare branch and
 * ci/post-image.mjs's `generateImage`, both of which read the real JSON error body on a
 * non-ok response (`{ errors: [{ code, message }], … }`, Cloudflare's documented error shape)
 * — and, as a looser fallback for an error that reached here some other way, the literal code
 * appearing anywhere in the error's message.
 */
export function isExhaustionError(err) {
  if (!err) return false;
  if (err.cfCode === CF_DAILY_ALLOCATION_EXHAUSTED_CODE) return true;
  return new RegExp(`\\b${CF_DAILY_ALLOCATION_EXHAUSTED_CODE}\\b`).test(String(err.message ?? err));
}

/**
 * Idempotent — the FIRST call this process makes logs the one clear line the whole module
 * exists for; every later call (from any of the three call sites above, for the rest of this
 * run) is a silent no-op, which is exactly what stops the line from repeating.
 */
export function markExhausted() {
  if (exhausted) return;
  exhausted = true;
  console.error(
    `  Cloudflare Workers AI: the daily free allocation of 10,000 neurons is exhausted ` +
    `(error code ${CF_DAILY_ALLOCATION_EXHAUSTED_CODE}) — ending this run without generating ` +
    "further content. The allocation resets daily; this is not a bug and does not need retrying.",
  );
}

/** Test-only reset — see the module header. Never called from production code. */
export function resetForTest() {
  exhausted = false;
}
