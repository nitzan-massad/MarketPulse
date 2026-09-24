// Checks ci/generate-posts.mjs — the wiring. Uses an injected fake provider, so this
// check never touches the network and never writes a file: generate() is pure apart
// from the provider it is handed, which is the whole reason it is shaped that way.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { buildPrompt, generate, humanizeFactKey, KIND_BRIEF } from "./generate-posts.mjs";
import { newUsageTracker } from "./neuron-usage.mjs";
import { markExhausted, resetForTest } from "./cf-budget.mjs";

const row = (over = {}) => ({
  t: "AAA", n: "Alpha Inc", sec: "Technology", px: 100, chg: 1, pt: 160, up: 60,
  con: "StrongBuy", b: 20, h: 1, s: 0, ss: 9, ai: 80, air: "Bullish", aipt: 150,
  mc: 90_000, desc: "", ...over,
});
const curr = [row(), row({ t: "BBB", n: "Beta Co", up: 45, pt: 145 })];
const exemplars = ["TSLA at $240. Street says $310. Do the math.", "Nobody is talking about $CAT."];

// --- prompt shape -----------------------------------------------------------------
{
  const hook = { kind: "surprise", ticker: "AAA", name: "Alpha Inc", sec: "Tech",
                 score: 90, facts: { upside: 60, priceTarget: 160 } };
  const { system, prompt } = buildPrompt(hook, exemplars);
  assert.ok(system.length > 50, "there is a real system prompt");
  assert.ok(prompt.includes("AAA"), "the prompt carries the ticker");
  assert.ok(prompt.includes("60"), "the prompt carries the facts");
  assert.ok(prompt.includes(exemplars[0]), "exemplars are few-shot anchors in the prompt");
  assert.ok(/not financial advice|no advice/i.test(system), "the system prompt forbids advice framing");
}

// --- the writer prompt uses the DISPLAY name, never the raw legal name ------------------
// A published card once read "Applied Materials, Inc." and "Alphabet Inc. Class A" — the
// prompt used to hand the model that exact same legally-cluttered string. buildPrompt() now
// routes hook.name through ci/hooks.mjs's displayCompanyName() before it ever reaches the
// "Company:" line.
{
  const hook = { kind: "surprise", ticker: "AAA", name: "Alpha Inc. Class A", sec: "Technology",
                 facts: { upside: 60 } };
  const { prompt } = buildPrompt(hook);
  assert.ok(prompt.includes("Company: Alpha (AAA)"), "the prompt names the stripped display name");
  assert.equal(prompt.includes("Alpha Inc. Class A"), false, "the raw legal-entity name never reaches the prompt");
}

// --- happy path: one post, best of the candidates -----------------------------------
// Candidates are now judged on words (max 8) and penalise the ticker, not just the old
// banned-phrase / digit rules, so both fixtures below stay within the new headline limit
// and name the company ("Alpha Inc"), never the ticker ("AAA").
{
  const provider = async ({ n }) => [
    "Let's dive in! AAA is a game-changer!!!",
    "Alpha Inc target $160, 60% upside, 21 analysts.",
  ].slice(0, n);
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 2 } });
  assert.equal(posts.length, 1, "postsPerRun=1 yields exactly one post");
  assert.ok(posts[0].text.includes("$160"), "the concrete candidate won");
  assert.equal(posts[0].ticker, "AAA", "the post carries its ticker");
  assert.ok(posts[0].id.startsWith("AAA-"), "id is ticker-prefixed");
  assert.ok(Number.isFinite(Date.parse(posts[0].ts)), "ts is an ISO timestamp");
  assert.ok(Array.isArray(posts[0].reasons), "the post carries the scorer's reasons");
}

