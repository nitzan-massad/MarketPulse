// Checks ci/hooks.mjs — the deterministic rule layer that picks what a post is ABOUT.
// No LLM and no network: given the same window this must always produce the same ranked
// hooks, which is what makes the generator reproducible and a bad post debuggable.

import assert from "node:assert";
import { detectHooks, eligible, coverage, SANE_MAX_UPSIDE, MIN_WINDOW } from "./hooks.mjs";

const row = (over = {}) => ({
  t: "AAA", n: "Alpha Inc", sec: "Technology", px: 100, chg: 1, pt: 130, up: 30,
  con: "Buy", b: 10, h: 2, s: 0, ss: 8, ai: 70, air: "Neutral", aipt: 125,
  mc: 50_000, desc: "", ...over,
});
/** A window of `n` snapshots, each a single row built by `f(i)`. Oldest first. */
const win = (n, f) => Array.from({ length: n }, (_, i) => [f(i)]);

// --- eligibility: the four floors -------------------------------------------
assert.equal(eligible(row()), true, "a normal large-cap row is eligible");
assert.equal(eligible(row({ mc: 13 })), false, "a $13M micro-cap is filtered out");
assert.equal(eligible(row({ px: 0.806 })), false, "a sub-$3 stock is filtered out");
assert.equal(eligible(row({ up: 9825.6 })), false, "an absurd upside is filtered out");
// Task 0, Finding 3: AGEN, a $900M name at $7.85, showed 148% upside on TWO analysts.
assert.equal(eligible(row({ b: 2, h: 0, s: 0, up: 148 })), false, "thin coverage is filtered out");
assert.equal(eligible(row({ up: 0 })), false, "zero upside is filtered out");
assert.equal(eligible(row({ up: -5 })), false, "negative upside is filtered out");
assert.equal(coverage(row({ b: 3, h: 2, s: 1 })), 6, "coverage sums buy/hold/sell");
assert.ok(SANE_MAX_UPSIDE > 0 && SANE_MAX_UPSIDE < 1000, "sanity band is a real bound");
assert.ok(MIN_WINDOW >= 2, "the window rules need a real series");

// --- point-in-time rules work on a window of one -----------------------------
{
  const hooks = detectHooks([[row({ t: "BIG", up: 85 }), row({ t: "MEH", up: 4 })]]);
  const s = hooks.filter((h) => h.kind === "surprise");
  assert.ok(s.length >= 1, "a high-upside name produces a surprise hook");
  assert.equal(s[0].ticker, "BIG", "the higher upside outranks the lower one");
  assert.equal(s[0].facts.upside, 85, "facts carry the upside verbatim");
}
{
  const hooks = detectHooks([[row({ t: "SPLIT", ss: 9, ai: 25, air: "Bearish" })]]);
  const c = hooks.filter((h) => h.kind === "contrarian");
  assert.equal(c.length, 1, "Smart Score 9 against AI 25 is a contrarian hook");
  assert.equal(c[0].facts.smartScore, 9, "facts carry the Smart Score");
}
{
  const hooks = detectHooks([[row({ ss: 8, ai: 75, air: "Neutral" })]]);
  assert.equal(hooks.filter((h) => h.kind === "contrarian").length, 0, "agreement is not a hook");
}
{
  const curr = [row({ t: "A", up: 60 }), row({ t: "B", up: 55 }), row({ t: "C", up: 50 })];
  const l = detectHooks([curr]).filter((h) => h.kind === "list");
  assert.equal(l.length, 1, "the list hook is emitted at most once per run");
  assert.ok(String(l[0].facts.members).includes("A"), "list facts name their members");
}

