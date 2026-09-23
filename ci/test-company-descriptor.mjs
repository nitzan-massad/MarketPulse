// Checks ci/company-descriptor.mjs — the LLM-written identity line under the company name,
// replacing the old sector -> phrase map as the PRIMARY path (that map, `descriptorFor` in
// ci/post-image.mjs, survives only as the deterministic fallback). Strictly offline: `provider`
// is always a fake here, exactly like ci/test-generate-posts.mjs's fake text provider.

import assert from "node:assert";
import {
  buildDescriptorPrompt, describeCompany, sanitizeDescriptor,
} from "./company-descriptor.mjs";
import { descriptorFor } from "./post-image.mjs";

const alphabetRow = {
  t: "GOOGL", n: "Alphabet Inc. Class A", sec: "General", px: 178.4, mc: 2_100_000,
  b: 40, h: 5, s: 1,
  desc: "Alphabet Inc. is a holding company whose subsidiary Google runs a global search " +
        "engine, sells online advertising, and operates YouTube, Android, and Google Cloud.",
};

// ============================================================= buildDescriptorPrompt =========
{
  const { system, prompt } = buildDescriptorPrompt(alphabetRow);
  assert.ok(system.length > 50, "there is a real system prompt");
  assert.ok(/2 to 4 words/i.test(system), "the word-count rule is stated explicitly");
  assert.ok(/no ticker/i.test(system), "the no-ticker rule is stated explicitly");
  assert.ok(/no.*numbers|numbers.*never/i.test(system), "the no-numbers rule is stated explicitly");
  assert.ok(/performance|valuation/i.test(system), "the no-performance/valuation-claims rule is stated");

  assert.ok(prompt.includes("Alphabet"), "the DISPLAY name reaches the prompt");
  assert.equal(prompt.includes("Alphabet Inc. Class A"), false, "the raw legal-entity name never reaches the prompt");
  assert.ok(prompt.includes("General"), "the sector reaches the prompt, so the model can see (and override) it");
  assert.ok(prompt.includes("search"), "the real company description reaches the prompt");
  assert.ok(/analyst coverage: 46 analysts/i.test(prompt), "analyst coverage is computed from b+h+s and labelled");
  assert.ok(/market cap/i.test(prompt) && /share price/i.test(prompt), "market cap and price both reach the prompt");
}
{
  // A row with no `desc` at all (should never happen live — every row has one — but must not
  // crash the prompt builder) still produces a well-formed prompt.
  const { prompt } = buildDescriptorPrompt({ t: "AAA", n: "Alpha Inc", sec: "Technology" });
  assert.ok(prompt.includes("Alpha"), "still names the company with no description available");
  assert.equal(/undefined|null/.test(prompt), false, "a missing desc never leaks as the literal word undefined/null");
}
{
  // A long real-world paragraph is trimmed, not sent verbatim forever — keeps the prompt small.
  const longDesc = "Sentence one. ".repeat(80);
  const { prompt } = buildDescriptorPrompt({ t: "AAA", n: "Alpha Inc", sec: "Technology", desc: longDesc });
  assert.ok(prompt.length < longDesc.length, "an overlong description is trimmed before it reaches the prompt");
}