// --- raw fact keys never reach the prompt (the "smartScore: 10" published bug) -----------
// One real run published "Alphabet Inc. smartScore: 10, unchanged for 30 snapshots." because
// the prompt rendered `facts` as `- key: value` with the literal JS field name. Every fact key
// any of the seven hook kinds (ci/hooks.mjs) actually emits must render as a humanised label
// instead — this exercises every key across a realistic sample of each kind's own shape.
// (`trend`/`churn` were deleted from ci/hooks.mjs outright — see its own comments — so their
// shapes are gone from here too, not just left untested.)
{
  const FACT_SHAPES = {
    surprise: { upside: 60, price: 148, priceTarget: 210, consensus: "StrongBuy", analysts: 38, sector: "Technology" },
    contrarian: { smartScore: 1, aiScore: 65, aiRating: "Neutral", consensus: "StrongBuy", upside: 38.6, price: 174.25, analysts: 38, bullish: "ai" },
    movement: { upsideFrom: 20, upsideTo: 60, consensusFrom: "Hold", consensusTo: "StrongBuy", price: 100, priceTarget: 160, analysts: 21, sector: "Technology", smartScoreFrom: 4, smartScoreTo: 9 },
    record: { upside: 60, windowLow: 10, windowHigh: 60, snapshots: 30, days: 6.3, price: 100, priceTarget: 160, analysts: 21 },
    steady: { smartScore: 10, snapshots: 30, days: 6.3, upside: 60, consensus: "StrongBuy", analysts: 21 },
    newcomer: { seenIn: 5, windowSnapshots: 30, days: 4.2, upside: 60, consensus: "StrongBuy", analysts: 21, smartScore: 8 },
    list: { members: "AAA (60% to $160), BBB (45% to $145)", count: 2, leader: "AAA", leaderUpside: 60 },
  };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [kind, facts] of Object.entries(FACT_SHAPES)) {
    const hook = { kind, ticker: "AAA", name: "Alpha Inc", sec: "Technology", facts };
    const { prompt } = buildPrompt(hook);
    for (const key of Object.keys(facts)) {
      // Anchored to a fact LINE ("- key: value"), not a bare substring test — several
      // humanised labels legitimately contain a key's letters as a substring (e.g. "Current
      // price:" contains "price:"), which a loose check would misreport as a leak.
      assert.equal(new RegExp(`^- ${escapeRe(key)}:`, "m").test(prompt), false,
        `${kind}: the raw key "${key}" never appears verbatim as a fact line in the prompt`);
      assert.ok(prompt.includes(`- ${humanizeFactKey(key)}:`),
        `${kind}: "${key}" is humanised to "${humanizeFactKey(key)}:" in the prompt`);
    }
  }
}

// --- the "don't repeat the company name" and "no fake movement verb" rules reach the prompt --
{
  const hook = { kind: "surprise", ticker: "AAA", name: "Alpha Inc", sec: "Technology", facts: { upside: 60 } };
  const { system } = buildPrompt(hook);
  assert.ok(/already printed large on the card/i.test(system), "the system prompt says the name is already on the card");
  assert.ok(/do NOT repeat it/i.test(system), "and says not to repeat it");
  assert.ok(/soared/.test(system) && /plunged/.test(system) && /plummeted/.test(system) && /jumped/.test(system),
    "the system prompt names the banned false-movement verbs");
  assert.ok(/never use the ticker/i.test(system), "the no-ticker rule is still stated explicitly");
}

// --- cadence is configuration, not code ---------------------------------------------
{
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 2, candidates: 1 } });
  assert.ok(posts.length <= 2, "postsPerRun caps the output");
  const tickers = new Set(posts.map((p) => p.ticker));
  assert.equal(tickers.size, posts.length, "one run never posts the same ticker twice");
}

// --- recent post KINDS are fed back into the detector (Task 0, Finding 2) ----------------
{
  // A board with two kinds available, so damping has somewhere to move the top hook to.
  const mixed = [row({ t: "AAA", up: 190, pt: 290 }), row({ t: "BBB", up: 45, pt: 145 }),
                 row({ t: "GAP", up: 35, pt: 135, ss: 9, ai: 50, air: "Bearish" })];
  const capture = (sink) => async ({ prompt }) => {
    sink.push(prompt);
    return ["Alpha Inc (AAA) at $100 against a $290 Street target — 190% upside, 21 analysts."];
  };
  const cold = [];
  const hot = [];
  await generate({ history: [mixed], recent: [], provider: capture(cold), exemplars,
                   config: { postsPerRun: 1, candidates: 1 } });
  await generate({
    history: [mixed], provider: capture(hot), exemplars,
    recent: [{ text: "x", ticker: "ZZZ", kind: "surprise" },
             { text: "y", ticker: "YYY", kind: "surprise" },
             { text: "z", ticker: "XXX", kind: "surprise" }],
    config: { postsPerRun: 1, candidates: 1 },
  });
  assert.ok(cold.length && hot.length, "both runs reached the provider");
  assert.notEqual(cold[0], hot[0], "three recent surprise posts change which hook gets written");
}

