// Checks ci/hooks.mjs — the deterministic rule layer that picks what a post is ABOUT.
// No LLM and no network: given the same window this must always produce the same ranked
// hooks, which is what makes the generator reproducible and a bad post debuggable.

import assert from "node:assert";
import {
  detectHooks, deTickerHooks, shortCompanyName, displayCompanyName,
  eligible, coverage, SANE_MAX_UPSIDE, MIN_WINDOW,
} from "./hooks.mjs";

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
  assert.ok(hooks.length >= 1, "an upside jump plus a consensus flip is a movement hook");
  assert.equal(hooks[0].facts.smartScoreFrom, 4, "a Smart Score change that DID happen still rides along in facts");
  assert.equal(hooks[0].facts.smartScoreTo, 9, "facts carry the new Smart Score");
}

// --- a Smart Score change ALONE is no longer a movement hook (the user's explicit call) -------
// "A change in smart score is not something that's good enough for a post." Only a real
// upside change or a consensus flip may trigger this hook now.
{
  const hooks = detectHooks([
    [row({ t: "SSONLY", ss: 4, con: "Hold", up: 20 })],
    [row({ t: "SSONLY", ss: 9, con: "Hold", up: 22 })],
  ]).filter((h) => h.kind === "movement");
  assert.equal(hooks.length, 0,
    "a 5-point Smart Score jump alone, with no real upside move or consensus flip, is not a movement hook");
}
{
  // The mirror case: Smart Score UNCHANGED between the two readings. The hook still fires (a
  // real upside jump), but there is no Smart Score story here, so the facts omit it rather
  // than restate "smartScoreFrom: 8, smartScoreTo: 8" as if something happened.
  const hooks = detectHooks([
    [row({ t: "SAMESS", ss: 8, up: 20 })],
    [row({ t: "SAMESS", ss: 8, up: 40 })],
  ]).filter((h) => h.kind === "movement");
  assert.ok(hooks.length >= 1, "the upside jump still fires a movement hook");
  assert.equal("smartScoreFrom" in hooks[0].facts, false, "an unchanged Smart Score is omitted, not restated");
  assert.equal("smartScoreTo" in hooks[0].facts, false, "an unchanged Smart Score is omitted, not restated");
}
{
  // A consensus flip alone (no real upside move, Smart Score unchanged) still fires — the
  // task is explicit that consensus flips are still a good story.
  const hooks = detectHooks([
    [row({ t: "FLIPONLY", ss: 6, con: "Hold", up: 20 })],
    [row({ t: "FLIPONLY", ss: 6, con: "StrongBuy", up: 21 })],
  ]).filter((h) => h.kind === "movement");
  assert.ok(hooks.length >= 1, "a consensus flip alone is still a movement hook");
  assert.equal(hooks[0].facts.consensusFrom, "Hold", "facts carry the flip");
  assert.equal(hooks[0].facts.consensusTo, "StrongBuy", "facts carry the flip");
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

// --- trend and churn are DELETED, not just untested — a Smart Score change alone is not a
// post (the user's explicit call), and neither kind had any other story to tell. This is a
// removed FEATURE, so it gets a removal test, not merely an absence of one: even a window
// shaped exactly like the old `trend`/`churn` fixtures must never again emit either kind.
{
  const slide = detectHooks(win(30, (i) => row({ t: "SLIDE", ss: i < 15 ? 8 : 3 })));
  assert.equal(slide.filter((h) => h.kind === "trend").length, 0,
    "a 5-point net Smart Score slide across the window no longer produces a trend hook — the kind is gone");
  const jumpy = detectHooks(win(30, (i) => row({ t: "JUMPY", ss: [2, 5, 7, 9][i % 4] })));
  assert.equal(jumpy.filter((h) => h.kind === "churn").length, 0,
    "four distinct Smart Scores across the window no longer produces a churn hook — the kind is gone");
  // Nothing in this file, or in ci/generate-posts.mjs's KIND_BRIEF, should ever emit either
  // kind name again, from any input.
  for (const h of [...slide, ...jumpy]) {
    assert.notEqual(h.kind, "trend", "no hook of any kind is ever labelled trend");
    assert.notEqual(h.kind, "churn", "no hook of any kind is ever labelled churn");
  }
}

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
  for (const k of ["record", "steady", "newcomer"]) {
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
// The original version of this fixture drove the movement magnitude with a Smart Score jump
// alone — no longer possible now that a Smart Score change alone cannot even fire the hook
// (see the "Smart Score change ALONE" test above). A real upside swing makes the same point:
// the per-point coefficient on movement's own delta is still heavy enough to outrank a
// routine static high-upside name.
{
  const hooks = detectHooks([
    [row({ t: "MV", up: 20 }), row({ t: "STATIC", up: 100 })],
    [row({ t: "MV", up: 65 }), row({ t: "STATIC", up: 100 })],
  ]);
  assert.equal(hooks[0].kind, "movement", "a real 45-point upside swing beats a static 100% upside");
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

// ======================== DE-TICKERING (the published bug) ========================
// "IRD soared 151.7% to $13.14." shipped once: the `list` hook's own facts handed the model
// a ticker to quote back (`members: "IRD (151.7% to $13.14), …"`, `leader: "IRD"`). This is
// the separate normalisation pass that runs after detectHooks and fixes THAT, root-cause.

const snapRows = [
  { t: "IRD", n: "Opus Genetics, Inc." },
  { t: "FRVO", n: "Fervo Energy Inc." },
  { t: "PRAX", n: "Praxis Precision Medicines, Inc." },
  { t: "VERA", n: "Vera Therapeutics, Inc." },
  { t: "TNGX", n: "Tango Therapeutics, Inc." },
];

// --- shortCompanyName: strips legal-entity suffixes, keeps everything else -----------------
assert.equal(shortCompanyName("Opus Genetics, Inc."), "Opus Genetics", "', Inc.' strips");
assert.equal(shortCompanyName("Fervo Energy Inc."), "Fervo Energy", "' Inc.' (no comma) strips");
assert.equal(shortCompanyName("Kymera Therapeutics, Inc."), "Kymera Therapeutics", "another real shape");
assert.equal(shortCompanyName("Ird Holdings"), "Ird Holdings", "'Holdings' is brand identity, not stripped");
assert.equal(shortCompanyName("Xpo, Inc."), "Xpo", "matches post-score.mjs's own nameStem fixture");
assert.equal(shortCompanyName(""), "", "empty in, empty out");
assert.equal(shortCompanyName(undefined), "", "missing in, empty out");

// --- the exact published bug: `list` facts (members + leader) lose their tickers ----------
{
  const listHook = {
    kind: "list", ticker: "IRD", name: "Opus Genetics, Inc.", sec: "Healthcare", score: 62,
    facts: {
      members: "IRD (151.7% to $13.14), FRVO (149% to $41.91), PRAX (145.1% to $732.38), " +
               "VERA (129.6% to $78.63), TNGX (115% to $48)",
      count: 5, leader: "IRD", leaderUpside: 151.7,
    },
  };
  const [out] = deTickerHooks([listHook], snapRows);
  assert.equal(out.facts.members.includes("IRD"), false, "IRD no longer appears in members");
  assert.equal(out.facts.members.includes("FRVO"), false, "nor FRVO");
  assert.equal(out.facts.members.includes("PRAX"), false, "nor PRAX");
  assert.equal(out.facts.members.includes("VERA"), false, "nor VERA");
  assert.equal(out.facts.members.includes("TNGX"), false, "nor TNGX");
  assert.equal(out.facts.members, "Opus Genetics (151.7% to $13.14), Fervo Energy (149% to $41.91), " +
    "Praxis Precision Medicines (145.1% to $732.38), Vera Therapeutics (129.6% to $78.63), " +
    "Tango Therapeutics (115% to $48)", "company names substitute in cleanly, suffixes stripped");
  assert.equal(out.facts.leader, "Opus Genetics", "leader is a company name, not a ticker");
  assert.equal(out.facts.leaderUpside, 151.7, "non-string, non-ticker facts pass through unchanged");
  assert.equal(out.facts.count, 5, "and count, a plain number, is untouched");
  // Only `facts` is normalised — the hook's own identity fields are never touched.
  assert.equal(out.ticker, "IRD", "hook.ticker itself is left alone (it is not a `facts` string)");
  assert.equal(out.name, "Opus Genetics, Inc.", "hook.name itself is left alone too");
}

// --- a hook with no ticker-bearing facts is untouched (deep-equal, not just "still valid") --
{
  const surprise = { kind: "surprise", ticker: "NVDA", name: "Nvidia Corp", sec: "Technology",
                      score: 90, facts: { upside: 42, price: 148, priceTarget: 210,
                                          consensus: "StrongBuy", analysts: 38, sector: "Technology" } };
  const [out] = deTickerHooks([surprise], snapRows);
  assert.deepEqual(out.facts, surprise.facts, "facts with no ticker tokens are byte-identical");
}

// --- generic: ANY string fact carrying a known ticker is caught, not just members/leader ---
{
  const future = { kind: "madeUpKind", ticker: "PRAX", name: "Praxis Precision Medicines, Inc.",
                    facts: { note: "Compare against IRD and PRAX this week.", plain: 12 } };
  const [out] = deTickerHooks([future], snapRows);
  assert.equal(out.facts.note.includes("IRD"), false, "a brand-new fact key is still de-tickered");
  assert.equal(out.facts.note, "Compare against Opus Genetics and Praxis Precision Medicines this week.",
    "both tickers in the same string are replaced");
  assert.equal(out.facts.plain, 12, "a numeric fact is never touched");
}

// --- word boundaries hold: a ticker that is a substring of an ordinary word must not fire ---
{
  const rows = [...snapRows, { t: "GM", n: "General Motors" }];
  const hook = { kind: "surprise", ticker: "GM", name: "General Motors",
                 facts: { note: "Reported at 9am GMT, ahead of GM's own call." } };
  const [out] = deTickerHooks([hook], rows);
  assert.equal(out.facts.note, "Reported at 9am GMT, ahead of General Motors's own call.",
    "GMT is untouched (no word boundary), the standalone GM is replaced");
}

// --- no rows, or rows with no usable ticker/name pairs: hooks pass through unchanged --------
{
  const surprise = { kind: "surprise", ticker: "NVDA", facts: { upside: 42 } };
  assert.deepEqual(deTickerHooks([surprise], []), [surprise], "no rows means nothing to map against");
  assert.deepEqual(deTickerHooks([surprise], undefined), [surprise], "undefined rows is handled, not a crash");
  assert.deepEqual(deTickerHooks([surprise], [{ t: "X" }, { n: "Y" }]), [surprise],
    "a row missing either t or n is not usable as a mapping and is skipped");
}
assert.deepEqual(deTickerHooks([], snapRows), [], "an empty hook list yields an empty list");
assert.deepEqual(deTickerHooks(undefined, snapRows), [], "a non-array hooks argument does not crash");

// ============================ DISPLAY NAME ====================================
// The published bug: a composed card read "Applied Materials, Inc." and, on another run,
// "Alphabet Inc. Class A" — full legal-entity plumbing nobody wants on a headline.
// displayCompanyName() is a SEPARATE, more aggressive stripper than shortCompanyName() above
// (which deliberately keeps "Holdings"/"Group" for the de-tickering job) — this one is for the
// one line a human actually sees. Real messy names below are pulled straight from
// src/data/stocks.json.

// --- real data, from src/data/stocks.json --------------------------------------------------
assert.equal(displayCompanyName("Applied Materials, Inc."), "Applied Materials", "the exact live bug");
assert.equal(displayCompanyName("Alphabet Inc. Class A"), "Alphabet", "the other exact live bug");
assert.equal(displayCompanyName("Rani Therapeutics Holdings, Inc. Class A"), "Rani Therapeutics",
  "a three-deep chain (Class A, then Inc., then Holdings) fully resolves");
assert.equal(displayCompanyName("Bridger Aerospace Group Holdings, Inc."), "Bridger Aerospace",
  "another three-deep chain (Inc., then Holdings, then Group)");
assert.equal(displayCompanyName("Credo Technology Group Holding Ltd."), "Credo Technology",
  "singular 'Holding' strips the same as plural 'Holdings'");
assert.equal(displayCompanyName("Chime Financial, Inc. Class A"), "Chime Financial", "Class A after a comma+Inc.");
assert.equal(displayCompanyName("Atlassian Corporation Plc"), "Atlassian", "Plc then Corporation");
assert.equal(displayCompanyName("Eli Lilly And Company"), "Eli Lilly",
  "'And Company' strips as one unit — must not leave a dangling 'And'");
assert.equal(displayCompanyName("Arthur J Gallagher & Co"), "Arthur J Gallagher", "'& Co' strips as one unit");
assert.equal(displayCompanyName("Zeta Global Holdings Corp"), "Zeta Global", "Corp then Holdings");
assert.equal(displayCompanyName("SLB N.V."), "SLB", "a short core name survives a dotted foreign suffix");
assert.equal(displayCompanyName("On Holding Ag Class A"), "On", "Class A, then Ag, then Holding — three passes");

// --- the task's own explicit guard-rail cases (safety, not real dataset rows) ---------------
assert.equal(displayCompanyName("Berkshire Hathaway Inc. Class B"), "Berkshire Hathaway",
  "Class B then Inc. — the task's own worked example");
assert.equal(displayCompanyName("Group 1 Automotive"), "Group 1 Automotive",
  "a LEADING 'Group' is never touched — only a trailing suffix strips");
assert.equal(displayCompanyName("3M Co."), "3M", "stripping 'Co.' must not be allowed to leave nothing");

// --- never returns an empty string, even from adversarial input ----------------------------
assert.equal(displayCompanyName(""), "", "empty in, empty out (nothing to fall back to)");
assert.equal(displayCompanyName(undefined), "", "missing in, empty out");
assert.equal(displayCompanyName("Inc."), "Inc.", "a bare suffix with nothing in front of it is left alone");
assert.equal(displayCompanyName("Class A"), "Class A", "same for a bare share-class label");

console.log("hooks OK — 4 floors, 7 rule families, window rules gated, damping, sorting, determinism, " +
            "de-tickering, display-name stripping");