// ================================================================= sanitizeDescriptor =========
{
  assert.equal(sanitizeDescriptor("shaping how we search"), "shaping how we search",
    "a clean 4-word descriptor passes through unchanged");
  assert.equal(sanitizeDescriptor("  \"powering online advertising\"  "), "powering online advertising",
    "surrounding whitespace and quotes are stripped");
  assert.equal(sanitizeDescriptor("building the modern web."), "building the modern web",
    "a trailing period is stripped");
}
{
  // Constraints: no numbers, no $/%, no ticker, no performance/valuation claims.
  assert.equal(sanitizeDescriptor("up 42% this year"), null, "a percentage sign is rejected");
  assert.equal(sanitizeDescriptor("worth $2 trillion today"), null, "a dollar sign is rejected");
  assert.equal(sanitizeDescriptor("employs 5 people worldwide"), null, "a bare digit is rejected");
  assert.equal(sanitizeDescriptor("a strong buy candidate"), null, "a rating/performance word (buy) is rejected");
  assert.equal(sanitizeDescriptor("undervalued search giant"), null, "a valuation word is rejected");
  assert.equal(sanitizeDescriptor("GOOGL runs the internet", { ticker: "GOOGL" }), null,
    "the company's own ticker is rejected");
  assert.equal(sanitizeDescriptor("runs the internet", { ticker: "GOOGL" }), "runs the internet",
    "a clean descriptor without the ticker still passes with a ticker supplied");
}
{
  // Word-count bounds.
  assert.equal(sanitizeDescriptor("search"), null, "a single word is too short");
  assert.equal(sanitizeDescriptor("this is way too many words to be a real descriptor honestly"), null,
    "a long ramble is rejected outright, not silently truncated");
  assert.equal(sanitizeDescriptor("one two three four five"), "one two three four",
    "a mild overrun (5 words) is trimmed down to 4, not rejected");
}
{
  // Multi-sentence output means the model kept talking past the descriptor.
  assert.equal(sanitizeDescriptor("shaping search. also ads."), null,
    "more than one sentence is rejected");
  assert.equal(sanitizeDescriptor(""), null, "empty input is rejected");
  assert.equal(sanitizeDescriptor(null), null, "null input is rejected");
}

// =================================================================== describeCompany ==========
{
  // Happy path: a clean model response is used verbatim (post-sanitisation) and cached.
  const cache = {};
  const provider = async () => ["shaping how we search"];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d, "shaping how we search", "a valid model descriptor is used as-is");
  assert.equal(cache.GOOGL.descriptor, d, "a successful call is cached by ticker");
  assert.equal(cache.GOOGL.name, "Alphabet", "the cache stores the display name for staleness checks");
}
{
  // Cache hit: the provider must NOT be called at all — reuse per company, not a call per post.
  const cache = { GOOGL: { name: "Alphabet", descriptor: "already cached" } };
  const provider = async () => { throw new Error("must not be called on a cache hit"); };
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d, "already cached", "a cache hit short-circuits before any provider call");
}
{
  // A cache entry under a STALE name (the company was renamed) is not reused.
  const cache = { GOOGL: { name: "Old Name Co", descriptor: "stale descriptor" } };
  const provider = async () => ["fresh accurate descriptor"];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d, "fresh accurate descriptor", "a name mismatch invalidates the cached entry");
}
{
  // Invalid model output (a number leaked in) falls back to the deterministic sector map, and
  // does NOT poison the cache with the bad attempt.
  const cache = {};
  const provider = async () => ["up 42% this year"];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d, descriptorFor("General"), "invalid output falls back to the deterministic sector descriptor");
  assert.equal("GOOGL" in cache, false, "a fallback is never cached, so the next run retries the model");
}
{
  // A throwing provider degrades exactly the same way — never loses the post over this call.
  const provider = async () => { throw new Error("network down"); };
  const d = await describeCompany({ row: alphabetRow, provider, cache: {} });
  assert.equal(d, descriptorFor("General"), "a thrown provider error falls back to the sector descriptor");
}
{
  // No provider at all (image/text generation off, or wiring omitted) still resolves.
  const d = await describeCompany({ row: alphabetRow, cache: {} });
  assert.equal(d, descriptorFor("General"), "no provider at all still falls back cleanly");
}
{
  // The specific case the whole task is about: Alphabet's TipRanks sector is General — the
  // unclassified bucket — so the FALLBACK still reads "too big to label" (unchanged, still
  // correct as a rare-failure fallback), but a WORKING model call must land on something about
  // the real business, never repeat that sector-bucket joke.
  const cache = {};
  const provider = async () => ["mapping the world's information"];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.notEqual(d, "too big to label", "a successful call never falls back to the General joke");
  assert.equal(/search|advertis|information|web/i.test(d), true,
    "Alphabet's real descriptor lands on something about its actual business");
}

console.log("company-descriptor OK — prompt carries display name/sector/cap/price/analysts/desc, " +
            "sanitisation rejects numbers/$/%/ticker/performance-claims/word-count violations, " +
            "describeCompany caches per company, invalidates on a name change, and falls back " +
            "deterministically (never losing the post) on invalid output, a thrown error, or no provider");