// --- publishing nothing is a valid outcome --------------------------------------------
{
  const provider = async () => ["Let's dive in! In the world of stocks, a game-changer. Delve deeper!!!"];
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 } });
  assert.equal(posts.length, 0, "an all-slop field publishes nothing");
}
{
  const provider = async () => [];
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 3 } });
  assert.equal(posts.length, 0, "a dead provider yields no posts and does not throw");
}

// --- no eligible rows means no hooks means no posts -------------------------------------
{
  const provider = async () => ["whatever"];
  const penny = [row({ t: "PNY", px: 0.8, mc: 13, up: 9825.6 })];
  const posts = await generate({ history: [penny], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 } });
  assert.equal(posts.length, 0, "penny-stock-only snapshot produces nothing");
}

// --- the descriptor (ci/company-descriptor.mjs) is optional, injected, never loses a post ------
{
  // No getDescriptorFor at all: unaffected, no `descriptor` field appears.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 } });
  assert.equal(posts.length, 1, "no descriptor generator at all still publishes");
  assert.equal("descriptor" in posts[0], false, "no descriptor field when no generator is wired in");
}
{
  // getDescriptorFor succeeds — it is called exactly once, with the FULL stocks.json row (not
  // just the hook's own narrower facts), and now resolves `{ descriptor, scene }` together (one
  // model call feeds both — see ci/company-descriptor.mjs). The descriptor rides on the post;
  // the scene is threaded into the image generator below, not stored on the post itself.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const calls = [];
  const scene = "engineer soldering a circuit board, hands and board filling the frame, mid-motion";
  const getDescriptorFor = async (row) => { calls.push(row); return { descriptor: "building what's next", scene }; };
  const imageCalls = [];
  const generateImageFor = async (sector, ticker, sc) => { imageCalls.push([sector, ticker, sc]); return null; };
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 }, getDescriptorFor, generateImageFor });
  assert.equal(posts.length, 1, "a post still publishes with a descriptor generator wired in");
  assert.equal(posts[0].descriptor, "building what's next", "the resolved descriptor rides on the post");
  assert.equal(calls.length, 1, "the descriptor generator is called exactly once per published post");
  assert.equal(calls[0].t, "AAA", "it receives the full stocks.json row for the post's ticker");
  assert.equal(calls[0].mc, 90_000, "including fields (market cap) a hook's own facts never carry");
  assert.equal(imageCalls.length, 1, "the image generator is still called exactly once");
  assert.equal(imageCalls[0][2], scene, "the resolved SCENE is threaded into the image generator's third argument");
}
{
  // getDescriptorFor throws: the post still publishes, with no descriptor field, and the image
  // generator receives no scene (falls back to its own sector-mapped scene).
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const getDescriptorFor = async () => { throw new Error("boom"); };
  const imageCalls = [];
  const generateImageFor = async (sector, ticker, sc) => { imageCalls.push(sc); return null; };
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 }, getDescriptorFor, generateImageFor });
  assert.equal(posts.length, 1, "a post still publishes when descriptor generation throws");
  assert.equal("descriptor" in posts[0], false, "no descriptor field when the generator throws");
  assert.equal(imageCalls[0], undefined, "no scene reaches the image generator when the descriptor generator throws");
}
{
  // getDescriptorFor resolves empty: same graceful degradation.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const getDescriptorFor = async () => "";
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 }, getDescriptorFor });
  assert.equal(posts.length, 1, "a post still publishes when the descriptor resolves empty");
  assert.equal("descriptor" in posts[0], false, "no descriptor field for an empty (non-object) resolution");
}
{
  // getDescriptorFor resolves an object with a valid descriptor but no usable scene (e.g. a
  // blank string): the descriptor still rides on the post, and no scene reaches the image call.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const getDescriptorFor = async () => ({ descriptor: "building what's next", scene: "   " });
  const imageCalls = [];
  const generateImageFor = async (sector, ticker, sc) => { imageCalls.push(sc); return null; };
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 }, getDescriptorFor, generateImageFor });
  assert.equal(posts[0].descriptor, "building what's next", "a valid descriptor rides on the post even with a blank scene");
  assert.equal(imageCalls[0], undefined, "a blank scene never reaches the image generator");
}