// --- movement still compares the last two --------------------------------------
{
  const hooks = detectHooks([
    [row({ t: "MOVE", ss: 4, con: "Hold", up: 10 })],
    [row({ t: "MOVE", ss: 9, con: "StrongBuy", up: 40 })],
  ]).filter((h) => h.kind === "movement");
  assert.ok(hooks.length >= 1, "a jump in Smart Score and consensus is a movement hook");
  assert.equal(hooks[0].facts.smartScoreFrom, 4, "facts carry the previous Smart Score");
  assert.equal(hooks[0].facts.smartScoreTo, 9, "facts carry the new Smart Score");
}
assert.equal(detectHooks([[row({ t: "NEW" })]]).filter((h) => h.kind === "movement").length, 0,
  "with a window of one there are no movement hooks");
{
  // Movement hook from upside delta when one row has null Smart Score — must not coerce to 0
  const hooks = detectHooks([
    [row({ t: "NULLSS", ss: null, up: 20 })],
    [row({ t: "NULLSS", ss: null, up: 40 })],
  ]).filter((h) => h.kind === "movement");
  assert.ok(hooks.length >= 1, "a 20-point upside jump fires a movement hook even with null Smart Score");
  assert.equal("smartScoreFrom" in hooks[0].facts, false, "smartScoreFrom is omitted when ss is null");
  assert.equal("smartScoreTo" in hooks[0].facts, false, "smartScoreTo is omitted when ss is null");
  assert.ok("upsideFrom" in hooks[0].facts && "upsideTo" in hooks[0].facts, "upside facts are still present");
}
{
  // Movement hook with one null and one finite Smart Score — both keys must be absent
  const hooks = detectHooks([
    [row({ t: "MIXED", ss: 5, up: 20 })],
    [row({ t: "MIXED", ss: null, up: 40 })],
  ]).filter((h) => h.kind === "movement");
  assert.ok(hooks.length >= 1, "a upside jump fires a movement hook even when ss goes null");
  assert.equal("smartScoreFrom" in hooks[0].facts, false, "smartScoreFrom is omitted when either is null");
  assert.equal("smartScoreTo" in hooks[0].facts, false, "smartScoreTo is omitted when either is null");
}

// --- movement facts: no coercion, and an eligible baseline ----------------------
// CLAUDE.md: an explicit null from TipRanks is data, not a gap. These facts go verbatim into
// the writer prompt, so a coerced `upsideFrom: 0` or a stringified `consensusFrom: null` is a
// false statement about a real company, not a cosmetic wart. 0 of 159 movement firings hit
// this on the live data — it is prevention, which is exactly why it needs a test.
{
  // Baseline: every reading present. This pins the exact fact bag, so a future "tidy-up"
  // cannot quietly drop or rename a key for the ordinary case.
  const hooks = detectHooks([
    [row({ t: "FULL", ss: 4, con: "Hold", up: 10, pt: 110, px: 100, b: 10, h: 2, s: 0 })],
    [row({ t: "FULL", ss: 9, con: "StrongBuy", up: 40, pt: 140, px: 100, b: 10, h: 2, s: 0 })],
  ]).filter((h) => h.kind === "movement");
  assert.equal(hooks.length, 1, "a fully-populated pair still fires exactly one movement hook");
  assert.deepEqual(hooks[0].facts, {
    upsideFrom: 10, upsideTo: 40,
    consensusFrom: "Hold", consensusTo: "StrongBuy",
    price: 100, priceTarget: 140, analysts: 12, sector: "Technology",
    smartScoreFrom: 4, smartScoreTo: 9,
  }, "present readings are written exactly as before");
}
{
  // A withdrawn consensus on the PREVIOUS row: the flip is still the news, but there is no
  // "from" to quote. Omit the key rather than send the string "null" to the writer.
  const hooks = detectHooks([
    [row({ t: "NOCON", con: null, up: 20 })],
    [row({ t: "NOCON", con: "StrongBuy", up: 20 })],
  ]).filter((h) => h.kind === "movement");
  assert.equal(hooks.length, 1, "a flip out of no-rating is still a movement hook");
  assert.equal("consensusFrom" in hooks[0].facts, false, "consensusFrom is omitted, not null");
  assert.equal(hooks[0].facts.consensusTo, "StrongBuy", "the side that exists is still reported");
}
{
  // ...and the mirror: a rating withdrawn between runs.
  const hooks = detectHooks([
    [row({ t: "LOSTCON", con: "Buy", up: 20 })],
    [row({ t: "LOSTCON", con: null, up: 20 })],
  ]).filter((h) => h.kind === "movement");
  assert.equal(hooks.length, 1, "a flip into no-rating is still a movement hook");
  assert.equal(hooks[0].facts.consensusFrom, "Buy", "the side that exists is still reported");
  assert.equal("consensusTo" in hooks[0].facts, false, "consensusTo is omitted, not null");
}
{
  // A withdrawn price target must not reach the prompt at all.
  const hooks = detectHooks([
    [row({ t: "NOPT", up: 20, pt: 120 })],
    [row({ t: "NOPT", up: 40, pt: null })],
  ]).filter((h) => h.kind === "movement");
  assert.equal(hooks.length, 1, "an upside jump fires even with no price target");
  assert.equal("priceTarget" in hooks[0].facts, false, "priceTarget is omitted when null");
  assert.equal(hooks[0].facts.upsideFrom, 20, "the upside pair is unaffected");
}
{
  // No movement fact may ever be null or undefined — that is the whole rule, stated once.
  const windows = [
    [[row({ t: "X", con: null, ss: null, pt: null, up: 20 })], [row({ t: "X", con: "Buy", ss: null, pt: null, up: 40 })]],
    [[row({ t: "X", con: "Buy", ss: 3, pt: 120, up: 20 })], [row({ t: "X", con: null, ss: null, pt: null, up: 40 })]],
  ];
  for (const w of windows) {
    for (const h of detectHooks(w).filter((x) => x.kind === "movement")) {
      for (const [k, v] of Object.entries(h.facts)) {
        assert.ok(v !== null && v !== undefined, `movement fact ${k} is never null`);
      }
    }
  }
}
{
  // The baseline itself must be an ELIGIBLE reading. A sub-$3 penny yesterday is not a
  // "from" anything can be quoted against, so no movement hook comes out of that pair.
  const hooks = detectHooks([
    [row({ t: "WASPENNY", px: 0.8, up: 10 })],
    [row({ t: "WASPENNY", px: 100, up: 40 })],
  ]).filter((h) => h.kind === "movement");
  assert.equal(hooks.length, 0, "an ineligible previous row is not a movement baseline");
}

