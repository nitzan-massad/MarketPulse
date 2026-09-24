// Checks ci/post-image.mjs — the real-image generator. Strictly offline: fetchImpl is always
// injected, so this never touches the network. The property that matters most is the safety
// one: the prompt is built from the sector (+ a ticker-derived coin flip, never the ticker AS
// TEXT) alone, so this asserts it explicitly rather than trusting the source not to regress.

import assert from "node:assert";
import {
  buildImagePrompt, descriptorFor, generateImage, personPhrase, postImageFilename, scenePhrase,
  sectorScenePhrase,
} from "./post-image.mjs";
import { isExhausted, resetForTest } from "./cf-budget.mjs";

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
  // "no charts"/"no graphs"/"no diagrams" were replaced (task 10) by a POSITIVE instruction for
  // what a screen shows instead (bokeh, never legible marks) — a negative alone had already
  // been ignored once by a model with no negative_prompt field to fall back on (see the
  // buildImagePrompt doc comment). The remaining suppression clauses are untouched.
  for (const clause of [
    "no text", "no numbers", "no digits", "no logos", "no brand marks", "no watermarks", "no signage",
  ]) {
    assert.ok(prompt.toLowerCase().includes(clause), `prompt suppresses "${clause}"`);
  }
  // Inverted: people are now REQUIRED, not suppressed.
  for (const banned of ["no people", "no faces", "no hands", "no silhouettes"]) {
    assert.equal(prompt.toLowerCase().includes(banned), false, `prompt no longer suppresses "${banned}"`);
  }
  assert.ok(/\ba (woman|man)\b/.test(prompt), "the prompt names a person");
  // (10) the positive screen instruction — what replaces the old negative chart/graph/diagram
  // clause.
  assert.ok(/screen|monitor|display/i.test(prompt) && /bokeh|out-of-focus/i.test(prompt),
    "prompt gives a positive instruction for how an incidental screen should look, not just a ban");
  // (11) tight-crop framing direction — survives the casting retraction below unchanged.
  assert.ok(/extreme close-up/i.test(prompt), "prompt asks for an extreme close-up (task 11)");
  assert.ok(/face and hands/i.test(prompt), "prompt asks for face AND hands in frame (task 11)");
  assert.ok(/shallow depth of field/i.test(prompt), "prompt asks for shallow depth of field (task 11)");
  // Commercial-casting language ("strikingly attractive", "cast and styled", "magazine or
  // advertising campaign") was added in a prior pass per the user's own direction, then
  // EXPLICITLY RETRACTED by the user ("revert this") — it must be gone, not softened, while
  // every other clause from that same pass (tight crops, the screen/bokeh redirect, the
  // no-text/no-logos rules) stays exactly as asserted elsewhere in this file.
  for (const banned of [
    "attractive", "well-groomed", "grooms its models", "magazine", "advertising campaign",
    "cast and styled", "production value", "commercial stock-photography shoot",
  ]) {
    assert.equal(prompt.toLowerCase().includes(banned), false,
      `prompt no longer directs "${banned}" — the attractiveness/casting direction was retracted`);
  }
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

// --- sectorScenePhrase: the role+action half of scenePhrase, with no person prefix ----------
// This is what buildImagePrompt falls back to when no per-company model scene is supplied —
// split out so a custom scene and the sector fallback share the exact same "prepend
// personPhrase" code path (see ci/post-image.mjs's own comment).
for (const sec of REAL_SECTORS) {
  const phrase = sectorScenePhrase(sec);
  assert.equal(/^a (woman|man) /.test(phrase), false, "sectorScenePhrase carries no person prefix");
  assert.equal(scenePhrase(sec, "AAA"), `${personPhrase("AAA")} ${phrase}`,
    "scenePhrase is exactly personPhrase + sectorScenePhrase");
}