// --- image generation is optional, injected, and can never lose a post --------------------
// generate() must stay file-I/O-free (see the shape note in generate-posts.mjs), so the real
// network call is a fake here — same shape as `provider` above.
{
  // No generateImageFor at all: unaffected, no `image` field appears.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 } });
  assert.equal(posts.length, 1, "no image generator at all still publishes");
  assert.equal("image" in posts[0], false, "no image field when no generator is wired in");
}
{
  // generateImageFor declines (returns null): the post still publishes, with no image field,
  // and the caller does not need to catch anything.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const generateImageFor = async () => null;
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 }, generateImageFor });
  assert.equal(posts.length, 1, "a post still publishes when image generation fails");
  assert.equal("image" in posts[0], false, "no image field when generation fails");
}
{
  // generateImageFor throws: still must not lose the post.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const generateImageFor = async () => { throw new Error("boom"); };
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 }, generateImageFor });
  assert.equal(posts.length, 1, "a post still publishes when the image generator throws");
  assert.equal("image" in posts[0], false, "no image field when the generator throws");
}
{
  // generateImageFor succeeds: THREE steps run — text (already done above), photo (this
  // fake), fusion (the real ci/post-compose.mjs, called directly, no fake needed — it is pure
  // and local). The post carries a sanitised .jpg filename and the FUSED bytes, not the raw
  // photo bytes verbatim: the whole point is that the text is burned into the pixels.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const calls = [];
  // A real, decodable photo — composePost has to actually process it (measure text, sample
  // brightness, rasterise), so unlike the raw-Flux-JPEG days a plain placeholder string will
  // not do. Rendered locally via the same resvg dependency, no network involved.
  const photo = new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
    '<rect width="256" height="256" fill="#f4f6f8"/></svg>',
  ).render().asPng();
  const generateImageFor = async (sector, ticker) => { calls.push([sector, ticker]); return photo; };
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 }, generateImageFor });
  assert.equal(posts.length, 1, "a post still publishes when image generation succeeds");
  assert.equal(calls.length, 1, "the image generator is called exactly once");
  assert.equal(calls[0][0], "Technology", "the sector reaches the image generator");
  // The ticker DOES reach generateImageFor now (it seeds ci/post-image.mjs's deterministic
  // man/woman choice) — what must never happen is the ticker reaching the PROMPT AS TEXT,
  // which ci/test-post-image.mjs asserts directly against buildImagePrompt.
  assert.equal(calls[0][1], "AAA", "the ticker reaches the image generator, to seed the photo only");
  assert.match(posts[0].image, /^AAA-.*\.jpg$/, "image is a sanitised .jpg filename, not a path");
  assert.equal(posts[0].image.includes(":"), false, "the ISO timestamp's colons are sanitised out");
  assert.ok(Buffer.isBuffer(posts[0].imageBuffer), "the fused bytes ride along for main() to write to disk");
  assert.notEqual(posts[0].imageBuffer, photo, "the shipped bytes are the FUSED output, not the raw photo verbatim");
  assert.equal(posts[0].imageBuffer[0], 0xff, "the fused bytes are themselves a real JPEG (SOI marker)");
  assert.equal(posts[0].imageBuffer[1], 0xd8, "the fused bytes are themselves a real JPEG (SOI marker)");
}
{
  // Composition failing (a photo composePost cannot even read the dimensions of) degrades
  // exactly like a failed Flux call — never lose the post over the image.
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];
  const generateImageFor = async () => Buffer.from("not a decodable image at all");
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 1, candidates: 1 }, generateImageFor });
  assert.equal(posts.length, 1, "a post still publishes when composition throws");
  assert.equal("image" in posts[0], false, "no image field when composition fails");
  assert.equal("imageBuffer" in posts[0], false, "and no stray buffer either");
}

