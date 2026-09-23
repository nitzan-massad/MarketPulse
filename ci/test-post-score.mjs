// Checks ci/post-score.mjs — the deterministic judge that turns N candidate texts into
// the one that ships. This is what makes a free, weaker model usable: generate five,
// keep the one that does not read like a bot.

import assert from "node:assert";
import {
  scorePost, pickBest, nameStem, factNumbers, unverifiedNumbers, misdescribedMovementVerbs,
  BANNED, MIN_PUBLISHABLE, TICKER_PENALTY, FABRICATION_PENALTY, MISDESCRIBED_MOVEMENT_PENALTY,
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

// --- length band: 8 WORDS, not characters ---------------------------------------
// The feed card now overlays the post text as a headline, so the band moved from a
// character count to a word count (MAX_WORDS=8, MIN_WORDS=3, both exported).
{
  const good = scorePost("NVDA target $210, 42% upside.", ctx()); // 5 words, in band
  const tooShort = scorePost("NVDA up.", ctx()); // 2 words, below MIN_WORDS
  const tooLong = scorePost(
    "NVDA hits $210 target on 42% upside today with 38 analysts covering.", ctx(),
  ); // 12 words, 4 over MAX_WORDS
  assert.ok(good.score > tooShort.score, "a too-short post is penalised");
  assert.ok(good.score > tooLong.score, "a too-long post is penalised");
  assert.ok(tooShort.reasons.some((r) => /too short.*word/.test(r)), "the reason counts words, not characters");
  assert.ok(tooLong.reasons.some((r) => /too long.*word/.test(r)), "the reason counts words, not characters");
}

// --- the task's own worked example: an 8-word candidate must beat a 12-word one, and
// both must beat a 1-2 word fragment, even though the longer ones carry more digits ------
// Named by the COMPANY, not the ticker, so this isolates the word-count effect the block is
// actually about — the ticker penalty is decisive now (see below) and would otherwise sink
// every fixture here regardless of length.
{
  const eightWords = scorePost("Nvidia hits $210 target on 42% upside today.", ctx()); // 8 words
  const twelveWords = scorePost(
    "Nvidia hits $210 target on 42% upside today with 38 analysts covering.", ctx(),
  ); // 12 words — same digits-and-naming shape, just longer
  const fragment = scorePost("Nvidia up.", ctx()); // 2 words
  assert.ok(eightWords.score > twelveWords.score, "an 8-word candidate beats a 12-word one");
  assert.ok(eightWords.score > fragment.score, "an 8-word candidate beats a 1-2 word fragment");
  assert.ok(eightWords.score >= MIN_PUBLISHABLE, "the 8-word candidate clears the publish floor");
  assert.ok(twelveWords.score < MIN_PUBLISHABLE, "the 12-word candidate does not");
  assert.ok(fragment.score < MIN_PUBLISHABLE, "the fragment does not either");
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

// --- naming: TICKER still BAD; naming the company is now NEUTRAL, not required -------------
// The composed card (ci/post-compose.mjs) already prints the company name large above the
// statement, and the prompt now tells the model not to repeat it (defect F) — so naming the
// company is no longer scored either way, only a ticker still is, decisively.
{
  const nflx = { kind: "movement", ticker: "NFLX", name: "Netflix" };
  const byTicker = scorePost("NFLX: Smart Score 8 to 6, upside 28% to 34%.", { hook: nflx });
  const byName = scorePost("Netflix: Smart Score 8 to 6, upside 28% to 34%.", { hook: nflx });
  // Same word/digit shape as byTicker, so the only thing distinguishing it is naming
  // neither: this isolates the naming rule's own effect.
  const neither = scorePost("Smart Score 8 to 6, upside 28% to 34% overall.", { hook: nflx });
  assert.ok(byName.score > byTicker.score, "naming the company still beats naming the ticker");
  assert.ok(byTicker.reasons.some((r) => /names the ticker/i.test(r)), "the reason names the ticker penalty");
  // DECISIVE — a ticker mention has to sink the candidate outright (like fabrication).
  assert.ok(byTicker.score < neither.score, "naming the ticker is worse than naming nothing at all");
  assert.ok(byTicker.score < MIN_PUBLISHABLE, "and lands below the publish floor by itself");
  // NEITHER naming the company NOR omitting it is scored any more — the card already carries
  // the name, so the statement is not required to. `byName` differs from `neither` only in
  // which word starts the sentence ("Netflix:" vs nothing), not in score-relevant content, so
  // they land close together — what matters is that omitting the name costs nothing.
  assert.equal(neither.reasons.some((r) => /does not name/.test(r)), false,
    "omitting the company name is no longer penalised — the card already shows it");
  assert.equal(byName.reasons.some((r) => /^names Netflix$/.test(r)), true,
    "naming it is still noted in the reasons, informationally, just not scored");
}
{
  // DECISIVE, the same way FABRICATION_PENALTY is: even a candidate maxing out every other
  // bonus (digits, length band, naming credit) must still land under MIN_PUBLISHABLE once it
  // names a ticker — this is the task's own worked example, published for real once.
  const ird = { kind: "surprise", ticker: "IRD", name: "Opus Genetics",
                facts: { upside: 151.7, price: 13.14, priceTarget: 20, consensus: "StrongBuy",
                         analysts: 11, sector: "Healthcare" } };
  const fab = "IRD soared 151.7% to $13.14.";
  const r = scorePost(fab, { hook: ird });
  assert.ok(r.reasons.some((x) => /names the ticker IRD/i.test(x)), "the ticker is flagged");
  assert.ok(r.score < MIN_PUBLISHABLE, "the exact published bug is now rejected outright");
  assert.equal(pickBest([fab], { hook: ird }), null, "and pickBest ships nothing rather than this");
  assert.ok(TICKER_PENALTY > 56, "the penalty alone beats the documented 86-point bonus ceiling");
  assert.ok(TICKER_PENALTY < FABRICATION_PENALTY, "decisive, but a ticker is still a lesser sin than a fabricated number");
}
{
  // A multi-word name must match on its distinctive first word, not the whole string.
  const prax = { kind: "surprise", ticker: "PRAX", name: "Praxis Precision Medicines, Inc." };
  const r = scorePost("$299 to $732. That is 13 analysts' call on Praxis.", { hook: prax });
  assert.ok(r.reasons.some((r2) => /names/.test(r2)), "the leading word counts as naming it");
}
{
  // The trap: a ticker that is a substring of an ordinary word must not fire (word
  // boundaries), and a ticker that is only a case-different spelling of the company name
  // it legitimately uses must not double as a penalty on top of the name reward.
  const gm = { kind: "surprise", ticker: "GM", name: "General Motors" };
  const ordinary = scorePost("General Motors reported strong sales at 9am GMT today.", { hook: gm });
  assert.equal(ordinary.reasons.some((r) => /names the ticker/i.test(r)), false,
    "the ticker GM inside the ordinary word GMT does not fire — word boundaries hold");
  assert.ok(ordinary.reasons.some((r) => /^names General$/.test(r)), "and the company name is still credited");

  const ird = { kind: "surprise", ticker: "IRD", name: "Ird Holdings" };
  const sameSpelling = scorePost("IRD is up 42% on 11 analysts today.", { hook: ird });
  assert.ok(sameSpelling.reasons.some((r) => /^names Ird$/.test(r)), "the name reward fires");
  assert.equal(sameSpelling.reasons.some((r) => /names the ticker/i.test(r)), false,
    "and the ticker penalty does not also fire for the same word — the name IS the ticker's spelling here");
}
{
  // A standalone ticker inside otherwise-clean copy is still a penalty even when a name
  // match is not in play at all (name absent from the hook).
  const r = scorePost("NVDA target $210, 42% upside.", { hook: { kind: "surprise", ticker: "NVDA" } });
  assert.ok(r.reasons.some((r2) => /names the ticker NVDA/.test(r2)), "a bare ticker mention is flagged");
}
assert.equal(nameStem("Xpo, Inc."), "Xpo", "stem is the leading word");
assert.equal(nameStem("Praxis Precision Medicines"), "Praxis", "multi-word name stems to the first");
assert.equal(nameStem("Inc"), "", "a bare corporate suffix is not a name");
assert.equal(nameStem(""), "", "empty name has no stem");
assert.equal(nameStem(undefined), "", "missing name has no stem");
{
  // A hook with a name but no ticker, and a candidate that omits the name entirely: no naming
  // reason is pushed at all any more (not a bonus, not a penalty) — the card already carries
  // the name, so this is simply not evaluated.
  const r = scorePost("Nothing relevant here at all, just filler words.",
    { hook: { kind: "trend", name: "Datadog Inc" } });
  assert.equal(r.reasons.some((x) => /does not name/.test(x)), false,
    "omitting a name-only hook's name is not penalised");
  assert.equal(r.reasons.some((x) => /^names Datadog$/.test(x)), false,
    "and obviously not credited either, since it was never used");
}
{
  // A nameless, contextless candidate must still fail on its OWN merits (no digits — "not a
  // data post" — and no banned-phrase/length help either) even though the naming penalty that
  // used to help sink it is gone. Removing the naming requirement must never be the thing that
  // lets a vapid candidate through.
  const vapid = scorePost("Nothing relevant here at all, just filler words.",
    { hook: { kind: "trend", name: "Datadog Inc" } });
  assert.ok(vapid.score < MIN_PUBLISHABLE, "a contextless candidate with no numbers still fails to publish");
  assert.ok(vapid.reasons.some((r) => /no numbers/.test(r)), "still flagged for carrying no concrete data");
}

// --- pickBest ------------------------------------------------------------------
{
  // Named by the company, not the ticker — same reasoning as the worked example above.
  const best = pickBest(
    ["Let's dive in! A game-changer.", "Nvidia target $210 — 42% upside, 38 analysts covering."],
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
  // Kept within the 8-word cap (unlike `roundedText` above, which is only used for the
  // number-verification check, not scored) so this isolates "rounding is accepted" from the
  // unrelated too-long penalty.
  const roundedShort = "Up 120% to a $75 target, 11 analysts.";
  assert.deepEqual(unverifiedNumbers(roundedShort, ird), [],
    "the same rounding still verifies clean in a headline-length candidate");
  assert.ok(scorePost(roundedShort, { hook: ird }).score >= MIN_PUBLISHABLE, "and stays publishable");

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

// --- MISDESCRIBED MOVEMENT VERBS: a true number, framed as a price move it never was --------
// The other half of the exact published bug: "IRD soared 151.7% to $13.14" — 151.7% was real
// (analyst upside-to-target), but "soared" claimed a price move that never happened.
{
  const ird = { kind: "surprise", ticker: "IRD", name: "Opus Genetics",
                facts: { upside: 151.7, price: 13.14, priceTarget: 20, consensus: "StrongBuy",
                         analysts: 11, sector: "Healthcare" } };
  // The exact bug, minus the ticker itself (that half is its own, separately-tested rejection
  // above) — just the movement verb attached to the upside number.
  assert.deepEqual(misdescribedMovementVerbs("Upside soared 151.7% to a $20 target.", ird), ["soared"],
    "a movement verb on an analyst-upside number is flagged");
  const r = scorePost("Upside soared 151.7% to a $20 target.", { hook: ird });
  assert.ok(r.reasons.some((x) => /misdescribes a target\/score\/forecast/.test(x)), "the reason explains why");
  assert.ok(r.score < MIN_PUBLISHABLE, "the candidate is rejected even though every number in it is real");
  assert.equal(pickBest(["Upside soared 151.7% to a $20 target."], { hook: ird }), null,
    "pickBest ships nothing rather than this");
}
// A handful of close synonyms ("and the like") are covered too, on a Smart Score number.
{
  const hook = { kind: "trend", name: "Alpha Inc", facts: { smartScoreFrom: 4, smartScoreTo: 9 } };
  for (const verb of ["plunged", "rocketed", "crashed", "jumped", "surged", "spiked"]) {
    const text = `Smart Score ${verb} from 4 to 9.`;
    assert.ok(misdescribedMovementVerbs(text, hook).length > 0, `"${verb}" on a Smart Score is flagged`);
  }
}
// The task's own explicit exemption: a LEGITIMATE use — a verb describing a number that is
// genuinely a realized price change, not a target/score/forecast — must still pass. No hook
// ci/hooks.mjs emits today carries such a fact, so this is a synthetic (but representative)
// fixture: the check is against the SHAPE of the fact key, not today's specific hook kinds.
{
  const priceMove = { kind: "movement", name: "Alpha Inc", facts: { priceFrom: 100, priceTo: 148 } };
  assert.deepEqual(misdescribedMovementVerbs("Price jumped from $100 to $148 today.", priceMove), [],
    "a movement verb over a genuine price-delta fact is not flagged");
  assert.ok(scorePost("Price jumped from $100 to $148 today.", { hook: priceMove }).score >
    scorePost("Upside jumped from 100 to 148 today.", { hook: { kind: "surprise", name: "Alpha Inc", facts: { upside: 148 } } }).score,
    "a legitimate price move scores better than the same verb misapplied to a forecast number");
}
// No hook at all, or a hook with no facts, vouches for nothing — same fail-closed posture as
// unverifiedNumbers — so there is nothing to compare the verb against and it is not flagged.
{
  assert.deepEqual(misdescribedMovementVerbs("It soared 40% today.", null), [],
    "with no hook there is nothing to check the verb against");
  assert.deepEqual(misdescribedMovementVerbs("It soared 40% today.", { kind: "surprise" }), [],
    "a hook with no facts backs no number, so the verb has nothing to misdescribe");
}
// A candidate with no movement verb at all is never flagged, obviously.
assert.deepEqual(
  misdescribedMovementVerbs("Upside at 151.7% to a $20 target.", { facts: { upside: 151.7, priceTarget: 20 } }),
  [], "no movement verb, nothing to flag",
);
assert.ok(MISDESCRIBED_MOVEMENT_PENALTY > 56, "the penalty alone beats the documented 86-point bonus ceiling");
assert.ok(MISDESCRIBED_MOVEMENT_PENALTY < FABRICATION_PENALTY,
  "decisive, but a misdescribed (still TRUE) number is a lesser sin than a fabricated one");

console.log("post-score OK — banned phrases, numbers, number VERIFICATION, decisive ticker penalty, misdescribed movement verbs, naming no longer required, length, dedupe, full-list scan, hashtags, exclamations, pickBest floor, determinism");