// --- buildImagePrompt's third argument: a per-company CUSTOM SCENE, in place of the sector map
{
  const customScene = "engineer inspecting a rack of servers in a data centre hall, hands on the cabling, mid-motion";
  const prompt = buildImagePrompt("General", "GOOGL", customScene);
  assert.ok(prompt.includes(customScene), "a supplied custom scene reaches the prompt verbatim");
  assert.equal(prompt.includes(sectorScenePhrase("General")), false,
    "the sector-mapped fallback scene is NOT used when a custom scene is supplied");
  assert.ok(new RegExp(`extreme close-up shot, of a (woman|man) ${customScene}`).test(prompt),
    "the custom scene is composed with personPhrase exactly like the sector fallback is");
}
{
  // Falsy/blank/non-string customScene values all fall back to the sector map, never crash.
  for (const bad of [undefined, null, "", "   "]) {
    const prompt = buildImagePrompt("Technology", "AAA", bad);
    assert.ok(prompt.includes(sectorScenePhrase("Technology")),
      `a ${JSON.stringify(bad)} custom scene falls back to the sector-mapped scene`);
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

// --- EVERY sector, `General` included, now reaches Flux — no more skip ---------------------
// A prior pass skipped the Flux call entirely for `General` (TipRanks' unclassified catch-all,
// ~44 rows including Alphabet) and rendered a palette-driven abstract mark instead. The user
// rejected that: every post gets a real generated photo, always, `General` included — the
// personalised scene comes from ci/company-descriptor.mjs, not the sector, so `General` no
// longer needs special-casing here at all.
{
  const payload = Buffer.from("a real flux jpeg for a General-sector company");
  let called = false;
  const fetchImpl = async (url, init) => {
    called = true;
    const body = JSON.parse(init.body);
    assert.equal(/\d/.test(body.prompt), false, "General's prompt is still digit-free");
    return { ok: true, json: async () => ({ result: { image: payload.toString("base64") } }) };
  };
  const out = await generateImage({
    sector: "General", ticker: "GOOGL", env: { CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "tok" }, fetchImpl,
  });
  assert.ok(called, "General reaches the Flux call exactly like every other sector");
  assert.ok(out.equals(payload), "General decodes the real Flux response like every other sector");
}
{
  // Missing credentials degrades exactly the same way for General as for any other sector —
  // null, never a silent abstract-mark substitute.
  const out = await generateImage({ sector: "General", ticker: "GOOGL", env: {}, fetchImpl: async () => {
    throw new Error("must not be called without credentials");
  } });
  assert.equal(out, null, "General with no credentials returns null, not an abstract mark");
}

// --- the per-company SCENE (ci/company-descriptor.mjs) reaches the Flux request body --------
{
  const scene = "technician calibrating lab equipment, hands on the instrument, mid-motion";
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(body.prompt.includes(scene), "a scene passed into generateImage reaches the Flux prompt");
    return { ok: true, json: async () => ({ result: { image: Buffer.from("x").toString("base64") } }) };
  };
  await generateImage({
    sector: "Healthcare", ticker: "PRAX", scene, env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
}

// --- (Neuron accounting) onSuccess fires once, only on an actually-decoded image ------------
resetForTest();
{
  let calls = 0;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { image: Buffer.from("x").toString("base64") } }) });
  const out = await generateImage({
    sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
    onSuccess: () => { calls++; },
  });
  assert.ok(Buffer.isBuffer(out), "the call still succeeds normally");
  assert.equal(calls, 1, "onSuccess fires exactly once on a real decoded image");
}
{
  // Declined (missing creds), non-ok, and malformed-body paths must never fire onSuccess —
  // none of them were actually billed a usable image.
  let calls = 0;
  const onSuccess = () => { calls++; };
  await generateImage({ sector: "Technology", ticker: "AAA", env: {}, fetchImpl: async () => { throw new Error("must not be called"); }, onSuccess });
  await generateImage({
    sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, onSuccess,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  await generateImage({
    sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, onSuccess,
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: {} }) }),
  });
  assert.equal(calls, 0, "no failure/decline path ever calls onSuccess");
}
{
  // onSuccess is optional — omitting it must not throw.
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { image: Buffer.from("x").toString("base64") } }) });
  await assert.doesNotReject(
    generateImage({ sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl }),
    "no onSuccess handler at all is fine",
  );
}
resetForTest();

// --- (Neuron accounting) exhaustion: code 4006 marks the shared flag and short-circuits later
// calls, here too — the image endpoint shares the SAME Cloudflare account/daily budget as the
// text model (ci/provider.mjs), so either one can be the first to see it.
{
  const exhaustedBody = { errors: [{ code: 4006, message: "daily free allocation of 10,000 neurons" }] };
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => exhaustedBody });
  const out = await generateImage({
    sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
  assert.equal(out, null, "an exhausted image call still returns null, never throws");
  assert.equal(isExhausted(), true, "the SHARED flag (ci/cf-budget.mjs) is set from the image call site too");
}
{
  // Once exhausted (from the block above), a further image call does not even touch the network.
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; return { ok: true, json: async () => ({ result: { image: "AAAA" } }) }; };
  const out = await generateImage({
    sector: "Technology", ticker: "AAA", env: { CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl,
  });
  assert.equal(out, null, "no image is generated once the account is known-exhausted");
  assert.equal(fetchCalls, 0, "not even one network call is made — there is no point");
}
resetForTest();

console.log("post-image neuron-accounting OK — onSuccess fires once per real decoded image " +
            "(never on a decline/failure), and code 4006 marks the shared exhaustion flag and " +
            "short-circuits further Flux calls with no network touch");

console.log("post-image OK — every real sector has a scene WITH a person (deterministic, ~90% " +
            "woman), a descriptor, the prompt is digit-free and ticker-text-free and suppresses " +
            "text/logos/watermarks while giving screens a positive bokeh instruction, tight-crop " +
            "framing reaches the prompt and the retracted attractiveness/casting direction does " +
            "not, filenames sanitise to .jpg, a per-company scene overrides the sector fallback " +
            "and reaches the Flux request body, EVERY sector including General now reaches Flux " +
            "(no more abstract-mark skip), and generateImage returns null (never throws) on " +
            "missing creds, non-ok, malformed, and network-error responses");
