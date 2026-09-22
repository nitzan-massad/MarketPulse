// Checks ci/post-image.mjs — the real-image generator. Strictly offline: fetchImpl is always
// injected, so this never touches the network. The one property that matters most is the
// safety one: the prompt is built from the sector alone, so this asserts it explicitly rather
// than trusting the source not to regress.

import assert from "node:assert";
import { buildImagePrompt, generateImage, postImageFilename, scenePhrase } from "./post-image.mjs";

// --- every real sector (src/data/stocks.json's `sec` values) maps to a scene ---------------
const REAL_SECTORS = [
  "Healthcare", "Technology", "General", "Industrials", "ConsumerCyclical", "Financial",
  "Energy", "CommunicationServices", "BasicMaterials", "ConsumerDefensive", "Utilities",
  "RealEstate",
];
for (const sec of REAL_SECTORS) {
  const phrase = scenePhrase(sec);
  assert.ok(typeof phrase === "string" && phrase.trim().length > 0, `${sec} maps to a non-empty scene phrase`);
}
// Distinct scenes, or several real sectors would generate visually identical imagery.
assert.equal(new Set(REAL_SECTORS.map(scenePhrase)).size, REAL_SECTORS.length,
  "every real sector gets its own scene phrase");

// --- unknown/missing sectors fall back honestly, never crash --------------------------------
for (const bad of ["Nonexistent Sector", "", undefined, null]) {
  const phrase = scenePhrase(bad);
  assert.ok(typeof phrase === "string" && phrase.trim().length > 0, `"${bad}" still yields a scene phrase`);
}

// --- the built prompt carries the template and the suppression clauses ----------------------
{
  const prompt = buildImagePrompt("Technology");
  assert.ok(prompt.includes(scenePhrase("Technology")), "the prompt embeds the scene phrase");
  for (const clause of [
    "no text", "no numbers", "no digits", "no charts", "no graphs", "no diagrams",
    "no logos", "no brand marks", "no watermarks", "no signage", "no people", "no faces",
    "no hands", "no silhouettes",
  ]) {
    assert.ok(prompt.toLowerCase().includes(clause), `prompt suppresses "${clause}"`);
  }
  // The load-bearing assertion: nothing that could be a fabricated figure ever reaches Flux,
  // which renders text well and has no negative_prompt field to fall back on.
  assert.equal(/\d/.test(prompt), false, "the built prompt contains no digits whatsoever");
}
// True for every real sector, not just one spot check.
for (const sec of REAL_SECTORS) {
  assert.equal(/\d/.test(buildImagePrompt(sec)), false, `${sec}'s prompt contains no digits`);
}

// --- postImageFilename sanitises the ISO-timestamp id into a safe name ----------------------
{
  const id = "ALAB-2026-09-22T14:35:30.122Z";
  const name = postImageFilename(id);
  assert.equal(name, "ALAB-2026-09-22T14-35-30-122Z.jpg", "colons and dots collapse to hyphens");
  assert.equal(/^[a-zA-Z0-9_-]+\.jpg$/.test(name), true, "the result is filesystem/URL-safe");
}

// --- generateImage never throws, and returns null on every failure mode ---------------------
{
  // missing credentials
  const out = await generateImage({ sector: "Technology", env: {}, fetchImpl: async () => {
    throw new Error("must not be called without credentials");
  } });
  assert.equal(out, null, "missing CF_ACCOUNT_ID/CF_API_TOKEN returns null, not a throw");
}
{
  // non-ok response
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ result: { image: "AAAA" } }) });
  const out = await generateImage({
    sector: "Technology", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
  assert.equal(out, null, "a non-ok response returns null and never leaks the body");
}
{
  // malformed body: ok, but no result.image
  const fetchImpl = async () => ({ ok: true, json: async () => ({ success: true, result: {} }) });
  const out = await generateImage({
    sector: "Technology", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
  assert.equal(out, null, "a malformed (missing image) body returns null");
}
{
  // malformed body: result.image is not a string
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { image: 12345 } }) });
  const out = await generateImage({
    sector: "Technology", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
  assert.equal(out, null, "a non-string image field returns null");
}
{
  // network error
  const fetchImpl = async () => { throw new Error("ECONNRESET"); };
  await assert.doesNotReject(
    generateImage({ sector: "Technology", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl }),
    "a thrown network error never propagates out of generateImage",
  );
  const out = await generateImage({ sector: "Technology", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl });
  assert.equal(out, null, "a network error resolves to null");
}

// --- happy path: a well-formed response decodes to the right bytes --------------------------
{
  const payload = Buffer.from("not a real jpeg, just bytes to round-trip");
  const fetchImpl = async (url, init) => {
    assert.ok(url.includes("black-forest-labs/flux-1-schnell"), "hits the Flux Schnell model route");
    const body = JSON.parse(init.body);
    assert.equal(body.steps, 4, "requests 4 steps");
    assert.equal(typeof body.prompt, "string", "sends a prompt string");
    assert.equal(/\d/.test(body.prompt), false, "the request body's prompt still has no digits");
    return { ok: true, json: async () => ({ result: { image: payload.toString("base64") }, success: true }) };
  };
  const out = await generateImage({
    sector: "Healthcare", env: { CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok" }, fetchImpl,
  });
  assert.ok(Buffer.isBuffer(out), "returns a Buffer on success");
  assert.ok(out.equals(payload), "the base64 body decodes back to the original bytes");
}

console.log("post-image OK — every real sector has a scene, the prompt is digit-free and " +
            "suppresses text/logos/people, filenames sanitise, and generateImage returns null " +
            "(never throws) on missing creds, non-ok, malformed, and network-error responses");