// ============================ WINDOW RULES ====================================
// Everything below needs MIN_WINDOW snapshots. These are the rules that justify
// loading 30 of them, and none of them can be expressed with two.

// --- record: current upside is a window high ----------------------------------
{
  // climbs 60 -> 110 across the window, so the last reading is the highest in 30 runs
  const hooks = detectHooks(win(30, (i) => row({ t: "HIGH", up: 60 + i * 1.7 })));
  const rec = hooks.filter((h) => h.kind === "record");
  assert.equal(rec.length, 1, "a window high produces a record hook");
  assert.equal(rec[0].facts.windowLow, 60, "facts carry where it came from");
  assert.ok(rec[0].facts.upside > rec[0].facts.windowLow, "and where it is now");
  assert.equal(rec[0].facts.snapshots, 30, "facts state how long the window is");
}
{
  const flat = detectHooks(win(30, () => row({ t: "FLAT", up: 60 })));
  assert.equal(flat.filter((h) => h.kind === "record").length, 0, "a flat series is not a record");
}
{
  const fell = detectHooks(win(30, (i) => row({ t: "FELL", up: 110 - i * 1.7 })));
  assert.equal(fell.filter((h) => h.kind === "record").length, 0, "a falling series is not a record");
}

// --- trend: net Smart Score drift across the window ----------------------------
{
  const hooks = detectHooks(win(30, (i) => row({ t: "SLIDE", ss: i < 15 ? 8 : 3 })));
  const tr = hooks.filter((h) => h.kind === "trend");
  assert.equal(tr.length, 1, "a 5-point net slide is a trend hook");
  assert.equal(tr[0].facts.smartScoreFrom, 8, "facts carry the start of the window");
  assert.equal(tr[0].facts.smartScoreTo, 3, "facts carry the end");
  assert.equal(tr[0].facts.direction, "down", "facts name the direction");
}
assert.equal(
  detectHooks(win(30, (i) => row({ t: "WOBBLE", ss: i % 2 ? 7 : 8 }))).filter((h) => h.kind === "trend").length,
  0, "a one-point wobble is not a trend");

// --- steady: never left the top all window --------------------------------------
{
  const hooks = detectHooks(win(30, () => row({ t: "ROCK", ss: 10, up: 32 })));
  const st = hooks.filter((h) => h.kind === "steady");
  assert.equal(st.length, 1, "an unbroken top score is a steady hook");
  assert.equal(st[0].facts.smartScore, 10, "facts carry the score it held");
  assert.equal(st[0].facts.snapshots, 30, "facts carry how long it held");
}
assert.equal(
  detectHooks(win(30, (i) => row({ t: "DIP", ss: i === 12 ? 6 : 10 }))).filter((h) => h.kind === "steady").length,
  0, "one dip breaks the streak");

// --- churn: many distinct scores in the window -----------------------------------
{
  const hooks = detectHooks(win(30, (i) => row({ t: "JUMPY", ss: [2, 5, 7, 9][i % 4] })));
  const ch = hooks.filter((h) => h.kind === "churn");
  assert.equal(ch.length, 1, "four distinct scores is a churn hook");
  assert.equal(ch[0].facts.distinctScores, 4, "facts count the distinct values");
  assert.equal(ch[0].facts.low, 2, "facts carry the low");
  assert.equal(ch[0].facts.high, 9, "facts carry the high");
}

// --- newcomer: absent at the start of the window, here now -------------------------
{
  const history = win(30, (i) => row({ t: "OLD" }));
  for (let i = 20; i < 30; i++) history[i].push(row({ t: "FRESH", up: 70 }));
  const nc = detectHooks(history).filter((h) => h.kind === "newcomer");
  assert.equal(nc.length, 1, "a name that arrived mid-window is a newcomer hook");
  assert.equal(nc[0].ticker, "FRESH", "and it is the new one, not the incumbent");
  assert.equal(nc[0].facts.seenIn, 10, "facts say how many runs it has been present");
}
assert.equal(
  detectHooks(win(30, () => row({ t: "ALWAYS" }))).filter((h) => h.kind === "newcomer").length,
  0, "a name present all window is not a newcomer");

