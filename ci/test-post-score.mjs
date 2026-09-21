// Checks ci/post-score.mjs — the deterministic judge that turns N candidate texts into
// the one that ships. This is what makes a free, weaker model usable: generate five,
// keep the one that does not read like a bot.

import assert from "node:assert";
import {
  scorePost, pickBest, nameStem, factNumbers, unverifiedNumbers, BANNED, MIN_PUBLISHABLE,
} from "./post-score.mjs";

// The FULL `surprise` fact shape ci/hooks.mjs emits — { upside, price, priceTarget, consensus,
// analysts, sector } — not a two-key sketch of it. The candidate texts below quote the price
// ($148) and the analyst count (38) as well as the upside and the target, and since the scorer
// now verifies every number against these facts, a fixture missing a key would make truthful
// copy read as fabricated. No assertion below changed; only the fixture got real.
const hook = { kind: "surprise", ticker: "NVDA", name: "Nvidia Corp",
               facts: { upside: 42, price: 148, priceTarget: 210,
                        consensus: "StrongBuy", analysts: 38, sector: "Technology" } };
const ctx = (recent = []) => ({ hook, recent });

assert.ok(BANNED.length > 5, "there is a real banned-phrase list");
assert.ok(Number.isFinite(MIN_PUBLISHABLE), "there is a publish floor");

// --- LLM tells are penalised ---------------------------------------------------
{
  const clean = scorePost("NVDA at $148. Street target: $210. That's 42% on the table.", ctx());
  const slop = scorePost("Let's dive in! In the world of tech, NVDA is a game-changer.", ctx());
  assert.ok(clean.score > slop.score, "clean copy outscores LLM boilerplate");
  assert.ok(slop.reasons.some((r) => /banned/i.test(r)), "the banned phrase is named in the reasons");
}

// --- a post with no number is not a data post ----------------------------------
{
  const withNum = scorePost("NVDA target $210 — 42% upside.", ctx());
  const without = scorePost("NVDA is looking really strong right now honestly.", ctx());
  assert.ok(withNum.score > without.score, "concrete numbers beat vibes");
}

// --- length band ---------------------------------------------------------------
{
  const good = scorePost("NVDA target $210, 42% upside. 38 analysts, none bearish.", ctx());
  const tooShort = scorePost("NVDA up 42%.", ctx());
  const tooLong = scorePost(`NVDA target $210 42% upside. ${"filler words here ".repeat(60)}`, ctx());
  assert.ok(good.score > tooShort.score, "a too-short post is penalised");
  assert.ok(good.score > tooLong.score, "a too-long post is penalised");
}

// --- dedupe against what already shipped ---------------------------------------
{
  const text = "NVDA target $210 — 42% upside, 38 analysts covering.";
  const fresh = scorePost(text, ctx([]));
  const repeat = scorePost(text, ctx([{ text, ticker: "NVDA" }]));
  assert.ok(repeat.score < fresh.score, "near-duplicate of a recent post is penalised");
  assert.ok(repeat.reasons.some((r) => /dup|repeat|recent/i.test(r)), "the reasons say why");
}

// --- dedupe scans entire list despite ticker match early
{
  const candidate = "NVDA target $210 — 42% upside, 38 analysts covering.";
  const recent = [
    { text: "NVDA is great.", ticker: "NVDA" },  // shares ticker but different text
    { text: "NVDA target $210 — 42% upside, 38 analysts covering.", ticker: "OTHER" },  // duplicate but different ticker
  ];
  const result = scorePost(candidate, ctx(recent));
  assert.ok(result.reasons.some((r) => /appeared in a recent post/i.test(r)), "ticker-repeat penalty applied");
  assert.ok(result.reasons.some((r) => /duplicate.*word overlap/i.test(r)), "duplicate penalty also detected despite ticker match");
}

