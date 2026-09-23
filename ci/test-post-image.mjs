// Checks ci/post-image.mjs — the real-image generator. Strictly offline: fetchImpl is always
// injected, so this never touches the network. The property that matters most is the safety
// one: the prompt is built from the sector (+ a ticker-derived coin flip, never the ticker AS
// TEXT) alone, so this asserts it explicitly rather than trusting the source not to regress.

import assert from "node:assert";
import {
  buildImagePrompt, descriptorFor, generateImage, personPhrase, postImageFilename, scenePhrase,
} from "./post-image.mjs";

// --- every real sector (src/data/stocks.json's `sec` values) maps to a scene ---------------
const REAL_SECTORS = [
  "Healthcare", "Technology", "General", "Industrials", "ConsumerCyclical", "Financial",
  "Energy", "CommunicationServices", "BasicMaterials", "ConsumerDefensive", "Utilities",
  "RealEstate",
];
for (const sec of REAL_SECTORS) {
  const phrase = scenePhrase(sec, "AAA");
  assert.ok(typeof phrase === "string" && phrase.trim().length > 0, `${sec} maps to a non-empty scene phrase`);
}
// Distinct scenes (same seed held constant), or several real sectors would generate visually
// identical imagery.
assert.equal(new Set(REAL_SECTORS.map((s) => scenePhrase(s, "AAA"))).size, REAL_SECTORS.length,
  "every real sector gets its own scene phrase");

// --- unknown/missing sectors fall back honestly, never crash --------------------------------
for (const bad of ["Nonexistent Sector", "", undefined, null]) {
  const phrase = scenePhrase(bad, "AAA");
  assert.ok(typeof phrase === "string" && phrase.trim().length > 0, `"${bad}" still yields a scene phrase`);
}

// --- every sector's scene now shows a PERSON doing the company's actual work ----------------
// Inverted from the old "no people, no faces, no hands, no silhouettes" rule — see
// ci/post-image.mjs's header comment for why. Every scene must name a concrete role, not a
// generic bystander, and must say WHO (a woman / a man).
for (const sec of REAL_SECTORS) {
  const phrase = scenePhrase(sec, "AAA");
  assert.ok(/^a (woman|man) /.test(phrase), `${sec}'s scene opens with a person: "${phrase}"`);
}

// --- the person is PROMINENT and caught mid-action, not small/posed/mid-distance ------------
for (const sec of REAL_SECTORS) {
  const phrase = scenePhrase(sec, "AAA");
  assert.ok(/filling most of the frame/.test(phrase), `${sec}'s scene keeps the person large in frame: "${phrase}"`);
  assert.ok(/mid-motion|mid-handshake/.test(phrase), `${sec}'s scene is mid-action, not posed: "${phrase}"`);
}
// Flux has ignored the no-numbers instruction before on scenes with a natural reason to carry
// signage (a generated screen wall showed chart-like marks) — scenes with no such reason are
// preferred, so Technology/CommunicationServices no longer route through screens/monitors.
for (const sec of ["Technology", "CommunicationServices"]) {
  assert.equal(/screen|display panel|monitor/i.test(scenePhrase(sec, "AAA")), false,
    `${sec}'s scene avoids screens/monitors — a prop Flux has invented chart-like marks onto before`);
}

// --- personPhrase: deterministic off the seed, ~90% woman / ~10% man, never the ticker AS TEXT
{
  assert.equal(personPhrase("AAA"), personPhrase("AAA"), "same seed, same person, every time");
  assert.ok(["a woman", "a man"].includes(personPhrase("AAA")), "always one of the two phrases");
  // Distribution sanity over a spread of synthetic tickers — not a statistical proof, just a
  // guard that the split is roughly 90/10 and not, say, 50/50 or always the same branch.
  const seeds = Array.from({ length: 500 }, (_, i) => `TICK${i}`);
  const women = seeds.filter((s) => personPhrase(s) === "a woman").length;
  const ratio = women / seeds.length;
  assert.ok(ratio > 0.8 && ratio < 0.98, `roughly 90% land on "a woman" (measured ${ratio})`);
  // The seed itself never appears in the output text.
  for (const s of seeds) assert.equal(personPhrase(s).includes(s), false, `${s} never leaks into its own phrase`);
}

// --- descriptorFor: the sector -> 2-4 word CHARACTERFUL descriptor map -----------------------
// Not a category label any more ("technology systems" was flat and taxonomic — see
// ci/post-image.mjs's header comment on SECTOR_DESCRIPTOR); each one is meant to read like an
// editor's caption, not a sector name restated.
for (const sec of REAL_SECTORS) {
  const d = descriptorFor(sec);
  const words = d.trim().split(/\s+/);
  assert.ok(words.length >= 2 && words.length <= 4, `${sec}'s descriptor is 2-4 words ("${d}")`);
}
assert.equal(new Set(REAL_SECTORS.map(descriptorFor)).size, REAL_SECTORS.length,
  "every real sector gets its own descriptor");
assert.equal(descriptorFor("Energy"), "powering the grid", "matches the current characterful copy");
// The old taxonomic wording must actually be gone, not just replaced by a synonym of itself —
// this is the exact regression the task called out (Microsoft rendered "technology systems").
for (const stale of ["technology systems", "public markets", "medical research", "financial markets"]) {
  assert.equal(REAL_SECTORS.some((sec) => descriptorFor(sec) === stale), false,
    `no sector still uses the flat taxonomic wording "${stale}"`);
}
// `General` — TipRanks' own unclassified bucket — got particular thought per the brief: it
// used to read "public markets" under Alphabet. The fix leans into what usually lands in this
// bucket (names too large/diversified for one sector tag), not a punchier synonym for "unknown".
assert.equal(descriptorFor("General"), "too big to label", "General's descriptor names what the bucket actually holds");
for (const bad of ["Nonexistent Sector", "", undefined, null]) {
  const d = descriptorFor(bad);
  assert.ok(d.trim().length > 0, `"${bad}" still yields a descriptor`);
  assert.notEqual(d, descriptorFor("General"),
    "an unrecognised sector string gets its own fallback, distinct from the known General bucket");
}