// --- a short window skips the window rules entirely ---------------------------------
{
  const short = detectHooks(win(MIN_WINDOW - 1, (i) => row({ t: "SHORT", up: 60 + i * 4, ss: 10 })));
  for (const k of ["record", "trend", "steady", "churn", "newcomer"]) {
    assert.equal(short.filter((h) => h.kind === k).length, 0,
      `${k} must not fire on a window shorter than MIN_WINDOW`);
  }
}

// --- kind damping (Task 0, Finding 2) --------------------------------------------
{
  const curr = [row({ t: "UP1", up: 190 }), row({ t: "UP2", up: 85 }),
                row({ t: "GAP", up: 30, ss: 9, ai: 45, air: "Bearish" })];
  const cold = detectHooks([curr], { recentKinds: [] });
  assert.equal(cold[0].kind, "surprise", "with an empty feed the strongest raw hook wins");
  const warm = detectHooks([curr], { recentKinds: ["surprise", "surprise"] });
  assert.notEqual(warm[0].kind, "surprise", "after two surprise posts a different kind leads");
  const s = (hs, k) => hs.find((h) => h.kind === k).score;
  assert.ok(s(warm, "surprise") < s(cold, "surprise"), "damping lowers the repeated kind");
  assert.equal(s(warm, "contrarian"), s(cold, "contrarian"), "an unused kind is not damped");
}

// --- movement outranks routine upside (Task 0, Finding 4) --------------------------
{
  const hooks = detectHooks([
    [row({ t: "MV", ss: 4, up: 20 }), row({ t: "STATIC", up: 100 })],
    [row({ t: "MV", ss: 9, up: 20 }), row({ t: "STATIC", up: 100 })],
  ]);
  assert.equal(hooks[0].kind, "movement", "a 5-point jump beats a static 100% upside");
}

// --- per-kind cap: no single kind may take the board ----------------------------------
{
  // 12 names that all hold a perfect score across the window: every one is a `steady` hook
  // and they score identically, so without a cap they fill all 12 slots.
  const many = Array.from({ length: 12 }, (_, k) =>
    win(30, () => row({ t: `S${k}`, ss: 10, up: 30 + k })));
  const merged = Array.from({ length: 30 }, (_, i) => many.flatMap((w) => w[i]));
  const capped = detectHooks(merged, { maxPerKind: 2 });
  const steadies = capped.filter((h) => h.kind === "steady");
  assert.equal(steadies.length, 2, "at most maxPerKind hooks of one kind reach the board");
  assert.ok(new Set(capped.map((h) => h.kind)).size >= 2, "so other kinds still get a slot");
  const loose = detectHooks(merged, { maxPerKind: 99 });
  assert.ok(loose.filter((h) => h.kind === "steady").length > 2, "a high cap lets them through");
}

// --- contract: sorted, capped, flat facts -------------------------------------------
{
  const curr = Array.from({ length: 40 }, (_, i) => row({ t: `T${i}`, up: 20 + i }));
  // maxPerKind is lifted here so this case tests `limit` alone — these 40 rows are all the
  // same kind, so the default cap of 2 would bound the result before `limit` ever applied.
  const hooks = detectHooks([curr], { limit: 5, maxPerKind: 99 });
  assert.equal(hooks.length, 5, "limit is respected");
  assert.ok(detectHooks([curr], { limit: 5 }).length <= 5, "the cap never exceeds the limit");
  for (let i = 1; i < hooks.length; i++) {
    assert.ok(hooks[i - 1].score >= hooks[i].score, "hooks come back sorted by score");
  }
  for (const h of hooks) {
    assert.ok(Number.isFinite(h.score) && h.score >= 0, "every score is a non-negative number");
    for (const v of Object.values(h.facts)) {
      assert.ok(["string", "number", "boolean"].includes(typeof v), "facts are flat primitives");
    }
  }
}

// --- determinism and input safety ------------------------------------------------------
{
  const h = win(30, (i) => row({ t: "D1", up: 60 + i }));
  assert.deepEqual(detectHooks(h), detectHooks(h), "same window, same output");
}
assert.deepEqual(detectHooks([]), [], "an empty history yields no hooks, not a crash");
assert.deepEqual(detectHooks([[]]), [], "an empty snapshot yields no hooks");

console.log("hooks OK — 4 floors, 9 rule families, window rules gated, damping, sorting, determinism");
