// Checks ci/company-descriptor.mjs — the LLM-written identity line AND image scene, both from
// ONE model call per company, replacing the old sector -> phrase maps as the PRIMARY path (those
// maps, `descriptorFor`/`sectorScenePhrase` in ci/post-image.mjs, survive only as the
// deterministic fallback for BOTH halves together). Strictly offline: `provider` is always a
// fake here, exactly like ci/test-generate-posts.mjs's fake text provider.

import assert from "node:assert";
import {
  buildDescriptorPrompt, describeCompany, parseModelResponse, sanitizeDescriptor, sanitizeScene,
} from "./company-descriptor.mjs";
import { descriptorFor, sectorScenePhrase } from "./post-image.mjs";

const alphabetRow = {
  t: "GOOGL", n: "Alphabet Inc. Class A", sec: "General", px: 178.4, mc: 2_100_000,
  b: 40, h: 5, s: 1,
  desc: "Alphabet Inc. is a holding company whose subsidiary Google runs a global search " +
        "engine, sells online advertising, and operates YouTube, Android, and Google Cloud.",
};

/** A well-formed two-line model response, the shape `describeCompany` expects to parse. */
const modelReply = (descriptor, scene) => `DESCRIPTOR: ${descriptor}\nSCENE: ${scene}`;