// --- every hook kind has an angle, not just the original four -----------------------------
// The generic "Report the fact." fallback throws away the reason the rule fired at all — a
// `record` post that never says "window high" is indistinguishable from a plain upside post.
// This list is the seven kinds ci/hooks.mjs emits (`trend`/`churn` were deleted outright, not
// merely left off this list); adding an eighth there must fail here.
{
  const KINDS = ["surprise", "contrarian", "movement", "list", "record", "steady", "newcomer"];
  for (const kind of KINDS) {
    assert.ok(typeof KIND_BRIEF[kind] === "string" && KIND_BRIEF[kind].length > 20,
      `${kind} has a real angle line`);
    const { prompt } = buildPrompt(
      { kind, ticker: "AAA", name: "Alpha Inc", sec: "Technology", facts: { upside: 60 } });
    assert.ok(prompt.includes(`Angle: ${KIND_BRIEF[kind]}`), `${kind}'s angle reaches the prompt`);
    assert.equal(prompt.includes("Angle: Report the fact."), false,
      `${kind} does not fall through to the generic angle`);
  }
  assert.equal(Object.keys(KIND_BRIEF).length, KINDS.length,
    "KIND_BRIEF covers the seven kinds and nothing else");
  assert.equal("trend" in KIND_BRIEF, false, "trend was deleted, not merely left undocumented");
  assert.equal("churn" in KIND_BRIEF, false, "churn was deleted, not merely left undocumented");
  // The fallback still exists for a kind that is not in the map at all.
  const { prompt } = buildPrompt({ kind: "nosuchkind", ticker: "AAA", name: "Alpha Inc",
                                   sec: "Technology", facts: { upside: 60 } });
  assert.ok(prompt.includes("Angle: Report the fact."), "an unknown kind still gets the fallback");
}