// --- naming: ticker OR company name --------------------------------------------
// The feed shows company names, so a ticker-only rule punished the right copy. This is the
// exact NFLX candidate that scored 10 with "missing NFLX" in Task 0.
{
  const nflx = { kind: "movement", ticker: "NFLX", name: "Netflix" };
  const byTicker = scorePost("NFLX: Smart Score 8 to 6, upside 28% to 34%.", { hook: nflx });
  const byName = scorePost("Netflix: Smart Score 8 to 6, upside 28% to 34%.", { hook: nflx });
  const neither = scorePost("Smart Score 8 to 6, upside 28% to 34%. Quite a week.", { hook: nflx });
  assert.equal(byTicker.score, byName.score, "naming the company scores like naming the ticker");
  assert.ok(byName.score > neither.score, "naming nothing is still penalised");
  assert.ok(neither.reasons.some((r) => /does not name/.test(r)), "and the reason says so");
}
{
  // A multi-word name must match on its distinctive first word, not the whole string.
  const prax = { kind: "surprise", ticker: "PRAX", name: "Praxis Precision Medicines, Inc." };
  const r = scorePost("$299 to $732. That is 13 analysts' call on Praxis.", { hook: prax });
  assert.ok(r.reasons.some((r2) => /names/.test(r2)), "the leading word counts as naming it");
}
assert.equal(nameStem("Xpo, Inc."), "Xpo", "stem is the leading word");
assert.equal(nameStem("Praxis Precision Medicines"), "Praxis", "multi-word name stems to the first");
assert.equal(nameStem("Inc"), "", "a bare corporate suffix is not a name");
assert.equal(nameStem(""), "", "empty name has no stem");
assert.equal(nameStem(undefined), "", "missing name has no stem");
{
  // A hook with a name but no ticker must still be scored on naming.
  const r = scorePost("Nothing relevant here at all, just filler words.",
    { hook: { kind: "trend", name: "Datadog Inc" } });
  assert.ok(r.reasons.some((x) => /does not name Datadog/.test(x)), "name-only hooks are checked");
}

// --- pickBest ------------------------------------------------------------------
{
  const best = pickBest(
    ["Let's dive in! A game-changer.", "NVDA target $210 — 42% upside, 38 analysts covering."],
    ctx(),
  );
  assert.ok(best, "pickBest returns a winner");
  assert.ok(best.text.includes("$210"), "it picked the concrete one");
  assert.ok(Array.isArray(best.reasons), "the winner carries its reasons");
}
assert.equal(pickBest([], ctx()), null, "no candidates means no post");
assert.equal(pickBest(["Let's dive in! In the world of finance, a game-changer. Delve deeper!"], ctx()), null,
  "an all-slop field publishes nothing rather than shipping junk");

// --- hashtag spam penalty -------------------------------------------------------
{
  const clean = scorePost("NVDA target $210 — 42% upside, 38 analysts.", ctx());
  const spam = scorePost("NVDA target $210 — 42% upside, 38 analysts. #stocks #nvda #trading #tech #finance #bullish", ctx());
  assert.ok(spam.score < clean.score, "posts with many hashtags are penalised");
  assert.ok(spam.reasons.some((r) => /hashtags/i.test(r)), "hashtag penalty is in reasons");
}

// --- exclamation mark density penalty -------------------------------------------
{
  const clean = scorePost("NVDA target $210 — 42% upside, 38 analysts.", ctx());
  const dense = scorePost("NVDA target $210! 42% upside! 38 analysts! Amazing!", ctx());
  assert.ok(dense.score < clean.score, "posts with many exclamation marks are penalised");
  assert.ok(dense.reasons.some((r) => /exclamation/i.test(r)), "exclamation penalty is in reasons");
}

// --- determinism ----------------------------------------------------------------
{
  const t = "NVDA target $210 — 42% upside.";
  assert.deepEqual(scorePost(t, ctx()), scorePost(t, ctx()), "same input, same score");
}

