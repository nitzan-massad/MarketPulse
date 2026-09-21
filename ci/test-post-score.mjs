// Checks ci/post-score.mjs — the deterministic judge that turns N candidate texts into
// the one that ships. This is what makes a free, weaker model usable: generate five,
// keep the one that does not read like a bot.

import assert from "node:assert";
import { scorePost, pickBest, nameStem, BANNED, MIN_PUBLISHABLE } from "./post-score.mjs";

const hook = { kind: "surprise", ticker: "NVDA", name: "Nvidia Corp",
               facts: { upside: 42, priceTarget: 210 } };
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

// --- determinism ----------------------------------------------------------------
{
  const t = "NVDA target $210 — 42% upside.";
  assert.deepEqual(scorePost(t, ctx()), scorePost(t, ctx()), "same input, same score");
}

console.log("post-score OK — banned phrases, numbers, length, dedupe, pickBest floor, determinism");