// --- (Wikimedia) POST_PHOTO_SOURCE wiring: flux (default) / wikimedia / both -----------------
// `photoSource` defaults to "flux" (config.photoSource), matching every test above that never
// mentions it at all — those must keep passing unmodified, which is itself part of what this
// section checks.
{
  const fakePhoto = new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
    '<rect width="256" height="256" fill="#f4f6f8"/></svg>',
  ).render().asPng();
  const wikiPhoto = () => ({
    bytes: fakePhoto, width: 256, height: 256, mime: "image/jpeg",
    license: "CC BY-SA 4.0", attribution: "A Photographer — Wikimedia Commons (CC BY-SA 4.0)",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.jpg", title: "Example.jpg",
  });
  const provider = async () => ["Alpha Inc target $160, 60% upside, 21 analysts."];

  // Default config (no photoSource at all): getCompanyPhotoFor must never even be called.
  {
    let wikiCalls = 0;
    const getCompanyPhotoFor = async () => { wikiCalls++; return wikiPhoto(); };
    const generateImageFor = async () => fakePhoto;
    const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                   config: { postsPerRun: 1, candidates: 1 }, generateImageFor, getCompanyPhotoFor });
    assert.equal(wikiCalls, 0, "getCompanyPhotoFor is never called when photoSource is left at its default");
    assert.equal(posts[0].imageSource, "flux", "the default source is flux");
    assert.equal("imageLicense" in posts[0], false, "a Flux photo carries no license field");
  }

  // photoSource: "wikimedia", Commons hit -> Flux is never even attempted.
  {
    let fluxCalls = 0;
    const getCompanyPhotoFor = async () => wikiPhoto();
    const generateImageFor = async () => { fluxCalls++; return fakePhoto; };
    const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                   config: { postsPerRun: 1, candidates: 1, photoSource: "wikimedia" },
                                   generateImageFor, getCompanyPhotoFor });
    assert.equal(fluxCalls, 0, "Flux is never called once Wikimedia already succeeded");
    assert.equal(posts[0].imageSource, "wikimedia", "the post records which source actually won");
    assert.equal(posts[0].imageLicense, "CC BY-SA 4.0", "the license rides along on the post record");
    assert.ok(posts[0].imageAttribution.includes("A Photographer"), "the attribution rides along too");
    assert.equal("compareImage" in posts[0], false, "no comparison image outside of \"both\"");
  }

  // photoSource: "wikimedia", Commons comes back empty -> falls back to Flux, same as a failed
  // Flux call falls back to canvas art elsewhere — never lose the post over a missing photo.
  {
    const getCompanyPhotoFor = async () => null;
    const generateImageFor = async () => fakePhoto;
    const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                   config: { postsPerRun: 1, candidates: 1, photoSource: "wikimedia" },
                                   generateImageFor, getCompanyPhotoFor });
    assert.equal(posts[0].imageSource, "flux", "wikimedia falls back to flux when Commons has nothing");
    assert.ok(posts[0].image, "the post still ships with a real image, just from the fallback source");
  }

  // photoSource: "wikimedia", the lookup itself throws -> same fallback, never an exception.
  {
    const getCompanyPhotoFor = async () => { throw new Error("boom"); };
    const generateImageFor = async () => fakePhoto;
    const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                   config: { postsPerRun: 1, candidates: 1, photoSource: "wikimedia" },
                                   generateImageFor, getCompanyPhotoFor });
    assert.equal(posts[0].imageSource, "flux", "a thrown Wikimedia lookup still falls back to Flux");
  }

  // photoSource: "both" — both run unconditionally; Wikimedia wins the primary slot, and the
  // Flux generation is saved separately as the comparison shot, never in the post record.
  {
    let fluxCalls = 0;
    const getCompanyPhotoFor = async () => wikiPhoto();
    const generateImageFor = async () => { fluxCalls++; return fakePhoto; };
    const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                   config: { postsPerRun: 1, candidates: 1, photoSource: "both" },
                                   generateImageFor, getCompanyPhotoFor });
    assert.equal(fluxCalls, 1, "both sources are actually exercised under \"both\"");
    assert.equal(posts[0].imageSource, "wikimedia", "Wikimedia still wins the primary slot under \"both\"");
    assert.ok(Buffer.isBuffer(posts[0].compareImageBuffer) && posts[0].compareImageBuffer.length > 0,
      "the Flux generation survives as the comparison image's bytes");
    assert.match(posts[0].compareImage, /-compare-flux\.jpg$/, "the comparison file carries a clear suffix");
    assert.notEqual(posts[0].compareImage, posts[0].image, "the comparison file is never the same filename as the primary");
  }

  // photoSource: "both", but Wikimedia has nothing -> Flux alone becomes primary, and there is
  // nothing left to save as a comparison (nothing distinct to compare it against).
  {
    const getCompanyPhotoFor = async () => null;
    const generateImageFor = async () => fakePhoto;
    const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                   config: { postsPerRun: 1, candidates: 1, photoSource: "both" },
                                   generateImageFor, getCompanyPhotoFor });
    assert.equal(posts[0].imageSource, "flux", "Flux is the only usable source, so it becomes primary");
    assert.equal("compareImage" in posts[0], false, "no comparison file when only one source actually succeeded");
  }
}

// --- (Neuron accounting) usageTracker: the writer's onUsage is wired and exhaustion breaks ----
{
  const tracker = newUsageTracker();
  const provider = async ({ n, onUsage }) => {
    onUsage?.({ prompt_tokens: 80, completion_tokens: 8 });
    return ["Alpha Inc target $160, 60% upside, 21 analysts."].slice(0, n);
  };
  await generate({ history: [curr], recent: [], provider, exemplars,
                   config: { postsPerRun: 1, candidates: 1 }, usageTracker: tracker });
  assert.equal(tracker.calls.writer, 1, "a successful writer candidate is recorded on the shared tracker");
  assert.ok(tracker.measuredTextCalls > 0, "the writer's onUsage call is a real measurement, not a guess");
}
{
  // No usageTracker passed at all (every test above this one) must not throw — it is purely
  // additive wiring.
  const provider = async ({ n, onUsage }) => {
    assert.equal(typeof onUsage, "undefined", "no tracker means no onUsage handler is even offered");
    return ["Alpha Inc target $160, 60% upside, 21 analysts."].slice(0, n);
  };
  await assert.doesNotReject(
    generate({ history: [curr], recent: [], provider, exemplars, config: { postsPerRun: 1, candidates: 1 } }),
    "omitting usageTracker entirely is fine",
  );
}
resetForTest();
{
  // Exhaustion detected on the FIRST hook's writer call stops the loop before trying the
  // second hook at all — this is the "ends without posting" behaviour, not five more attempts.
  let providerCalls = 0;
  const provider = async () => {
    providerCalls++;
    markExhausted(); // mirrors ci/provider.mjs's real cloudflare branch on a 4006
    return [];
  };
  const posts = await generate({ history: [curr], recent: [], provider, exemplars,
                                 config: { postsPerRun: 2, candidates: 5 } });
  assert.equal(posts.length, 0, "no posts publish once the very first call hits exhaustion");
  assert.equal(providerCalls, 1, "the loop stops after the FIRST hook — the second hook's provider call never happens");
  resetForTest();
}

