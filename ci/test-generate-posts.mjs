// Checks ci/generate-posts.mjs — the wiring. Uses an injected fake provider, so this
// check never touches the network and never writes a file: generate() is pure apart
// from the provider it is handed, which is the whole reason it is shaped that way.

import assert from "node:assert";
import { Resvg } from "@resvg/resvg-js";
import { buildPrompt, generate, humanizeFactKey, KIND_BRIEF } from "./generate-posts.mjs";

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
// any of the nine hook kinds (ci/hooks.mjs) actually emits must render as a humanised label
// instead — this exercises every key across a realistic sample of each kind's own shape.
{
  const FACT_SHAPES = {
    surprise: { upside: 60, price: 148, priceTarget: 210, consensus: "StrongBuy", analysts: 38, sector: "Technology" },
    contrarian: { smartScore: 1, aiScore: 65, aiRating: "Neutral", consensus: "StrongBuy", upside: 38.6, price: 174.25, analysts: 38, bullish: "ai" },
    movement: { upsideFrom: 20, upsideTo: 60, consensusFrom: "Hold", consensusTo: "StrongBuy", price: 100, priceTarget: 160, analysts: 21, sector: "Technology", smartScoreFrom: 4, smartScoreTo: 9 },
    record: { upside: 60, windowLow: 10, windowHigh: 60, snapshots: 30, days: 6.3, price: 100, priceTarget: 160, analysts: 21 },
    trend: { smartScoreFrom: 4, smartScoreTo: 9, direction: "up", snapshots: 30, days: 6.3, upside: 60, consensus: "StrongBuy", analysts: 21 },
    steady: { smartScore: 10, snapshots: 30, days: 6.3, upside: 60, consensus: "StrongBuy", analysts: 21 },
    churn: { distinctScores: 4, low: 3, high: 9, smartScore: 9, snapshots: 30, days: 6.3, analysts: 21 },
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
// This list is the nine kinds ci/hooks.mjs emits; adding a tenth there must fail here.
{
  const KINDS = ["surprise", "contrarian", "movement", "list",
                 "record", "trend", "steady", "churn", "newcomer"];
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
    "KIND_BRIEF covers the nine kinds and nothing else");
  // The fallback still exists for a kind that is not in the map at all.
  const { prompt } = buildPrompt({ kind: "nosuchkind", ticker: "AAA", name: "Alpha Inc",
                                   sec: "Technology", facts: { upside: 60 } });
  assert.ok(prompt.includes("Angle: Report the fact."), "an unknown kind still gets the fallback");
}

console.log("generate-posts OK — prompt shape, angle per hook kind, best-of-N, cadence config, " +
            "empty-field and penny-stock safety, image generation optional/injected/never loses a post");