// ============================================================= buildDescriptorPrompt =========
{
  const { system, prompt } = buildDescriptorPrompt(alphabetRow);
  assert.ok(system.length > 50, "there is a real system prompt");
  assert.ok(/2 to 4 words/i.test(system), "the descriptor word-count rule is stated explicitly");
  assert.ok(/no ticker/i.test(system), "the no-ticker rule is stated explicitly");
  assert.ok(/no.*numbers|numbers.*never/i.test(system), "the no-numbers rule is stated explicitly");
  assert.ok(/performance|valuation/i.test(system), "the no-performance/valuation-claims rule is stated");
  // One call, two parts — the system prompt must ask for both, in a parseable labelled format.
  assert.ok(/scene/i.test(system), "the system prompt asks for a SCENE, not just a descriptor");
  assert.ok(/DESCRIPTOR:/.test(system) && /SCENE:/.test(system),
    "the system prompt specifies the exact DESCRIPTOR:/SCENE: labelled output format");
  assert.ok(/pronoun|gender/i.test(system), "the scene rule bans a pronoun/gender word, chosen separately");
  assert.ok(/6 to 20 words/i.test(system), "the scene word-count rule is stated explicitly");

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

// ================================================================= parseModelResponse =========
{
  const { descriptorRaw, sceneRaw } = parseModelResponse(modelReply("shaping how we search", "engineer inspecting servers, hands on the rack, mid-motion"));
  assert.equal(descriptorRaw, "shaping how we search", "the DESCRIPTOR line is extracted");
  assert.equal(sceneRaw, "engineer inspecting servers, hands on the rack, mid-motion", "the SCENE line is extracted");
}
{
  // Order-independent — the model is not guaranteed to put DESCRIPTOR first.
  const { descriptorRaw, sceneRaw } = parseModelResponse("SCENE: a scene here\nDESCRIPTOR: a descriptor here");
  assert.equal(descriptorRaw, "a descriptor here", "DESCRIPTOR is found regardless of line order");
  assert.equal(sceneRaw, "a scene here", "SCENE is found regardless of line order");
}
{
  // A missing label yields null for that half, not a crash or a swallowed neighbour.
  const { descriptorRaw, sceneRaw } = parseModelResponse("DESCRIPTOR: only a descriptor, no scene at all");
  assert.equal(descriptorRaw, "only a descriptor, no scene at all", "the present label still parses");
  assert.equal(sceneRaw, null, "a missing SCENE label yields null, not the descriptor's text");
}
{
  const { descriptorRaw, sceneRaw } = parseModelResponse("");
  assert.equal(descriptorRaw, null, "an empty response yields null for both halves");
  assert.equal(sceneRaw, null, "an empty response yields null for both halves");
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

// ===================================================================== sanitizeScene ==========
{
  const clean = "engineer inspecting a rack of servers in a data centre hall, hands on the cabling, mid-motion";
  assert.equal(sanitizeScene(clean), clean, "a clean scene passes through unchanged");
  assert.equal(sanitizeScene(`  "${clean}"  `), clean, "surrounding whitespace and quotes are stripped");
  assert.equal(sanitizeScene(`${clean}.`), clean, "a trailing period is stripped");
}
{
  // Constraints shared with sanitizeDescriptor: no numbers, no $/%, no ticker.
  assert.equal(sanitizeScene("technician tightening 12 bolts on a turbine, hands on the wrench, mid-motion"), null,
    "a bare digit is rejected");
  assert.equal(sanitizeScene("banker closing a $2 million deal, mid-handshake across a desk"), null,
    "a dollar sign is rejected");
  assert.equal(sanitizeScene("trader watching a 3% swing on the board, hands on the keyboard, mid-motion"), null,
    "a percentage sign is rejected");
  assert.equal(sanitizeScene("GOOGL engineer inspecting a server rack, hands on the cabling, mid-motion", { ticker: "GOOGL" }), null,
    "the company's own ticker is rejected");
}
{
  // A LEADING "a man "/"a woman " is stripped, not rejected — measured live, the model quite
  // commonly opens with its own gender choice despite the system prompt saying not to
  // ("a man assembling circuit boards…"), and personPhrase(seed) picks the gender
  // deterministically and prepends it separately anyway, so this is exactly the
  // sectorScenePhrase shape (role + action) once the leading article+gender is removed.
  assert.equal(
    sanitizeScene("a woman engineer inspecting a server rack, hands on the cabling, mid-motion"),
    "engineer inspecting a server rack, hands on the cabling, mid-motion",
    "a leading \"a woman \" is stripped, not rejected",
  );
  assert.equal(
    sanitizeScene("a man assembling circuit boards for smartphone hardware production"),
    "assembling circuit boards for smartphone hardware production",
    "a leading \"a man \" is stripped too — the real failure mode this fix addresses",
  );
  // Scene-specific constraints: a pronoun/gender word ANYWHERE ELSE (not just the leading
  // shape above) is still a real rejection — gender is chosen separately, and a pronoun
  // embedded mid-sentence cannot be cleanly stripped the way a leading one can — and so is a
  // logo/brand/chart/signage word (which would directly undermine buildImagePrompt's own clause).
  for (const bad of [
    "she solders a circuit board, hands and board filling the frame, mid-motion",
    "he inspects a server rack, hands on the cabling, mid-motion",
    "engineer inspecting a server rack while his colleague looks on, hands on the cabling",
  ]) {
    assert.equal(sanitizeScene(bad), null, `a pronoun/gender word elsewhere is rejected: "${bad}"`);
  }
  for (const bad of [
    "engineer polishing the company logo on the lobby wall, hands on the sign, mid-motion",
    "technician checking a screen full of charts, hands on the keyboard, mid-motion",
    "worker hanging a brand watermark banner, hands on the fabric, mid-motion",
  ]) {
    assert.equal(sanitizeScene(bad), null, `a logo/brand/chart/signage word is rejected: "${bad}"`);
  }
}
{
  // Word-count bounds (4-40, generous — a scene is a descriptive phrase, not a short caption).
  assert.equal(sanitizeScene("engineer soldering"), null, "a two-word scene is too short");
  assert.equal(sanitizeScene(Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ")), null,
    "an excessively long scene is rejected outright, not silently truncated");
}
{
  // Multi-sentence output, and empty/null input.
  assert.equal(sanitizeScene("engineer inspects a server rack. Hands fill the frame."), null,
    "more than one sentence is rejected");
  assert.equal(sanitizeScene(""), null, "empty input is rejected");
  assert.equal(sanitizeScene(null), null, "null input is rejected");
}

// =================================================================== describeCompany ==========
{
  // Happy path: a clean model response (both halves) is used verbatim (post-sanitisation) and
  // cached together.
  const cache = {};
  const scene = "engineer inspecting a rack of servers in a data centre hall, hands on the cabling, mid-motion";
  const provider = async () => [modelReply("shaping how we search", scene)];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d.descriptor, "shaping how we search", "a valid model descriptor is used as-is");
  assert.equal(d.scene, scene, "a valid model scene is used as-is");
  assert.equal(cache.GOOGL.descriptor, d.descriptor, "a successful call caches the descriptor by ticker");
  assert.equal(cache.GOOGL.scene, d.scene, "a successful call caches the scene by ticker, alongside the descriptor");
  assert.equal(cache.GOOGL.name, "Alphabet", "the cache stores the display name for staleness checks");
}
{
  // Cache hit (both fields present): the provider must NOT be called at all — reuse per
  // company, not a call per post.
  const cache = { GOOGL: { name: "Alphabet", descriptor: "already cached", scene: "already cached scene, mid-motion" } };
  const provider = async () => { throw new Error("must not be called on a cache hit"); };
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d.descriptor, "already cached", "a cache hit short-circuits before any provider call");
  assert.equal(d.scene, "already cached scene, mid-motion", "the cached scene rides along with the cached descriptor");
}
{
  // An OLDER cache entry saved before this module gained `scene` (descriptor only) is treated
  // as a MISS, not a hit — it must not silently ship with no scene forever.
  const cache = { GOOGL: { name: "Alphabet", descriptor: "old descriptor, no scene field at all" } };
  const scene = "technician calibrating lab equipment, hands on the instrument, mid-motion";
  const provider = async () => [modelReply("fresh descriptor", scene)];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d.descriptor, "fresh descriptor", "a descriptor-only cache entry is upgraded, not reused as-is");
  assert.equal(d.scene, scene, "the upgrade populates the previously-missing scene");
  assert.equal(cache.GOOGL.scene, scene, "the cache itself is upgraded in place");
}
{
  // A cache entry under a STALE name (the company was renamed) is not reused.
  const cache = { GOOGL: { name: "Old Name Co", descriptor: "stale descriptor", scene: "stale scene, mid-motion" } };
  const scene = "engineer inspecting a rack of servers, hands on the cabling, mid-motion";
  const provider = async () => [modelReply("fresh accurate descriptor", scene)];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d.descriptor, "fresh accurate descriptor", "a name mismatch invalidates the cached entry");
  assert.equal(d.scene, scene, "the scene is refreshed alongside the descriptor on a name mismatch");
}
{
  // Invalid model output (a number leaked into the descriptor) falls back to BOTH deterministic
  // sector maps together, and does NOT poison the cache with the bad attempt — even though the
  // scene half of the same response was perfectly valid.
  const cache = {};
  const provider = async () => [modelReply("up 42% this year", "engineer inspecting servers, hands on the rack, mid-motion")];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d.descriptor, descriptorFor("General"), "invalid descriptor output falls back to the deterministic sector descriptor");
  assert.equal(d.scene, sectorScenePhrase("General"), "the whole response falls back together — a good scene is not kept when the descriptor fails");
  assert.equal("GOOGL" in cache, false, "a fallback is never cached, so the next run retries the model");
}
{
  // Symmetric case: a valid descriptor but an invalid scene (a pronoun leaked in) still falls
  // back together, never publishing a half-good result.
  const cache = {};
  const provider = async () => [modelReply("shaping how we search", "she inspects a server rack, hands on the cabling, mid-motion")];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.equal(d.descriptor, descriptorFor("General"), "a bad scene falls the descriptor back too — never a half-good publish");
  assert.equal(d.scene, sectorScenePhrase("General"), "the invalid scene itself falls back to the deterministic sector scene");
  assert.equal("GOOGL" in cache, false, "a partial failure is never cached either");
}
{
  // A throwing provider degrades exactly the same way — never loses the post over this call.
  const provider = async () => { throw new Error("network down"); };
  const d = await describeCompany({ row: alphabetRow, provider, cache: {} });
  assert.equal(d.descriptor, descriptorFor("General"), "a thrown provider error falls back to the sector descriptor");
  assert.equal(d.scene, sectorScenePhrase("General"), "a thrown provider error falls back to the sector scene too");
}
{
  // No provider at all (image/text generation off, or wiring omitted) still resolves.
  const d = await describeCompany({ row: alphabetRow, cache: {} });
  assert.equal(d.descriptor, descriptorFor("General"), "no provider at all still falls back cleanly (descriptor)");
  assert.equal(d.scene, sectorScenePhrase("General"), "no provider at all still falls back cleanly (scene)");
}
{
  // The specific case the whole task is about: Alphabet's TipRanks sector is General — the
  // unclassified bucket — so the FALLBACK still reads "too big to label" / the generic sector
  // scene (unchanged, still correct as a rare-failure fallback), but a WORKING model call must
  // land on something about the real business, never repeat the sector-bucket joke, and its
  // scene must be about Alphabet's actual business too, never the generic fallback scene.
  const cache = {};
  const scene = "engineer inspecting a rack of servers in a data centre hall, hands on the cabling, mid-motion";
  const provider = async () => [modelReply("mapping the world's information", scene)];
  const d = await describeCompany({ row: alphabetRow, provider, cache });
  assert.notEqual(d.descriptor, "too big to label", "a successful call never falls back to the General descriptor joke");
  assert.equal(/search|advertis|information|web/i.test(d.descriptor), true,
    "Alphabet's real descriptor lands on something about its actual business");
  assert.notEqual(d.scene, sectorScenePhrase("General"), "a successful call never falls back to the generic General scene");
  assert.equal(/server|data|cloud|network|cable/i.test(d.scene), true,
    "Alphabet's real scene lands on something about its actual business (a data-centre setting)");
}

console.log("company-descriptor OK — one prompt asks for both a DESCRIPTOR and a SCENE, carries " +
            "display name/sector/cap/price/analysts/desc, parseModelResponse splits the two " +
            "labelled halves order-independently, sanitisation rejects numbers/$/%/ticker/" +
            "performance-claims/word-count violations on the descriptor and numbers/$/%/ticker/" +
            "pronouns/logo-brand-chart words/word-count violations on the scene, describeCompany " +
            "caches both fields together per company, upgrades an older descriptor-only cache " +
            "entry, invalidates on a name change, and falls BOTH fields back together " +
            "(never a half-good publish, never a poisoned cache) on invalid output, a thrown " +
            "error, or no provider");