// --- NUMBER VERIFICATION: a post may not state a number the hook does not vouch for ------
// Every fact object below is the literal shape ci/hooks.mjs builds for that kind.
{
  // `surprise`: { upside, price, priceTarget, consensus, analysts, sector }
  const ird = { kind: "surprise", ticker: "IRD", name: "Ird Holdings",
                facts: { upside: 120.4, price: 34.1, priceTarget: 75.2,
                         consensus: "StrongBuy", analysts: 11, sector: "Technology" } };

  // 1. Honest — every number comes straight out of the facts.
  const honest = scorePost("IRD is up 120.4% to a $75.2 target on 11 analysts.", { hook: ird });
  assert.deepEqual(unverifiedNumbers("IRD is up 120.4% to a $75.2 target on 11 analysts.", ird), [],
    "a candidate built only from the hook's own numbers has nothing unverified");
  assert.ok(honest.score >= MIN_PUBLISHABLE, "and it is publishable");
  assert.equal(honest.reasons.some((r) => /unverified/.test(r)), false, "no fabrication reason on honest copy");

  // 2. Fabricated — the measured example: 91, 412 and 38 are all invented.
  const fabText = "IRD is up 91% to a $412 target on 38 analysts.";
  assert.deepEqual(unverifiedNumbers(fabText, ird), ["91", "412", "38"],
    "every invented number is named");
  const fab = scorePost(fabText, { hook: ird });
  assert.ok(fab.score < MIN_PUBLISHABLE,
    "a fabricated number puts the candidate below the publish floor whatever else it gets right");
  assert.ok(fab.reasons.some((r) => /unverified/.test(r)), "and the reasons say which numbers");
  assert.equal(pickBest([fabText], { hook: ird }), null, "so pickBest publishes nothing");

  // 3. Rounded but truthful — ACCEPTED, and deliberately so. 120 is 120.4 truncated and 75 is
  //    75.2 truncated; a writer rounding a sourced figure is not inventing one, and rejecting
  //    it would kill most real copy. Ceiling is NOT accepted (see 4).
  const roundedText = "IRD is up 120% to a $75 target on 11 analysts.";
  assert.deepEqual(unverifiedNumbers(roundedText, ird), [],
    "a truthful number rounded down to a whole number passes");
  assert.ok(scorePost(roundedText, { hook: ird }).score >= MIN_PUBLISHABLE, "and stays publishable");

  // 4. Rounding UP past the fact is not rounding, it is overstating the target.
  assert.deepEqual(unverifiedNumbers("IRD carries a $76 target.", ird), ["76"],
    "$76 must not stand in for a $75.2 target");

  // 5. One invented number among true ones is still a rejection.
  const mixed = scorePost("IRD is up 120.4% to a $75.2 target on 47 analysts.", { hook: ird });
  assert.ok(mixed.score < MIN_PUBLISHABLE, "one invented number is enough to sink the candidate");
}
{
  // `contrarian`: { smartScore, aiScore, aiRating, consensus, upside, price, analysts, bullish }.
  // These are Task 0's three good XPO candidates, verbatim. They must all still pass.
  const xpo = { kind: "contrarian", ticker: "XPO", name: "Xpo, Inc.",
                facts: { smartScore: 1, aiScore: 65, aiRating: "Neutral", consensus: "StrongBuy",
                         upside: 38.6, price: 174.25, analysts: 38, bullish: "ai" } };
  const task0 = [
    "XPO: Smart Score 1 out of 10. AI model says 65 out of 100. Analyst consensus is Strong Buy. Three models, three answers, $174 stock.",
    "The quant model rates XPO a 1. The AI rates it 65. The analysts say Strong Buy with 38% upside. Somebody here is very wrong.",
    "XPO has a Smart Score of 1 and a Strong Buy consensus at the same time. That combination shows up on maybe one name in four hundred.",
  ];
  for (const t of task0) {
    assert.deepEqual(unverifiedNumbers(t, xpo), [], `Task 0 good copy still verifies: ${t.slice(0, 40)}...`);
  }
  // "out of 10" / "out of 100" are the SCALES, exempt as an idiom only.
  assert.deepEqual(unverifiedNumbers("XPO scores 8 out of 10 on nothing in particular.", xpo), ["8"],
    "the denominator is exempt, the numerator is not");
  assert.deepEqual(unverifiedNumbers("XPO carries a $100 price target.", xpo), ["100"],
    "a bare 100 is a claim, not a scale");
}
{
  // `list`: members is one string holding the whole board, and those numbers are real.
  const list = { kind: "list", ticker: "IRD", name: "Ird Holdings",
                 facts: { members: "IRD (120.4% to $41), PRAX (98.1% to $732), AAA (60% to $160)",
                          count: 3, leader: "IRD", leaderUpside: 120.4 } };
  assert.deepEqual(unverifiedNumbers("IRD 120.4% to $41, PRAX 98.1% to $732, AAA 60% to $160.", list), [],
    "numbers packed inside a string fact still count as vouched for");
  assert.deepEqual(unverifiedNumbers("IRD leads at 205% upside.", list), ["205"],
    "and an invented one in the same shape is still caught");
}
{
  // Fails closed: a hook that vouches for nothing backs no number.
  assert.deepEqual(unverifiedNumbers("AAA is up 40%.", { kind: "surprise", ticker: "AAA" }), ["40"],
    "a hook with no facts vouches for nothing");
  assert.deepEqual(unverifiedNumbers("AAA is up 40%.", null), [],
    "with no hook at all there is nothing to verify against");
  assert.deepEqual(unverifiedNumbers("AAA had a good week.", { kind: "surprise", facts: {} }), [],
    "a post with no numbers has nothing to fabricate");
}
{
  // factNumbers is the reference set, and it reads through strings and nesting.
  const set = factNumbers({ upside: 38.6, consensus: "StrongBuy", members: "A (12% to $34)" });
  assert.equal(set.has(38.6), true, "numeric facts are in the set");
  assert.equal(set.has(12) && set.has(34), true, "numbers inside string facts are in the set");
  assert.equal(set.has(99), false, "and nothing else is");
  assert.equal(factNumbers(undefined).size, 0, "missing facts yield an empty reference set");
}

console.log("post-score OK — banned phrases, numbers, number VERIFICATION, length, dedupe, full-list scan, hashtags, exclamations, pickBest floor, determinism");