// --- the built prompt carries the template and the suppression clauses ----------------------
{
  const prompt = buildImagePrompt("Technology", "AAA");
  assert.ok(prompt.includes(scenePhrase("Technology", "AAA")), "the prompt embeds the scene phrase");
  for (const clause of [
    "no text", "no numbers", "no digits", "no charts", "no graphs", "no diagrams",
    "no logos", "no brand marks", "no watermarks", "no signage",
  ]) {
    assert.ok(prompt.toLowerCase().includes(clause), `prompt suppresses "${clause}"`);
  }
  // Inverted: people are now REQUIRED, not suppressed.
  for (const banned of ["no people", "no faces", "no hands", "no silhouettes"]) {
    assert.equal(prompt.toLowerCase().includes(banned), false, `prompt no longer suppresses "${banned}"`);
  }
  assert.ok(/\ba (woman|man)\b/.test(prompt), "the prompt names a person");
  // The load-bearing assertion: nothing that could be a fabricated figure ever reaches Flux,
  // which renders text well and has no negative_prompt field to fall back on.
  assert.equal(/\d/.test(prompt), false, "the built prompt contains no digits whatsoever");
}
// True for every real sector, not just one spot check.
for (const sec of REAL_SECTORS) {
  assert.equal(/\d/.test(buildImagePrompt(sec, "AAA")), false, `${sec}'s prompt contains no digits`);
}

// --- the seed (ticker) never reaches the prompt AS TEXT, only as a hash --------------------
{
  const tickers = ["ALAB", "NVDA", "IRD", "XPO", "COP"];
  for (const t of tickers) {
    const prompt = buildImagePrompt("Technology", t);
    assert.equal(prompt.includes(t), false, `the ticker ${t} itself never appears in its own prompt`);
  }
}

// --- postImageFilename sanitises the ISO-timestamp id into a safe JPG name ------------------
// .jpg, not .png: this names ci/post-compose.mjs's fused, JPEG-encoded output (ci/jpeg-encode.mjs).
{
  const id = "ALAB-2026-09-22T14:35:30.122Z";
  const name = postImageFilename(id);
  assert.equal(name, "ALAB-2026-09-22T14-35-30-122Z.jpg", "colons and dots collapse to hyphens");
  assert.equal(/^[a-zA-Z0-9_-]+\.jpg$/.test(name), true, "the result is filesystem/URL-safe");
}

// --- generateImage never throws, and returns null on every failure mode ---------------------
{
  // missing credentials
  const out = await generateImage({ sector: "Technology", ticker: "AAA", env: {}, fetchImpl: async () => {
    throw new Error("must not be called without credentials");
  } });
  assert.equal(out, null, "missing CF_ACCOUNT_ID/CF_API_TOKEN returns null, not a throw");
}
{
  // non-ok response
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ result: { image: "AAAA" } }) });
  const out = await generateImage({
    sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
  assert.equal(out, null, "a non-ok response returns null and never leaks the body");
}
{
  // malformed body: ok, but no result.image
  const fetchImpl = async () => ({ ok: true, json: async () => ({ success: true, result: {} }) });
  const out = await generateImage({
    sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
  assert.equal(out, null, "a malformed (missing image) body returns null");
}
{
  // malformed body: result.image is not a string
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { image: 12345 } }) });
  const out = await generateImage({
    sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
  assert.equal(out, null, "a non-string image field returns null");
}
{
  // network error
  const fetchImpl = async () => { throw new Error("ECONNRESET"); };
  await assert.doesNotReject(
    generateImage({ sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl }),
    "a thrown network error never propagates out of generateImage",
  );
  const out = await generateImage({ sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl });
  assert.equal(out, null, "a network error resolves to null");
}
{
  // missing ticker entirely still works — personPhrase(undefined) is still deterministic.
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(/\d/.test(body.prompt), false, "no digits even with no ticker seed given");
    return { ok: true, json: async () => ({ result: { image: Buffer.from("x").toString("base64") } }) };
  };
  const out = await generateImage({ sector: "Technology", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl });
  assert.ok(Buffer.isBuffer(out), "an omitted ticker/seed does not break the call");
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
    assert.equal(body.prompt.includes("ALAB"), false, "the request body's prompt never carries the ticker as text");
    return { ok: true, json: async () => ({ result: { image: payload.toString("base64") }, success: true }) };
  };
  const out = await generateImage({
    sector: "Healthcare", ticker: "ALAB", env: { CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok" }, fetchImpl,
  });
  assert.ok(Buffer.isBuffer(out), "returns a Buffer on success");
  assert.ok(out.equals(payload), "the base64 body decodes back to the original bytes");
}

console.log("post-image OK — every real sector has a scene WITH a person (deterministic, ~90% " +
            "woman), a descriptor, the prompt is digit-free and ticker-text-free and suppresses " +
            "text/logos/watermarks, filenames sanitise to .jpg, and generateImage returns null " +
            "(never throws) on missing creds, non-ok, malformed, and network-error responses");