console.log("generate-posts neuron-accounting OK — the writer's real usage reaches the shared " +
            "tracker, is purely additive when omitted, and exhaustion stops the hook loop " +
            "immediately instead of retrying every remaining hook");

// --- the composed image's companyName is ALSO the display name, not the raw legal name -----
// The prompt half of this is exercised functionally above (buildPrompt uses hook.name
// directly, so a real hook can drive it end to end). The composePost() call site cannot be
// exercised the same way without decoding rendered pixel text back out of a JPEG — composePost
// is called directly, not injected (see the module header: it is pure and local and needs no
// fake) — so this is a static check on the source, the same style ci/test-feed-kinds.mjs
// already uses to pin a cross-file invariant that isn't otherwise independently observable.
{
  const src = readFileSync(new URL("./generate-posts.mjs", import.meta.url), "utf8");
  assert.ok(/displayCompanyName\(hook\.name\)/.test(src),
    "generate-posts.mjs calls ci/hooks.mjs's displayCompanyName(hook.name) somewhere");
  assert.ok(/companyName:\s*displayName/.test(src),
    "the composed image's companyName is the stripped display name, not the raw hook.name");
  // Same posture for the model-written descriptor (ci/company-descriptor.mjs): the composed
  // image must actually receive it, or the whole feature is wired to nowhere.
  assert.ok(/descriptor:\s*post\.descriptor/.test(src),
    "the composed image's descriptor is the resolved model-written one, not left to the sector fallback alone");
}

// --- (Bugfix regression) main()'s headroom must be told about a REAL exhaustion -------------
// main() itself is not exported/callable in isolation (it does real fs I/O against the actual
// repo paths — see the shape note up top: only generate() is file-I/O-free and testable with
// fakes), so the wiring fact this pins — that computeHeadroom is handed the REAL, live
// ci/cf-budget.mjs exhaustion flag, not just local counters — cannot be exercised end to end
// here. This is a static check on the source, same posture and same reason as the
// displayCompanyName/descriptor checks just above: a real run once printed "the daily free
// allocation is exhausted" and then, a few lines later in the SAME summary, "10,000 remaining"
// — because headroom was computed purely from local spend, which is zero when every call
// 429'd. `computeHeadroom`'s own `exhausted` param exists specifically to prevent that
// contradiction (see ci/run-telemetry.mjs and ci/test-run-telemetry.mjs's dedicated regression
// test) — this pins that main() actually PASSES it in, so the fix cannot silently regress by a
// future edit that calls computeHeadroom without it.
{
  const src = readFileSync(new URL("./generate-posts.mjs", import.meta.url), "utf8");
  assert.ok(/computeHeadroom\([\s\S]{0,200}?isExhausted\(\)/.test(src),
    "main() passes the REAL, live exhaustion flag into computeHeadroom — a 4006 must report " +
    "EXHAUSTED headroom, never a full-looking remaining figure computed from local-only spend");
}

console.log("generate-posts OK — prompt shape, angle per hook kind, best-of-N, cadence config, " +
            "empty-field and penny-stock safety, image generation optional/injected/never loses a post, " +
            "the descriptor optional/injected/never loses a post, display name/descriptor both " +
            "wired into the composed image, POST_PHOTO_SOURCE's flux/wikimedia/both wiring " +
            "(fallback, never-throws, and the \"both\" comparison image staying out of posts.json), " +
            "and main()'s headroom being wired to the REAL exhaustion flag, not just local counters");
