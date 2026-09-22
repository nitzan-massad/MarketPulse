# Social Post Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every 5h CI run, generate N candidate social posts from the fresh TipRanks snapshot, score them deterministically, and commit the single best one to `src/data/posts.json` for an in-app feed.

**Architecture:** Three pure modules plus one orchestrator, matching the existing `ci/*.mjs` pattern. `ci/hooks.mjs` diffs the previous snapshot against the current one with deterministic rules (no LLM) and emits scored, structured facts. `ci/post-score.mjs` ranks generated candidate texts against a banned-phrase list, a numeric-content requirement, and a dedupe window over recent posts. `ci/provider.mjs` is a thin `generate()` shim over Cloudflare Workers AI (free tier), switchable by env var. `ci/generate-posts.mjs` wires them together and writes the rolling feed file. The step runs `continue-on-error` in `site.yml`, like every other scrape — a bad generation must never block the data deploy.

**Tech Stack:** Node 24 ESM (`.mjs`), zero new npm dependencies, `node:assert` checks auto-discovered by `ci/run-tests.mjs`, Cloudflare Workers AI REST API via built-in `fetch`.

**Spec:** This document (the design was settled in conversation; no separate spec file).

## Global Constraints

- **No new npm dependencies.** The repo has 2 runtime deps and 5 devDeps. Everything here uses Node builtins and `fetch`.
- **Node >= 22.18**, workflows pin Node 24. Match `.github/workflows/site.yml` and `tests.yml`.
- **Every check is `ci/test-*.mjs`**, uses `node:assert`, prints a line containing `ok`/`OK`/`pass`, and exits non-zero on failure. `ci/run-tests.mjs` discovers by pattern — never edit a list.
- **A check that exits 0 with no output, or whose source contains no assertion, is reported FAIL.** Always print a summary line.
- **No network access in tests.** The provider must be injectable so tests use a stub.
- **The generation step is `continue-on-error: true`** in the workflow. It is a scrape-class step, not a gate.
- **Eligibility floors are mandatory.** `src/data/stocks.json` contains rows like `{"t":"ENLV","px":0.806,"mc":13,"up":9825.6}`. Floors: `mc >= 300` (millions), `px >= 3`, `up <= 200`, and `b+h+s >= 4` analysts. All four were validated against the live snapshot in Task 0 — see the findings there for why the analyst floor is not optional.
- **Config via env with in-file defaults**, so cadence changes are a one-line workflow edit: `POSTS_PER_RUN` (default `1`), `POST_CANDIDATES` (default `5`), `POST_PROVIDER` (default `cloudflare`), `POSTS_KEEP` (default `200`), `POST_WINDOW` (default `30`), `POSTS_ENABLED` (default `true`).
- Row field names, verbatim from `src/data/stocks.json`: `t` ticker, `n` name, `sec` sector, `px` price, `chg` day change %, `pt` price target, `up` upside %, `con` consensus (`Buy`/`StrongBuy`/`Hold`/`Sell`), `b`/`h`/`s` analyst counts, `ss` Smart Score 1–10 (nullable), `ai` AI score 0–100, `air` AI rating, `aipt` AI price target, `mc` market cap in millions, `desc` description.

---

## Task 0: Spike — ALREADY DONE (2026-09-20)

The algorithm below was run against the live snapshot and the real previous snapshot before any of it was written into the repo. Scripts are throwaway, in the session scratchpad (`spike/hooks-spike.mjs`, `spike/movement-spike.mjs`, `spike/full-spike.mjs`, `spike/score-spike.mjs`). **Nothing was committed.** The four findings below are already folded into Tasks 1–4; they are recorded here so the implementer knows which constants are load-bearing and why.

### What the spike proved

| Question | Answer |
|---|---|
| Do the rules find anything in real data? | Yes — 12 hooks from 454 rows. |
| Do the floors kill the junk? | Yes — 454 → 238 eligible. `ENLV` ($0.81, $13M, 9825% upside) filtered. |
| Does movement detection work at a 5h cadence? | Yes — 11 movements per run (9 Smart Score, 2 upside). |
| Does the scorer separate good copy from slop? | Yes, decisively — slop **-93**, good copy **86**. |
| Is the feed varied across runs? | Only after Finding 2 below was added. |

### Finding 1 — `HEAD~1` is the wrong previous snapshot

The first spike run produced **zero** movement hooks. Cause: `HEAD` was a feature commit (`deb2abf4 feat(modal): swipe between stocks`) and `HEAD~1` was the newest *data* commit — so "previous" was byte-identical to current.

`git show HEAD:src/data/stocks.json` is correct **in CI**, because the refresh step has already overwritten the working copy while `HEAD` still holds the last committed data. It is **wrong when run locally** after a refresh has been committed. `previousStocks()` in Task 4 keeps the `HEAD:` form with a comment saying so. Local runs must use `POST_PROVIDER=stub` and accept that movement hooks will be empty.

Measured once the comparison was fixed (newest two data commits, 5h apart):

```
lookback     ΔSmartScore>=2   Δupside>=15pt   consensus flip   TOTAL
  5h back                 9               2                0      11
 11h back                10               4                0      14
 24h back                10               4                0      14
 35h back                19              16                0      35
```

5h is enough. Consensus flips are genuinely rare (0 across 35h) — that rule will fire occasionally, not every run, which is correct.

### Finding 2 — kind damping is required or the feed repeats itself

Hooks from the live snapshot broke down as **10 surprise, 1 contrarian, 1 list**. With `POSTS_PER_RUN=1` the top hook ships, and the top hook was the same shape every run — a feed of nothing but "big upside number" posts.

`recentKinds` damping (`1 / (1 + timesUsedRecently)`) fixes it. Verified across three simulated consecutive runs:

```
run 1 — empty feed            ->  TOP: [139.7] LIST IRD
run 2 — after a list post     ->  TOP: [120.1] SURPRISE PRAX
run 3 — after list+surprise   ->  TOP: [ 94.5] CONTRARIAN XPO
```

### Finding 3 — the analyst floor

`AGEN` surfaced as a top hook: **148.4% upside on two analysts**. The `mc`/`px` floors passed it because it is a $900M company at $7.85 — thin coverage, not a small company. `minAnalysts: 4` removes it. Net effect is small (241 → 238 eligible) but it removes the worst offender, which is the entire point.

### Finding 4 — movement hooks never reach the top

Despite 11 real movements, no movement hook made the top 12. The old coefficients (`|ΔSS|*15 + |Δupside| + flip*30`) lose to surprise's `(up/200)*100`: a 2-point Smart Score jump scores ~54 against ~90 for a routine 100%-upside name. Movement is the newsiest hook type and was being drowned by static upside. Coefficients raised to `|ΔSS|*25 + |Δupside|*1.5 + flip*40` in Task 1.

### The first post — generated and scored end-to-end

Real hook, five candidates written in the target voice, run through the real scorer:

```
CONTRARIAN — XPO (Xpo, Inc.)   [Smart Score 1, AI 65, StrongBuy, 38.6% upside, $174.25]

 [ 86]  XPO: Smart Score 1 out of 10. AI model says 65 out of 100. Analyst
        consensus is Strong Buy. Three models, three answers, $174 stock.
        11 digits | names XPO | length ok (132)

 [ 80]  The quant model rates XPO a 1. The AI rates it 65. The analysts say
        Strong Buy with 38% upside. Somebody here is very wrong.

 [ 72]  XPO has a Smart Score of 1 and a Strong Buy consensus at the same time.
        That combination shows up on maybe one name in four hundred.

 [ 40]  Big divergence on XPO right now, worth watching closely as the models
        sort themselves out over the coming weeks ahead.
        no numbers | names XPO | length ok (118)

 [-35]  It's important to note that XPO presents a compelling opportunity when it
        comes to freight. Furthermore, analysts remain bullish.
        banned: "it's important to note" | banned: "when it comes to" | banned:
        "furthermore" | no numbers | names XPO
```

The `LIST` board behaved the same way — three solid candidates at 86, a contentless one at 5, and pure slop at **-93** (five banned phrases, no numbers, four hashtags, rocket emoji).

**Known limitation, accepted:** the scorer reliably separates *bad* from *fine*, not *fine* from *great*. Three candidates tied at 86 on the list board (the digit bonus caps at +16 and saturates), broken alphabetically. Arguably the 80-scoring XPO candidate is the punchier post. This is the designed ceiling of a deterministic judge — the upgrade path is a better style corpus, not a cleverer scoring function.

### Still unproven — needs your Cloudflare account

The spike used no network. Before the first live run, confirm the free tier answers:

```bash
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/run/@cf/meta/llama-3.1-8b-instruct" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: ok"}],"max_tokens":10}'
```

Expected: `{"result":{"response":"ok"},"success":true,...}`. A `10000` error code means the token lacks **Workers AI → Read**.

---

### Task 1: Hook detector

**Files:**
- Create: `ci/hooks.mjs`
- Test: `ci/test-hooks.mjs`

Reads a **window of the last 30 snapshots**, not just the previous one. Measured in Task 0:
30 snapshots load in 0.68s, 18.6MB, and cover 5.8 days with 445 of 454 tickers carrying a full
series. That window is what makes the interesting rules possible — a six-day high, a Smart
Score sliding all week, a name that has held a perfect 10 since Monday. Two-snapshot rules can
only ever say "this moved a bit since 5h ago".

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `detectHooks(history, opts) -> Hook[]`, sorted by `score` descending.
  - `history`: an array of snapshots, **oldest first**, each an array of stock rows. The last
    element is the current snapshot. May be length 1 (then only the point-in-time rules fire).
  - `opts`: `{ minMc = 300, minPx = 3, minAnalysts = 4, limit = 12, maxPerKind = 2, recentKinds = [] }`.
    `maxPerKind` caps how many hooks of one kind reach the board — without it a single kind
    takes every slot (see the comment in the implementation).
  - `Hook`: `{ kind, ticker, name, sec, score, facts }`. `kind` is one of
    `"surprise" | "contrarian" | "list" | "movement" | "record" | "trend" | "steady" | "churn" | "newcomer"`.
    `facts` is a flat object of primitives the writer prompt renders verbatim.
  - Also exports `eligible(row, opts)`, `coverage(row)`, `SANE_MAX_UPSIDE` (`200`) and
    `MIN_WINDOW` (`10` — below this many snapshots the window rules are skipped rather than
    firing on a thin series).

- [ ] **Step 1: Write the failing test**

Create `ci/test-hooks.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ci/test-hooks.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` — `Cannot find module '.../ci/hooks.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `ci/hooks.mjs`:

```js
// WHAT A POST IS ABOUT — chosen by rules over a 30-snapshot window, never by an LLM.
//
// Ask a model "what's interesting here" and it picks the same safe thing every run.
// Deterministic rules give variety AND reproducibility: the same window always yields the
// same ranked hooks, so a bad post can be traced to a rule instead of a temperature.
//
// The window is the whole point. Two snapshots can only say "this moved since 5h ago".
// Thirty say "a six-day high", "sliding all week", "hasn't left a 10 since Monday" — the
// things people actually repost. Task 0 measured the cost: 0.68s and 18.6MB.
//
// Every constant here was calibrated against the live data. Read Task 0's findings before
// changing one; three of them exist because the naive version produced a visibly bad feed.

/** Upside above this is a data artifact, not a call. */
export const SANE_MAX_UPSIDE = 200;

/** Below this many snapshots, the window rules stay silent rather than firing on a thin
 *  series — a "30-run high" off four readings is not a fact worth posting. */
export const MIN_WINDOW = 10;

const DEFAULTS = { minMc: 300, minPx: 3, minAnalysts: 4, limit: 12, maxPerKind: 2, recentKinds: [] };

/** Analysts covering the name. TipRanks splits the count across three fields. */
export const coverage = (r) => (r?.b ?? 0) + (r?.h ?? 0) + (r?.s ?? 0);

export function eligible(row, opts = {}) {
  const { minMc, minPx, minAnalysts } = { ...DEFAULTS, ...opts };
  return (
    Number.isFinite(row?.mc) && row.mc >= minMc &&
    Number.isFinite(row?.px) && row.px >= minPx &&
    Number.isFinite(row?.up) && row.up > 0 && row.up <= SANE_MAX_UPSIDE &&
    // Task 0, Finding 3: AGEN cleared cap and price but carried 148% upside on two
    // analysts. A "target" two people agree on is not a consensus worth posting.
    coverage(row) >= minAnalysts
  );
}

const round = (n) => Math.round(n * 10) / 10;
const base = (r, kind, score, facts) => ({
  kind, ticker: r.t, name: r.n, sec: r.sec, score: round(score), facts,
});

/** Bigger companies are more recognisable, so the same move is more postable. Log so a
 *  mega-cap does not simply always win. */
const prominence = (r) => Math.log10(Math.max(r.mc, 1)) / 6;

const isNum = (v) => Number.isFinite(v);

/**
 * @param history snapshots OLDEST FIRST; the last element is the current one.
 */
export function detectHooks(history, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const snaps = Array.isArray(history) ? history.filter(Array.isArray) : [];
  if (!snaps.length) return [];

  const curr = snaps[snaps.length - 1];
  const rows = curr.filter((r) => eligible(r, o));
  if (!rows.length) return [];

  const prevSnap = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const before = new Map((prevSnap ?? []).map((r) => [r.t, r]));

  // Per-ticker series across the window, eligible readings only, oldest first.
  const series = new Map();
  if (snaps.length >= MIN_WINDOW) {
    snaps.forEach((snap, i) => {
      for (const r of snap) {
        if (!eligible(r, o)) continue;
        if (!series.has(r.t)) series.set(r.t, []);
        series.get(r.t).push({ i, up: r.up, ss: r.ss, con: r.con });
      }
    });
  }
  const windowOpen = snaps.length >= MIN_WINDOW;
  /** A name counts as present from the start if it appears in the first fifth of the window. */
  const earlyCut = Math.max(1, Math.floor(snaps.length / 5));

  // Task 0, Finding 2: live data skews heavily to one kind, so the top hook was the same
  // SHAPE every run. Damping by how recently a kind was used rotates the feed.
  const damp = (k) => 1 / (1 + o.recentKinds.filter((x) => x === k).length);

  const hooks = [];

  for (const r of rows) {
    const prom = 1 + prominence(r);

    // 1. SURPRISE — the number itself is the story.
    if (r.up >= 40) {
      hooks.push(base(r, "surprise", (r.up / SANE_MAX_UPSIDE) * 100 * prom * damp("surprise"), {
        upside: round(r.up), price: r.px, priceTarget: r.pt,
        consensus: r.con, analysts: coverage(r), sector: r.sec,
      }));
    }

    // 2. CONTRARIAN — the two models point opposite ways. ss is 1-10 and ai is 0-100, so
    //    compare on a common 0-100 scale.
    if (isNum(r.ss) && isNum(r.ai)) {
      const gap = r.ss * 10 - r.ai;
      if (Math.abs(gap) >= 40) {
        hooks.push(base(r, "contrarian", Math.abs(gap) * prom * damp("contrarian"), {
          smartScore: r.ss, aiScore: r.ai, aiRating: r.air,
          consensus: r.con, upside: round(r.up), price: r.px, analysts: coverage(r),
          bullish: gap > 0 ? "quant" : "ai",
        }));
      }
    }

    // 3. MOVEMENT — what changed since the last run. Coefficients are deliberately heavy
    //    (Task 0, Finding 4): with the naive weights all 11 real movements in the live
    //    snapshot lost to static high-upside names and none reached the top 12.
    const p = before.get(r.t);
    if (p) {
      const dSs = isNum(r.ss) && isNum(p.ss) ? r.ss - p.ss : 0;
      const dUp = isNum(p.up) ? r.up - p.up : 0;
      const flipped = p.con !== r.con;
      if (Math.abs(dSs) >= 2 || Math.abs(dUp) >= 15 || flipped) {
        const mag = Math.abs(dSs) * 25 + Math.abs(dUp) * 1.5 + (flipped ? 40 : 0);
        hooks.push(base(r, "movement", mag * prom * damp("movement"), {
          smartScoreFrom: p.ss ?? 0, smartScoreTo: r.ss ?? 0,
          upsideFrom: round(p.up ?? 0), upsideTo: round(r.up),
          consensusFrom: p.con, consensusTo: r.con,
          price: r.px, priceTarget: r.pt, analysts: coverage(r), sector: r.sec,
        }));
      }
    }

    // ------------------------------- window rules -------------------------------
    const hist = windowOpen ? series.get(r.t) : null;
    if (!hist || hist.length < MIN_WINDOW) continue;

    const ups = hist.map((x) => x.up).filter(isNum);
    const sss = hist.map((x) => x.ss).filter(isNum);

    // 4. RECORD — today's upside is the highest in the window, by a margin that matters.
    if (ups.length >= MIN_WINDOW) {
      const low = Math.min(...ups), high = Math.max(...ups);
      if (r.up >= high - 0.01 && r.up - low >= 20) {
        hooks.push(base(r, "record", (r.up - low) * 1.4 * prom * damp("record"), {
          upside: round(r.up), windowLow: round(low), windowHigh: round(high),
          snapshots: hist.length, days: round((hist.length * 5) / 24),
          price: r.px, priceTarget: r.pt, analysts: coverage(r),
        }));
      }
    }

    // 5. TREND — net Smart Score drift from one end of the window to the other.
    if (sss.length >= MIN_WINDOW) {
      const from = sss[0], to = sss[sss.length - 1], d = to - from;
      if (Math.abs(d) >= 3) {
        hooks.push(base(r, "trend", Math.abs(d) * 22 * prom * damp("trend"), {
          smartScoreFrom: from, smartScoreTo: to, direction: d > 0 ? "up" : "down",
          snapshots: hist.length, days: round((hist.length * 5) / 24),
          upside: round(r.up), consensus: r.con, analysts: coverage(r),
        }));
      }

      // 6. STEADY — never left the top of the scale across the whole window.
      if (sss.length === hist.length && sss.every((v) => v >= 9)) {
        hooks.push(base(r, "steady", 60 * prom * damp("steady"), {
          smartScore: to, snapshots: hist.length, days: round((hist.length * 5) / 24),
          upside: round(r.up), consensus: r.con, analysts: coverage(r),
        }));
      }

      // 7. CHURN — the quant model cannot make up its mind about this name.
      const distinct = new Set(sss);
      if (distinct.size >= 4) {
        hooks.push(base(r, "churn", distinct.size * 9 * prom * damp("churn"), {
          distinctScores: distinct.size, low: Math.min(...sss), high: Math.max(...sss),
          smartScore: to, snapshots: hist.length, days: round((hist.length * 5) / 24),
          analysts: coverage(r),
        }));
      }
    }

    // 8. NEWCOMER — absent when the window opened, here now.
    const firstSeen = hist[0].i;
    if (firstSeen >= earlyCut) {
      hooks.push(base(r, "newcomer", 55 * prom * damp("newcomer"), {
        seenIn: hist.length, windowSnapshots: snaps.length,
        days: round(((snaps.length - firstSeen) * 5) / 24),
        upside: round(r.up), smartScore: r.ss ?? 0, consensus: r.con, analysts: coverage(r),
      }));
    }
  }

  // 9. LIST — one per run, built from the strongest upsides. A carousel, not a single name.
  const top = rows.filter((r) => r.up >= 30).sort((a, b) => b.up - a.up).slice(0, 5);
  if (top.length >= 3) {
    hooks.push({
      kind: "list", ticker: top[0].t, name: top[0].n, sec: top[0].sec,
      score: round((top.reduce((s, r) => s + r.up, 0) / top.length) * damp("list")),
      facts: {
        members: top.map((r) => `${r.t} (${round(r.up)}% to $${r.pt})`).join(", "),
        count: top.length, leader: top[0].t, leaderUpside: round(top[0].up),
      },
    });
  }

  // PER-KIND CAP. Measured against the live 30-snapshot window: without it one kind takes
  // the whole board — churn took 5 of 12 slots at the first coefficients, and re-tuning only
  // moved the flood to `steady` (10 of 12). `steady` scores FLAT, so every mega-cap holding a
  // 10 scores the same and they arrive as a block; no coefficient can fix that, only a cap.
  // With maxPerKind = 2 the same window yields 7 distinct kinds across 12 slots.
  const ranked = hooks.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  const used = new Map();
  const out = [];
  for (const h of ranked) {
    const n = used.get(h.kind) ?? 0;
    if (n >= o.maxPerKind) continue;
    used.set(h.kind, n + 1);
    out.push(h);
    if (out.length >= o.limit) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ci/test-hooks.mjs`
Expected: PASS, printing
`hooks OK — 4 floors, 9 rule families, window rules gated, damping, sorting, determinism`

Then run it against the real 30-snapshot window and read the output — this is the check that
the rules are producing postable material, which no unit test can assert:

```bash
node --input-type=module -e '
import { execFileSync } from "node:child_process";
import { detectHooks } from "./ci/hooks.mjs";
const sh = (a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64e6 });
const hs = sh(["log","--format=%h","--","src/data/stocks.json"]).trim().split("\n").slice(0, 30);
const history = hs.map((h) => JSON.parse(sh(["show", h + ":src/data/stocks.json"]))).reverse();
console.log(`window: ${history.length} snapshots`);
for (const h of detectHooks(history)) {
  console.log(`[${String(h.score).padStart(6)}] ${h.kind.padEnd(10)} ${h.ticker.padEnd(6)} ${h.name}`);
}'
```

Expected: a dozen hooks spanning **several** kinds, not twelve of one. `record`, `trend`,
`steady` and `churn` should all appear — if they do not, the window rules are not firing and
the 30-snapshot load is buying nothing.

- [ ] **Step 5: Commit**

```bash
git add ci/hooks.mjs ci/test-hooks.mjs
git commit -m "feat: hook detector over a 30-snapshot window"
```


### Task 2: Candidate scorer and dedupe

**Files:**
- Create: `ci/post-score.mjs`
- Test: `ci/test-post-score.mjs`

**Interfaces:**
- Consumes: the `Hook` type from Task 1 (only `hook.ticker` and `hook.facts` are read).
- Produces:
  - `scorePost(text, ctx) -> { score, reasons }` where `ctx` is `{ hook, recent = [] }`, `recent` is an array of previously published post objects each having a `text` string and a `ticker` string. `score` is a number (may be negative); `reasons` is an array of human-readable strings.
  - `pickBest(candidates, ctx) -> { text, score, reasons } | null` — returns `null` when `candidates` is empty or every candidate scores below `MIN_PUBLISHABLE`.
  - `BANNED` (array of lowercase strings) and `MIN_PUBLISHABLE` (number).

- [ ] **Step 1: Write the failing test**

Create `ci/test-post-score.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ci/test-post-score.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` — `Cannot find module '.../ci/post-score.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `ci/post-score.mjs`:

```js
// THE JUDGE — turns N candidates into the one that ships, with no model involved.
//
// This is the whole reason a free 8B model is viable here. One shot from a weak model is
// a coin flip; five shots plus a strict deterministic filter is reliable. The filter is
// blunt on purpose — it cannot tell good from great, but it reliably kills the three
// things that make a post read as machine-written: stock LLM phrasing, no concrete
// numbers, and saying what we already said last run.
//
// Validated in Task 0 against real candidates: slop scored -93, good copy 86. It does NOT
// separate fine from great — three good candidates tied at 86 because the digit bonus
// caps at +16 and saturates, and ties break alphabetically. That ceiling is accepted on
// purpose. The lever for better copy is ci/style-corpus.json, not a cleverer formula here.

/** Phrases that mark copy as machine-written. Lowercase; matched as substrings. */
export const BANNED = [
  "let's dive in", "lets dive in", "dive into", "in the world of", "in today's",
  "game-changer", "game changer", "delve", "buckle up", "look no further",
  "it's important to note", "that being said", "when it comes to", "the bottom line is",
  "unlock the", "harness the", "navigate the", "landscape of", "testament to",
  "remember, ", "disclaimer:", "as an ai", "in conclusion", "furthermore",
  "skyrocket", "to the moon", "🚀🚀",
];

/** Below this, publish nothing. A skipped run beats a bad post. */
export const MIN_PUBLISHABLE = 30;

// ULTRA SHORT. Validated in Task 0: the winning posts land at 51-62 characters.
// 110 is a hard ceiling, not a target — a post at 105 scores no worse than one at 55,
// so the system prompt and the corpus are what actually pull length down; this band
// only rejects the outliers.
const IDEAL = { min: 25, max: 110 };

/** The distinctive leading word of a company name, so a post can name the company instead of
 *  the ticker. "Xpo, Inc." -> "Xpo"; "Praxis Precision Medicines" -> "Praxis". Corporate
 *  suffixes alone are never a match — "Inc" must not count as naming anything. */
export function nameStem(name) {
  const first = String(name ?? "").trim().split(/[\s,.]+/)[0] ?? "";
  return /^(inc|corp|co|ltd|plc|the|llc|sa|nv|ag)$/i.test(first) || first.length < 3 ? "" : first;
}

/** Word set for cheap near-duplicate detection — Jaccard over lowercased words >3 chars. */
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z$%\d.]{4,}/g) ?? []);
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / (a.size + b.size - hit);
};

export function scorePost(text, ctx = {}) {
  const { hook, recent = [] } = ctx;
  const s = String(text ?? "").trim();
  const lower = s.toLowerCase();
  const reasons = [];
  let score = 50;

  for (const phrase of BANNED) {
    if (lower.includes(phrase)) {
      score -= 25;
      reasons.push(`banned phrase: "${phrase}"`);
    }
  }

  const digits = (s.match(/\d/g) ?? []).length;
  if (digits === 0) {
    score -= 30;
    reasons.push("no numbers — not a data post");
  } else {
    score += Math.min(digits * 2, 16);
    reasons.push(`${digits} digits of concrete detail`);
  }

  // Ticker OR company name. The feed cards show "Netflix", not "NFLX", so a ticker-only
  // rule punishes exactly the copy we want — it scored the good NFLX candidate at 10 with
  // "missing NFLX" during Task 0. `nameStem` is the distinctive first word, so "Netflix"
  // matches "Netflix, Inc." and "Praxis" matches "Praxis Precision Medicines".
  if (hook?.ticker || hook?.name) {
    const stem = nameStem(hook?.name);
    const named =
      (hook?.ticker && s.includes(hook.ticker)) ||
      (stem && lower.includes(stem.toLowerCase()));
    if (named) {
      score += 10;
      reasons.push(`names ${hook.ticker ?? stem}`);
    } else {
      score -= 20;
      reasons.push(`does not name ${hook.ticker ?? stem}`);
    }
  }

  if (s.length < IDEAL.min) {
    score -= 25;
    reasons.push(`too short (${s.length} < ${IDEAL.min})`);
  } else if (s.length > IDEAL.max) {
    score -= Math.min(Math.ceil((s.length - IDEAL.max) / 20) * 5, 40);
    reasons.push(`too long (${s.length} > ${IDEAL.max})`);
  } else {
    score += 10;
    reasons.push("length in band");
  }

  // Hashtag spam is the loudest bot tell after stock phrasing.
  const tags = (s.match(/#\w+/g) ?? []).length;
  if (tags > 3) {
    score -= (tags - 3) * 8;
    reasons.push(`${tags} hashtags`);
  }

  // Exclamation-mark density.
  const bangs = (s.match(/!/g) ?? []).length;
  if (bangs > 1) {
    score -= bangs * 6;
    reasons.push(`${bangs} exclamation marks`);
  }

  const w = words(s);
  let worst = 0;
  for (const r of recent) {
    const sim = jaccard(w, words(r?.text));
    if (sim > worst) worst = sim;
    if (r?.ticker && hook?.ticker && r.ticker === hook.ticker) {
      score -= 12;
      reasons.push(`${hook.ticker} appeared in a recent post`);
      break;
    }
  }
  if (worst > 0.35) {
    score -= Math.round(worst * 80);
    reasons.push(`duplicate of a recent post (${Math.round(worst * 100)}% word overlap)`);
  }

  return { score: Math.round(score), reasons };
}

export function pickBest(candidates, ctx = {}) {
  const ranked = (candidates ?? [])
    .map((text) => ({ text: String(text ?? "").trim(), ...scorePost(text, ctx) }))
    .filter((c) => c.text)
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  const top = ranked[0];
  return top && top.score >= MIN_PUBLISHABLE ? top : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ci/test-post-score.mjs`
Expected: PASS, printing `post-score OK — banned phrases, numbers, length, dedupe, pickBest floor, determinism`

Run: `npm test`
Expected: both `ci/test-hooks.mjs` and `ci/test-post-score.mjs` report PASS.

- [ ] **Step 5: Commit**

```bash
git add ci/post-score.mjs ci/test-post-score.mjs
git commit -m "feat: deterministic candidate scorer and dedupe for social posts"
```

---

### Task 3: Provider shim

**Files:**
- Create: `ci/provider.mjs`
- Test: `ci/test-provider.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `makeProvider(env) -> async ({ system, prompt, n }) => string[]`
  - `env` defaults to `process.env`. Reads `POST_PROVIDER` (`"cloudflare"` | `"anthropic"` | `"stub"`, default `"cloudflare"`), `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_MODEL` (default `"@cf/meta/llama-3.1-8b-instruct"`), `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `"claude-haiku-4-5-20251001"`).
  - Returns exactly `n` strings, or fewer if some calls failed. Never throws on a single call failure — a rejected call yields no string and logs to stderr.
  - `makeProvider` itself throws a descriptive `Error` if the selected provider's credentials are absent.
  - The `"stub"` provider returns `n` deterministic placeholder strings and makes no network call — this is what the tests and `npm test` use.

- [ ] **Step 1: Write the failing test**

Create `ci/test-provider.mjs`:

```js
// Checks ci/provider.mjs — the one place that knows which model writes the copy.
// Strictly offline: the only provider exercised here is "stub". The point of this check
// is the CONTRACT (returns n strings, survives a failing call, refuses to start without
// credentials), not any vendor's API.

import assert from "node:assert";
import { makeProvider } from "./provider.mjs";

// --- stub: offline, deterministic ------------------------------------------------
{
  const gen = makeProvider({ POST_PROVIDER: "stub" });
  const out = await gen({ system: "s", prompt: "p", n: 4 });
  assert.equal(out.length, 4, "the stub returns exactly n candidates");
  assert.ok(out.every((s) => typeof s === "string" && s.length > 0), "every candidate is a non-empty string");
  const again = await gen({ system: "s", prompt: "p", n: 4 });
  assert.deepEqual(out, again, "the stub is deterministic");
}

// --- credentials are required up front, not at call time -------------------------
assert.throws(
  () => makeProvider({ POST_PROVIDER: "cloudflare" }),
  /CF_ACCOUNT_ID|CF_API_TOKEN/,
  "cloudflare without credentials fails loudly at construction",
);
assert.throws(
  () => makeProvider({ POST_PROVIDER: "anthropic" }),
  /ANTHROPIC_API_KEY/,
  "anthropic without a key fails loudly at construction",
);
assert.throws(
  () => makeProvider({ POST_PROVIDER: "nope" }),
  /unknown provider/i,
  "an unknown provider name is rejected",
);

// --- a provider that is configured constructs fine --------------------------------
assert.doesNotThrow(
  () => makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }),
  "configured cloudflare constructs without touching the network",
);

// --- one failing call must not sink the batch -------------------------------------
{
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 2) throw new Error("simulated 500");
    return { ok: true, json: async () => ({ result: { response: `candidate ${call}` } }) };
  };
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  const out = await gen({ system: "s", prompt: "p", n: 3 });
  assert.equal(out.length, 2, "two of three calls succeeded and the batch survived");
}

console.log("provider OK — stub determinism, credential guards, partial-failure tolerance");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ci/test-provider.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` — `Cannot find module '.../ci/provider.mjs'`

- [ ] **Step 3: Write minimal implementation**

Create `ci/provider.mjs`:

```js
// WHO WRITES THE COPY — one switch, so swapping models is an env var, not a refactor.
//
// Default is Cloudflare Workers AI because it is free: 10,000 neurons/day, and this
// pipeline burns roughly 15% of that at one post per 5h with five candidates per run.
// "anthropic" is here as the quality escape hatch (~$0.30/mo at this volume) for an A/B.
// "stub" is what `npm test` uses — no network in checks, ever.
//
// ponytail: a plain switch, not a class hierarchy. Three providers, one function each.

const CF_URL = (acct, model) => `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`;

/** Fire n independent calls. One failure must not lose the other four, so failures are
 *  logged and dropped rather than thrown — the caller decides whether what came back is
 *  enough to publish. */
async function batch(n, one) {
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => one(i)));
  const out = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
    else if (r.status === "rejected") console.error(`  candidate failed: ${r.reason?.message ?? r.reason}`);
  }
  return out;
}

export function makeProvider(env = process.env, fetchImpl = globalThis.fetch) {
  const name = env.POST_PROVIDER || "cloudflare";

  if (name === "stub") {
    return async ({ n = 1 }) =>
      Array.from({ length: n }, (_, i) => `stub candidate ${i + 1}: TICK target $210 — 42% upside.`);
  }

  if (name === "cloudflare") {
    const acct = env.CF_ACCOUNT_ID;
    const token = env.CF_API_TOKEN;
    if (!acct) throw new Error("POST_PROVIDER=cloudflare needs CF_ACCOUNT_ID");
    if (!token) throw new Error("POST_PROVIDER=cloudflare needs CF_API_TOKEN");
    const model = env.CF_MODEL || "@cf/meta/llama-3.1-8b-instruct";

    return async ({ system, prompt, n = 1 }) =>
      batch(n, async () => {
        const res = await fetchImpl(CF_URL(acct, model), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
            // High temperature on purpose: five near-identical candidates defeat best-of-N.
            temperature: 0.95,
            max_tokens: 300,
          }),
        });
        if (!res.ok) throw new Error(`cloudflare ${res.status}`);
        const j = await res.json();
        return (j?.result?.response ?? "").trim();
      });
  }

  if (name === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("POST_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
    const model = env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

    return async ({ system, prompt, n = 1 }) =>
      batch(n, async () => {
        const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model, max_tokens: 300, temperature: 1, system,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) throw new Error(`anthropic ${res.status}`);
        const j = await res.json();
        return (j?.content?.[0]?.text ?? "").trim();
      });
  }

  throw new Error(`unknown provider "${name}" — expected cloudflare, anthropic or stub`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ci/test-provider.mjs`
Expected: PASS, printing `provider OK — stub determinism, credential guards, partial-failure tolerance`

- [ ] **Step 5: Commit**

```bash
git add ci/provider.mjs ci/test-provider.mjs
git commit -m "feat: swappable LLM provider shim (cloudflare/anthropic/stub)"
```

---

### Task 4: Orchestrator, style corpus and workflow wiring

**Files:**
- Create: `ci/generate-posts.mjs`
- Create: `ci/style-corpus.json`
- Create: `src/data/posts.json` (seeded as `[]`)
- Test: `ci/test-generate-posts.mjs`
- Modify: `.github/workflows/site.yml` (add a step after "Refresh Fear & Greed index", and extend the commit step's path list)
- Modify: `ci/README.md` (document the new step)

**Interfaces:**
- Consumes: `detectHooks` (Task 1), `pickBest`/`scorePost` (Task 2), `makeProvider` (Task 3).
- Produces:
  - `buildPrompt(hook, exemplars) -> { system, prompt }`
  - `generate({ prev, curr, recent, provider, exemplars, config }) -> Post[]` — pure apart from the injected `provider`; performs no file I/O, which is what makes it testable.
  - `Post`: `{ id, ts, kind, ticker, name, sector, text, score, reasons, facts }`. `id` is `` `${ticker}-${ts}` ``.
  - `main()` runs only under the `import.meta.url` entry guard, does the file I/O, and writes `src/data/posts.json`.

- [ ] **Step 1: Write the failing test**

Create `ci/test-generate-posts.mjs`:

```js
// Checks ci/generate-posts.mjs — the wiring. Uses an injected fake provider, so this
// check never touches the network and never writes a file: generate() is pure apart
// from the provider it is handed, which is the whole reason it is shaped that way.

import assert from "node:assert";
import { buildPrompt, generate } from "./generate-posts.mjs";

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
{
  const provider = async ({ n }) => [
    "Let's dive in! AAA is a game-changer!!!",
    "Alpha Inc (AAA) trades at $100. The Street's target is $160 — 60% upside, 21 analysts, one hold.",
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

// --- cadence is configuration, not code ---------------------------------------------
{
  const provider = async () => ["Alpha Inc (AAA) at $100 against a $160 Street target — 60% upside, 21 analysts."];
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

console.log("generate-posts OK — prompt shape, best-of-N, cadence config, empty-field and penny-stock safety");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node ci/test-generate-posts.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` — `Cannot find module '.../ci/generate-posts.mjs'`

- [ ] **Step 3: Write minimal implementation**

First create `ci/style-corpus.json` — the few-shot anchors. Hand-written for v1; a later plan replaces these with scraped high-engagement posts:

```json
[
  "TSLA at $240. Street target: $310. Somebody is wrong and it's not the 43 analysts.",
  "Nobody is talking about CAT. 19 buys, zero sells, 31% to target.",
  "Smart Score says 9. The AI model says 22. Pick a side on PLTR.",
  "AMD went from Hold to Strong Buy in five hours. That doesn't usually happen quietly.",
  "$160 target on a $100 stock, 21 analysts covering, one hold. That's the whole thesis.",
  "Five names cleared 40% upside this morning. Four are healthcare.",
  "The Street raised MU's target 18% overnight and nobody noticed.",
  "Consensus flipped bearish on F today. First time since March.",
  "GOOGL: 38 analysts, 36 buys. The two holds are the interesting part.",
  "Upside to target is 52%. The stock is up 3% this week. One of those is lying."
]
```

Seed the feed file:

```bash
echo '[]' > src/data/posts.json
```

Create `ci/generate-posts.mjs`:

```js
// THE WIRING — hooks -> N candidates -> deterministic judge -> one post.
//
// Shape note: generate() takes its provider as an argument and does no file I/O, so
// ci/test-generate-posts.mjs can drive the whole pipeline offline with a fake provider.
// All reading and writing lives in main(), behind the entry guard at the bottom.
//
// Cadence is env config, not code — POSTS_PER_RUN=3 in site.yml is the only edit needed
// to go from one post per run to three.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { detectHooks } from "./hooks.mjs";
import { pickBest } from "./post-score.mjs";
import { makeProvider } from "./provider.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const STOCKS = path.join(ROOT, "src", "data", "stocks.json");
const POSTS = path.join(ROOT, "src", "data", "posts.json");
const CORPUS = path.join(ROOT, "ci", "style-corpus.json");

const KIND_BRIEF = {
  surprise: "The number is the story. Lead with it.",
  contrarian: "Two models disagree. Name the disagreement, do not resolve it.",
  list: "A short ranked list. No preamble before the first name.",
  movement: "Something changed since five hours ago. Say what, and from what to what.",
};

export function buildPrompt(hook, exemplars = []) {
  const system = [
    "You write short posts for a stock-data feed, in the voice of a finance person on X.",
    "Rules, all of them hard:",
    "- ONE sentence. Under 110 characters. Aim for 50 to 70. Shorter always wins.",
    "- Open with the fact. No greeting, no preamble, no 'Let's dive in'.",
    "- Use the exact numbers you are given. Never invent a number.",
    "- No hashtags beyond one. No emoji. At most one exclamation mark, ideally zero.",
    "- Never give advice, never say buy or sell, never predict. Report what the data says.",
    "- No disclaimer, no 'not financial advice' line — the app adds that itself.",
    "- Output the post text only. No quotes around it, no explanation, no options list.",
  ].join("\n");

  const shots = exemplars.length
    ? `Posts in the voice to match:\n${exemplars.map((e) => `- ${e}`).join("\n")}\n\n`
    : "";

  const facts = Object.entries(hook.facts)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const prompt =
    `${shots}Angle: ${KIND_BRIEF[hook.kind] ?? "Report the fact."}\n\n` +
    `Company: ${hook.name} (${hook.ticker}), ${hook.sec}\nFacts:\n${facts}\n\n` +
    `Write the post.`;

  return { system, prompt };
}

export async function generate({ history, recent = [], provider, exemplars = [], config = {} }) {
  const { postsPerRun = 1, candidates = 5, kindMemory = 4 } = config;
  // Task 0, Finding 2: feed the last few posts' KINDS back into the detector so the top
  // hook rotates shape instead of being "big upside number" every single run.
  const recentKinds = recent.slice(0, kindMemory).map((p) => p.kind).filter(Boolean);
  const hooks = detectHooks(history, { recentKinds });
  const posts = [];
  const usedTickers = new Set();

  for (const hook of hooks) {
    if (posts.length >= postsPerRun) break;
    if (usedTickers.has(hook.ticker)) continue;

    const { system, prompt } = buildPrompt(hook, exemplars);
    let texts = [];
    try {
      texts = await provider({ system, prompt, n: candidates });
    } catch (err) {
      console.error(`  ${hook.ticker}: provider threw — ${err.message}`);
      continue;
    }

    const best = pickBest(texts, { hook, recent: [...recent, ...posts] });
    if (!best) {
      console.error(`  ${hook.ticker} (${hook.kind}): ${texts.length} candidates, none publishable`);
      continue;
    }

    usedTickers.add(hook.ticker);
    const ts = new Date().toISOString();
    posts.push({
      id: `${hook.ticker}-${ts}`,
      ts,
      kind: hook.kind,
      ticker: hook.ticker,
      name: hook.name,
      sector: hook.sec,
      text: best.text,
      score: best.score,
      reasons: best.reasons,
      facts: hook.facts,
    });
    console.log(`  ${hook.ticker} (${hook.kind}) scored ${best.score} from ${texts.length} candidates`);
  }

  return posts;
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

/** The last `n` committed snapshots, OLDEST FIRST, with the working-copy snapshot appended
 *  as the current one. The repo IS the history — 376 commits of src/data/stocks.json and
 *  counting — so there is nothing to store. Task 0 measured 30 snapshots at 0.68s / 18.6MB,
 *  covering 5.8 days.
 *
 *  Commits are listed with `--follow`-free `git log -- <path>`, which lists only the commits
 *  that CHANGED the file. That matters: plain `HEAD~1` is often an unrelated feature commit
 *  (Task 0, Finding 1) and comparing against it silently yields zero movement hooks.
 *
 *  In CI this runs AFTER the refresh step has overwritten the working copy but BEFORE the
 *  commit step, so the file on disk is genuinely newer than every commit. Locally, after a
 *  refresh has already been committed, the newest commit and the working copy are identical —
 *  the duplicate is dropped below so the window is not one snapshot short. */
function loadWindow(n) {
  const git = (args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

  const current = readJson(STOCKS, []);
  let shas = [];
  try {
    shas = git(["log", `-${n}`, "--format=%H", "--", "src/data/stocks.json"]).trim().split("\n").filter(Boolean);
  } catch {
    console.error("  no git history available — window rules are skipped this run");
    return [current];
  }

  const window = [];
  for (const sha of shas.reverse()) {            // oldest first
    try {
      window.push(JSON.parse(git(["show", `${sha}:src/data/stocks.json`])));
    } catch {
      // A commit that predates the file, or a bad blob: skip it, keep the rest.
    }
  }

  // Drop the newest commit if it is byte-identical to the working copy (the local case).
  const last = window[window.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(current)) window.pop();

  window.push(current);
  return window;
}

async function main() {
  // Kill switch. The UI half of this feature is behind the `feed` flag; this is the
  // generation half, so the whole thing can be switched off without reverting code.
  // Set POSTS_ENABLED to "false" in site.yml to stop writing posts.
  if (String(process.env.POSTS_ENABLED ?? "true").toLowerCase() === "false") {
    console.log("POSTS_ENABLED=false — generation is off, leaving posts.json unchanged");
    return;
  }

  const config = {
    postsPerRun: Number(process.env.POSTS_PER_RUN ?? 1),
    candidates: Number(process.env.POST_CANDIDATES ?? 5),
  };
  const keep = Number(process.env.POSTS_KEEP ?? 200);

  const existing = readJson(POSTS, []);
  const exemplars = readJson(CORPUS, []);
  const history = loadWindow(Number(process.env.POST_WINDOW ?? 30));
  const curr = history[history.length - 1];

  console.log(`generate-posts — ${curr.length} rows, ${history.length} snapshots in window, ` +
              `${existing.length} existing posts, ` +
              `${config.postsPerRun} post(s) x ${config.candidates} candidates`);

  const provider = makeProvider();
  const posts = await generate({ history, recent: existing.slice(0, 50), provider, exemplars, config });

  if (!posts.length) {
    console.log("nothing publishable this run — leaving posts.json unchanged");
    return;
  }

  writeFileSync(POSTS, `${JSON.stringify([...posts, ...existing].slice(0, keep), null, 2)}\n`);
  console.log(`wrote ${posts.length} post(s) — ${posts.map((p) => p.ticker).join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node ci/test-generate-posts.mjs`
Expected: PASS, printing `generate-posts OK — prompt shape, best-of-N, cadence config, empty-field and penny-stock safety`

Run the offline end-to-end against real data with the stub provider:
Run: `POST_PROVIDER=stub node ci/generate-posts.mjs`
Expected: it prints the row count and either writes a post or says nothing was publishable. Either is fine — it must not throw.

Run: `npm test`
Expected: all four new checks report PASS alongside the existing ones.

Revert any stub-written feed content before committing:
Run: `git checkout src/data/posts.json 2>/dev/null || echo '[]' > src/data/posts.json`

- [ ] **Step 5: Wire it into the workflow**

In `.github/workflows/site.yml`, insert this step immediately **after** the `Refresh Fear & Greed index` step and **before** the `Re-check the refreshed data (THE DATA GATE)` step:

```yaml
      # Generate one social post from the snapshot just refreshed. Scrape-class step:
      # `continue-on-error` like every other one above the data gate, because a rate-limited
      # model or a field of unpublishable candidates must never block the data deploy.
      # Runs BEFORE the gate so the post ships in the same commit as the data it describes.
      # Cadence is entirely in the env below — POSTS_PER_RUN is the knob.
      - name: Generate social post
        if: github.event_name != 'push'
        continue-on-error: true
        env:
          POSTS_ENABLED: "true"
          POST_PROVIDER: cloudflare
          POSTS_PER_RUN: "1"
          POST_CANDIDATES: "5"
          POST_WINDOW: "30"
          CF_ACCOUNT_ID: ${{ secrets.CF_ACCOUNT_ID }}
          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
        run: node ci/generate-posts.mjs
```

The commit step already stages all of `src/data`, so `src/data/posts.json` is picked up with no change to that step. Verify by reading the step — it runs `git add src/data public/forecasts public/bullbear public/reviews-recent.json`. Confirm `src/data` is present in both the `git diff --quiet` guard and the `git add`. No edit needed if so.

- [ ] **Step 6: Document it**

Append to the "How it runs" bullet list in `ci/README.md`, after the Fear & Greed bullet:

```markdown
- **`ci/generate-posts.mjs`** turns the fresh snapshot into one social post for the in-app feed:
  `ci/hooks.mjs` diffs `HEAD:src/data/stocks.json` against the working copy and emits scored,
  structured hooks (no LLM — same snapshots always give the same hooks); the provider in
  `ci/provider.mjs` writes `POST_CANDIDATES` variations; `ci/post-score.mjs` picks the best one
  deterministically and writes it to `src/data/posts.json` (rolling, newest first, `POSTS_KEEP` max).
  `continue-on-error` like the other scrapes. Publishing nothing is a valid outcome — a skipped
  run beats a bad post.

  **Knobs** (env in `.github/workflows/site.yml`): `POSTS_PER_RUN` (default 1), `POST_CANDIDATES`
  (default 5), `POSTS_KEEP` (default 200), `POST_PROVIDER` (`cloudflare` free-tier default,
  `anthropic` for quality, `stub` for offline runs). Secrets: `CF_ACCOUNT_ID`, `CF_API_TOKEN`.
```

- [ ] **Step 7: Commit**

```bash
git add ci/generate-posts.mjs ci/test-generate-posts.mjs ci/style-corpus.json \
        src/data/posts.json .github/workflows/site.yml ci/README.md
git commit -m "feat: generate one social post per refresh run, best-of-N"
```

---

### Task 5: Feature flag

**Files:**
- Create: `src/featureFlags.ts`
- Test: `src/featureFlags.check.ts`

The Feed is not visible to anyone until a flag turns it on. MarketPulse has no backend and no
flag service, so the flag is a URL parameter that sticks in `localStorage` — the whole mechanism
is one pure function plus a four-line wrapper. Split.io and friends need a server this app does
not have.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `resolveFlags(search, stored) -> string[]` — pure, sorted, deduped. `search` is a
    `location.search` string, `stored` is the raw `localStorage` value (or `null`).
    `?ff=feed` adds a flag, `?ff=-feed` removes it, `?ff=feed,charts` sets several.
  - `flagOn(name) -> boolean` — the impure wrapper; reads `location`/`localStorage`, persists the
    merged set, never throws.
  - `FLAGS_LS` — the storage key, `"mp:ff"`.

- [ ] **Step 1: Write the failing test**

Create `src/featureFlags.check.ts`:

```ts
// npx tsc src/featureFlags.check.ts --outDir node_modules/.tmp/checks --module commonjs \
//   --target es2020 --lib es2020,dom --esModuleInterop --skipLibCheck
//
// resolveFlags is the whole flag system. It is pure so it can be checked without a browser:
// the wrapper around it only reads location/localStorage and hands the strings over.

import { resolveFlags } from "./featureFlags";

let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return;
  console.log(`FAIL ${label}: got ${g}, want ${w}`);
  failed++;
}

eq("nothing set", resolveFlags("", null), []);
eq("url turns one on", resolveFlags("?ff=feed", null), ["feed"]);
eq("stored persists", resolveFlags("", '["feed"]'), ["feed"]);
eq("url adds to stored", resolveFlags("?ff=charts", '["feed"]'), ["charts", "feed"]);
eq("minus removes", resolveFlags("?ff=-feed", '["feed"]'), []);
eq("several at once", resolveFlags("?ff=feed,charts", null), ["charts", "feed"]);
eq("add and remove together", resolveFlags("?ff=charts,-feed", '["feed"]'), ["charts"]);
eq("other params ignored", resolveFlags("?t=AAPL&ff=feed", null), ["feed"]);
eq("no duplicates", resolveFlags("?ff=feed,feed", '["feed"]'), ["feed"]);
eq("always sorted", resolveFlags("?ff=zeta,alpha", null), ["alpha", "zeta"]);
eq("blank entries dropped", resolveFlags("?ff=feed,,%20,-", null), ["feed"]);
// Corrupt storage must not take the app down — a bad value is simply no flags.
eq("garbage storage", resolveFlags("", "not json"), []);
eq("wrong-shaped storage", resolveFlags("", '{"feed":true}'), []);
eq("non-string members dropped", resolveFlags("", '["feed",3,null]'), ["feed"]);

if (failed) throw new Error(`${failed} check(s) failed`);
console.log("featureFlags OK — url on/off, persistence, merge, sort, dedupe, corrupt storage");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the `tsc` step reports FAIL — `Cannot find module './featureFlags'`

- [ ] **Step 3: Write minimal implementation**

Create `src/featureFlags.ts`:

```ts
// Feature flags for a static site with no backend.
//
// `?ff=feed` turns a flag on and remembers it; `?ff=-feed` turns it off. That is the entire
// mechanism — this app deploys to GitHub Pages and has no server to ask, so a flag service
// is not an option. Good enough to keep an unfinished section out of everyone's way, and to
// hand a reviewer a link that switches it on.
//
// ponytail: URL + localStorage, per-browser. If a flag ever needs to follow a user across
// devices, it moves to the Firebase RTDB path the watchlist already uses.

export const FLAGS_LS = "mp:ff";

/** Pure core: current query string + whatever was stored -> the active flag list. */
export function resolveFlags(search: string, stored: string | null): string[] {
  const active = new Set<string>();

  try {
    const parsed: unknown = JSON.parse(stored ?? "[]");
    if (Array.isArray(parsed)) {
      for (const f of parsed) if (typeof f === "string" && f.trim()) active.add(f.trim());
    }
  } catch {
    // A corrupt value means no flags, never a crash on boot.
  }

  const raw = new URLSearchParams(search).get("ff");
  if (raw) {
    for (const part of raw.split(",")) {
      const name = part.trim();
      if (!name || name === "-") continue;
      if (name.startsWith("-")) active.delete(name.slice(1).trim());
      else active.add(name);
    }
  }

  return [...active].sort();
}

/** Impure wrapper. Reads the URL and storage, writes the merged set back, never throws —
 *  a blocked or full localStorage must not stop the app rendering. */
export function flagOn(name: string): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(FLAGS_LS);
  } catch {
    /* private window, blocked storage */
  }

  const flags = resolveFlags(typeof location === "undefined" ? "" : location.search, stored);

  try {
    localStorage.setItem(FLAGS_LS, JSON.stringify(flags));
  } catch {
    /* over quota or blocked — the flag still applies for this page load */
  }

  return flags.includes(name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `src/featureFlags.check.ts` PASS, printing
`featureFlags OK — url on/off, persistence, merge, sort, dedupe, corrupt storage`

- [ ] **Step 5: Commit**

```bash
git add src/featureFlags.ts src/featureFlags.check.ts
git commit -m "feat: URL-based feature flags for a backend-less site"
```

---

### Task 6: Post art

**Files:**
- Create: `src/postArt.ts`
- Test: `src/postArt.check.ts`

Layout 01 puts an image under every hook. It is drawn on a canvas from the row's own `sec`
field, not fetched from an image model: it costs nothing, renders instantly offline, and
**cannot paint a fake price or a garbled ticker onto the picture** — the failure mode that makes
generated finance imagery unusable. A Flux path can be added later; this is the floor, not a
placeholder.

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sceneFor(sector) -> SceneName` — maps a TipRanks `sec` string to a scene. Unknown or
    missing sector falls back to `"market"`. Case-insensitive.
  - `SCENES: Record<SceneName, (c, w, h, rand) => void>` — the draw functions.
  - `paint(canvas, sector, ticker) -> void` — sizes for devicePixelRatio and draws. No-op when
    the canvas has no layout size yet.
  - `seeded(seed) -> () => number` — the PRNG, exported so the check can prove determinism.

- [ ] **Step 1: Write the failing test**

Create `src/postArt.check.ts`:

```ts
// npx tsc src/postArt.check.ts --outDir node_modules/.tmp/checks --module commonjs \
//   --target es2020 --lib es2020,dom --esModuleInterop --skipLibCheck
//
// Canvas drawing cannot be asserted in Node, and pixel-diffing art is a maintenance trap.
// What IS worth pinning: every sector maps to a scene that exists, an unknown sector does not
// crash the feed, and the same ticker always produces the same picture.

import { sceneFor, SCENES, seeded } from "./postArt";

let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return;
  console.log(`FAIL ${label}: got ${g}, want ${w}`);
  failed++;
}

// --- every sector TipRanks actually emits maps somewhere ---------------------
// This list is the distinct `sec` values in src/data/stocks.json. If a refresh adds a new
// one this check still passes (it falls back), but the mapping below is where to add it.
for (const sec of ["Healthcare", "Technology", "Financial", "Industrials", "Energy",
                   "Consumer Cyclical", "Consumer Defensive", "Basic Materials",
                   "Real Estate", "Utilities", "Communication Services", "General"]) {
  const scene = sceneFor(sec);
  if (!SCENES[scene]) { console.log(`FAIL ${sec} -> "${scene}", which is not a drawable scene`); failed++; }
}

eq("healthcare", sceneFor("Healthcare"), "bio");
eq("tech", sceneFor("Technology"), "screens");
eq("case-insensitive", sceneFor("hEaLtHcArE"), "bio");
eq("unknown falls back", sceneFor("Nonexistent Sector"), "market");
eq("empty falls back", sceneFor(""), "market");
eq("null falls back", sceneFor(null as unknown as string), "market");
eq("fallback is drawable", typeof SCENES[sceneFor("")], "function");

// --- same ticker, same picture ------------------------------------------------
{
  const a = seeded("NFLX"), b = seeded("NFLX"), c = seeded("PRAX");
  const take = (f: () => number) => [f(), f(), f(), f()];
  const first = take(a);
  eq("deterministic per seed", take(b), first);
  eq("different seed differs", take(c) === first, false);
  for (const v of first) {
    if (!(v >= 0 && v < 1)) { console.log(`FAIL prng out of range: ${v}`); failed++; }
  }
}

if (failed) throw new Error(`${failed} check(s) failed`);
console.log("postArt OK — every sector maps to a drawable scene, fallback holds, art is deterministic");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the `tsc` step reports FAIL — `Cannot find module './postArt'`

- [ ] **Step 3: Write minimal implementation**

Create `src/postArt.ts`:

```ts
// The picture under every post. Drawn here, not fetched.
//
// An image model would cost money per post and, far worse, would render invented numbers and
// misspelled tickers into finance imagery. These scenes carry no text at all: the FORM says
// which industry, the seed makes a given ticker always look the same, and nothing drawn here
// can contradict the data above it.
//
// ponytail: six scenes plus a fallback, chosen off the `sec` field that is already in every
// row. If a sector deserves its own look later, add a draw function and one mapping line.

export type SceneName = "bio" | "screens" | "freight" | "grid" | "vault" | "earth" | "market";
type Rand = () => number;
type Draw = (c: CanvasRenderingContext2D, w: number, h: number, rand: Rand) => void;

/** FNV-1a over the ticker, then mulberry32. Stable across runs and browsers, which is what
 *  makes a name's picture recognisable from one post to the next. */
export function seeded(seed: string): Rand {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTOR_SCENE: Record<string, SceneName> = {
  "healthcare": "bio",
  "technology": "screens",
  "communication services": "screens",
  "industrials": "freight",
  "general": "freight",
  "consumer cyclical": "grid",
  "consumer defensive": "grid",
  "basic materials": "earth",
  "energy": "earth",
  "financial": "vault",
  "financial services": "vault",
  "real estate": "vault",
  "utilities": "grid",
};

export function sceneFor(sector: string): SceneName {
  return SECTOR_SCENE[String(sector ?? "").trim().toLowerCase()] ?? "market";
}

const sky = (c: CanvasRenderingContext2D, w: number, h: number, a: string, b: string) => {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, a); g.addColorStop(1, b);
  c.fillStyle = g; c.fillRect(0, 0, w, h);
};
const rr = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  c.beginPath(); c.roundRect(x, y, w, h, r);
};

/** Molecular lattice — healthcare. */
const bio: Draw = (c, w, h, r) => {
  sky(c, w, h, "#0f3a52", "#05090f");
  const cx = w * 0.56, cy = h * 0.46, R = Math.min(w, h) * 0.3;
  const glow = c.createRadialGradient(cx, cy, 0, cx, cy, R * 2.3);
  glow.addColorStop(0, "rgba(58,174,184,.42)"); glow.addColorStop(1, "rgba(58,174,184,0)");
  c.fillStyle = glow; c.fillRect(0, 0, w, h);
  const N: { x: number; y: number; s: number }[] = [];
  const reach = Math.min(w, h) * 0.45;
  for (let i = 0; i < 16; i++) N.push({ x: r() * w, y: h * 0.08 + r() * h * 0.84, s: 1.8 + r() * 3 });
  c.lineWidth = 1.2;
  for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
    const d = Math.hypot(N[i].x - N[j].x, N[i].y - N[j].y);
    if (d >= reach) continue;
    c.globalAlpha = 0.5 * (1 - d / reach); c.strokeStyle = "#5fd6e0";
    c.beginPath(); c.moveTo(N[i].x, N[i].y); c.lineTo(N[j].x, N[j].y); c.stroke();
  }
  c.globalAlpha = 1;
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i - Math.PI / 6; pts.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]); }
  c.lineJoin = "round";
  c.strokeStyle = "rgba(240,185,60,.3)"; c.lineWidth = Math.max(5, R * 0.22);
  c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.stroke();
  c.strokeStyle = "#f0b93c"; c.lineWidth = Math.max(1.8, R * 0.055); c.stroke();
  for (const [x, y] of pts) { c.beginPath(); c.arc(x, y, Math.max(2.4, R * 0.075), 0, 7); c.fillStyle = "#ffd98a"; c.fill(); }
  for (const q of N) {
    const g = c.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.s * 5);
    g.addColorStop(0, "rgba(150,240,250,.95)"); g.addColorStop(1, "rgba(150,240,250,0)");
    c.fillStyle = g; c.beginPath(); c.arc(q.x, q.y, q.s * 5, 0, 7); c.fill();
    c.fillStyle = "#dbf7fb"; c.beginPath(); c.arc(q.x, q.y, q.s * 0.7, 0, 7); c.fill();
  }
};

/** Wall of screens — technology and communications. */
const screens: Draw = (c, w, h, r) => {
  sky(c, w, h, "#1a2030", "#05070b");
  const cols = w > h ? 4 : 3, rows = Math.max(2, Math.round((cols * h) / w));
  const pad = Math.min(w, h) * 0.05, gw = (w - pad * (cols + 1)) / cols, gh = (h - pad * (rows + 1)) / rows;
  const hx = Math.floor(r() * cols), hy = Math.floor(r() * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const px = pad + x * (gw + pad), py = pad + y * (gh + pad);
    const hero = x === hx && y === hy, lum = hero ? 1 : 0.14 + r() * 0.5;
    const g = c.createLinearGradient(px, py, px, py + gh);
    if (hero) { g.addColorStop(0, "#ef4a36"); g.addColorStop(1, "#8c2117"); }
    else { g.addColorStop(0, `rgba(59,111,189,${lum})`); g.addColorStop(1, `rgba(18,34,58,${lum})`); }
    rr(c, px, py, gw, gh, 5); c.fillStyle = g; c.fill();
    c.globalAlpha = hero ? 0.95 : 0.34; c.strokeStyle = "rgba(190,215,250,.55)"; c.lineWidth = 1;
    rr(c, px, py, gw, gh, 5); c.stroke(); c.globalAlpha = 1;
    if (hero && Math.min(gw, gh) > 16) {
      const s = Math.min(gw, gh) * 0.3, mx = px + gw / 2, my = py + gh / 2;
      c.beginPath(); c.moveTo(mx - s * 0.42, my - s * 0.66); c.lineTo(mx + s * 0.7, my);
      c.lineTo(mx - s * 0.42, my + s * 0.66); c.closePath();
      c.fillStyle = "rgba(255,255,255,.96)"; c.fill();
    }
  }
};

/** Container yard at dusk — industrials and logistics. */
const freight: Draw = (c, w, h, r) => {
  sky(c, w, h, "#24518f", "#080d15");
  const hz = h * 0.4;
  const sun = c.createRadialGradient(w * 0.72, hz, 0, w * 0.72, hz, Math.max(w, h) * 0.7);
  sun.addColorStop(0, "rgba(230,160,60,.55)"); sun.addColorStop(1, "rgba(230,160,60,0)");
  c.fillStyle = sun; c.fillRect(0, 0, w, h);
  c.fillStyle = "rgba(5,9,15,.8)"; c.fillRect(0, hz, w, h - hz);
  const cols: [string, string][] = [["#d8402f", "#7d1f15"], ["#1fa3b0", "#0d555c"],
    ["#e0a41a", "#7d5c08"], ["#3b6fbd", "#1b3f73"], ["#1ea45f", "#0f5c37"]];
  for (let row = 0; row < 3; row++) {
    const d = row / 2, bw = w * (0.24 + d * 0.22), bh = h * (0.072 + d * 0.055);
    const y = hz + (h - hz) * Math.pow(d, 1.25) * 0.9;
    for (let x = -bw * 0.4; x < w + bw; x += bw * 1.05) {
      const stack = 1 + Math.floor(r() * (2 + row * 1.6));
      for (let s = 0; s < stack; s++) {
        const [f, sd] = cols[Math.floor(r() * cols.length)];
        const px = x + r() * 5, py = y - s * bh * 1.05;
        c.globalAlpha = 0.55 + d * 0.45;
        c.fillStyle = f; c.fillRect(px, py - bh, bw * 0.95, bh);
        c.fillStyle = sd; c.fillRect(px, py - bh, bw * 0.95, bh * 0.22);
        c.fillStyle = "rgba(0,0,0,.34)"; c.fillRect(px, py - bh * 0.18, bw * 0.95, bh * 0.18);
      }
    }
  }
  c.globalAlpha = 1;
};

/** Isometric shelving — consumer and utilities. */
const grid: Draw = (c, w, h, r) => {
  sky(c, w, h, "#1d3550", "#070c13");
  const rows = 6, cell = h / rows;
  for (let y = 0; y < rows; y++) {
    const yy = y * cell + cell * 0.2;
    c.fillStyle = "rgba(120,160,215,.16)"; c.fillRect(0, yy + cell * 0.62, w, 2);
    for (let x = 0; x < 7; x++) {
      const bw = w * (0.06 + r() * 0.07), bh = cell * (0.2 + r() * 0.38);
      const px = x * (w / 7) + r() * 8;
      c.globalAlpha = 0.3 + r() * 0.6;
      c.fillStyle = ["#3b6fbd", "#1fa3b0", "#e0a41a", "#d8402f"][Math.floor(r() * 4)];
      rr(c, px, yy + cell * 0.62 - bh, bw, bh, 2); c.fill();
    }
  }
  c.globalAlpha = 1;
};

/** Concentric vault rings — financials and real estate. */
const vault: Draw = (c, w, h, r) => {
  sky(c, w, h, "#152a44", "#05080d");
  const cx = w * 0.5, cy = h * 0.5, R = Math.min(w, h) * 0.42;
  for (let i = 6; i >= 1; i--) {
    c.beginPath(); c.arc(cx, cy, (R * i) / 6, 0, Math.PI * 2);
    c.strokeStyle = i === 3 ? "#e0a41a" : "rgba(120,170,230,.42)";
    c.lineWidth = i === 3 ? 3 : 1.2; c.globalAlpha = 0.35 + i / 12; c.stroke();
  }
  c.globalAlpha = 1;
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + r() * 0.2;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * R * 0.2, cy + Math.sin(a) * R * 0.2);
    c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    c.strokeStyle = "rgba(160,200,245,.3)"; c.lineWidth = 1.4; c.stroke();
  }
  c.beginPath(); c.arc(cx, cy, R * 0.14, 0, Math.PI * 2); c.fillStyle = "#ffd98a"; c.fill();
};

/** Strata and a seam — energy and materials. */
const earth: Draw = (c, w, h, r) => {
  sky(c, w, h, "#3a2a1c", "#080605");
  const bands = 9;
  for (let i = 0; i < bands; i++) {
    const y = (i / bands) * h;
    c.beginPath(); c.moveTo(0, y);
    for (let x = 0; x <= w; x += 8) c.lineTo(x, y + Math.sin(x / (30 + i * 9) + i) * (4 + i));
    c.lineTo(w, h); c.lineTo(0, h); c.closePath();
    c.fillStyle = ["#6b4a2a", "#4a3220", "#8a5c2e", "#2f2015"][i % 4];
    c.globalAlpha = 0.45 + (i / bands) * 0.5; c.fill();
  }
  c.globalAlpha = 1;
  c.beginPath(); c.moveTo(0, h * 0.58);
  for (let x = 0; x <= w; x += 10) c.lineTo(x, h * 0.58 + Math.sin(x / 34) * 7);
  c.strokeStyle = "#e0a41a"; c.lineWidth = 2.4; c.stroke();
};

/** Candlestick skyline — the fallback for any sector without its own look. */
const market: Draw = (c, w, h, r) => {
  sky(c, w, h, "#16263d", "#05080d");
  const n = 16, cw = w / n;
  let y = h * 0.62;
  for (let i = 0; i < n; i++) {
    const move = (r() - 0.45) * h * 0.13;
    const top = Math.min(y, y + move), bot = Math.max(y, y + move);
    const up = move < 0, x = i * cw + cw * 0.28;
    c.strokeStyle = up ? "rgba(63,190,128,.75)" : "rgba(232,112,95,.75)";
    c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(x + cw * 0.22, top - r() * 10); c.lineTo(x + cw * 0.22, bot + r() * 10); c.stroke();
    c.fillStyle = up ? "#3fbe80" : "#e8705f"; c.globalAlpha = 0.85;
    c.fillRect(x, top, cw * 0.44, Math.max(2, bot - top));
    c.globalAlpha = 1; y += move;
    y = Math.max(h * 0.22, Math.min(h * 0.82, y));
  }
};

export const SCENES: Record<SceneName, Draw> = { bio, screens, freight, grid, vault, earth, market };

/** Size for the device pixel ratio and draw. A canvas with no layout size yet is skipped —
 *  the caller repaints on resize. */
export function paint(canvas: HTMLCanvasElement, sector: string, ticker: string): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const c = canvas.getContext("2d");
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  SCENES[sceneFor(sector)](c, w, h, seeded(ticker));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `src/postArt.check.ts` PASS, printing
`postArt OK — every sector maps to a drawable scene, fallback holds, art is deterministic`

- [ ] **Step 5: Commit**

```bash
git add src/postArt.ts src/postArt.check.ts
git commit -m "feat: seeded canvas art for post cards, keyed on sector"
```

---

### Task 7: Feed page — single stream

**Files:**
- Create: `src/components/PostFeed.tsx`
- Test: `src/postfeed.check.ts`
- Modify: `src/index.css` (append the feed block at the end, after the existing rules)
- Modify: `src/components/NavMenu.tsx:3` (`NavId`), `:11` (`ICON`), `:36` (`ITEMS`, from the flag)
- Modify: `src/App.tsx` (import, and a branch in the `nav ===` chain at ~line 454)

**Chosen layout — single stream.** One post per row, newest first. Per card, top to bottom:
kind pill and the `dd/mm HH:mm` stamp on one line, the hook as the headline, the sector art
below it, then a supporting line.

The supporting line is **built from the post's own facts, not written by the model** — the
writer emits one text field and that stays true. A second generated field would need its own
prompt, its own scoring and its own failure mode, to produce a line that is pure data
formatting. The component does it in one function.

The Feed is a fifth **section** (`NavId`), not a fourth table tab (`ViewId`) — `VIEWS` are sort
modes over the same stock table, and a post feed is not that.

**Interfaces:**
- Consumes: `src/data/posts.json` (the `Post` shape from Task 4), `paint` from Task 6,
  `flagOn` from Task 5.
- Produces:
  - `PostFeed` — named export.
  - `formatStamp(iso) -> string` — the created-at stamp, in the **viewer's local time**, as
    `dd/mm HH:mm`. Returns `""` for anything unparseable.
  - `sortNewestFirst(posts) -> Post[]` — a new array, newest `ts` first.
  - `supportLine(post) -> string` — the derived line, e.g.
    `"Netflix · Smart Score 8 → 6 · 25 analysts"`. Never throws on odd facts.

- [ ] **Step 1: Write the failing test**

Create `src/postfeed.check.ts`:

```ts
// npx tsc src/postfeed.check.ts --outDir node_modules/.tmp/checks --module commonjs \
//   --target es2020 --lib es2020,dom --jsx react --esModuleInterop --resolveJsonModule --skipLibCheck
//
// The three pure helpers behind the feed. The component is markup; ordering, the timestamp
// and the derived support line are the parts that can silently go wrong.

import { formatStamp, sortNewestFirst, supportLine } from "./components/PostFeed";

let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return;
  console.log(`FAIL ${label}: got ${g}, want ${w}`);
  failed++;
}

// --- dd/mm HH:mm, in the VIEWER'S timezone ---------------------------------
// Building the Date from local components makes these true in EVERY timezone:
// new Date(2026, 8, 21, 9, 5) is 21 Sep 09:05 local wherever this runs. Asserting on a "Z"
// string instead would pass in CI and fail on the author's laptop.
eq("pads both fields", formatStamp(new Date(2026, 8, 21, 9, 5).toISOString()), "21/09 09:05");
eq("midnight", formatStamp(new Date(2026, 0, 1, 0, 0).toISOString()), "01/01 00:00");
eq("24h, not am/pm", formatStamp(new Date(2026, 11, 31, 23, 59).toISOString()), "31/12 23:59");
eq("month is 1-based", formatStamp(new Date(2026, 9, 3, 14, 7).toISOString()), "03/10 14:07");
eq("bad input", formatStamp("not-a-date"), "");
eq("empty input", formatStamp(""), "");

// --- newest first ------------------------------------------------------------
{
  const mk = (id: string, ts: string) => ({ id, ts }) as never;
  const out = sortNewestFirst([
    mk("old", "2026-09-19T02:00:00Z"),
    mk("new", "2026-09-21T10:00:00Z"),
    mk("mid", "2026-09-20T06:00:00Z"),
  ]);
  eq("descending by ts", out.map((p: { id: string }) => p.id), ["new", "mid", "old"]);
}
{
  const input = [{ id: "a", ts: "2026-09-19T02:00:00Z" }] as never[];
  const out = sortNewestFirst(input);
  eq("does not mutate the input", input.length, 1);
  eq("returns a new array", out === input, false);
}
eq("empty list", sortNewestFirst([]), []);
{
  const mk = (id: string, ts: string) => ({ id, ts }) as never;
  const out = sortNewestFirst([mk("bad", "x"), mk("good", "2026-09-21T10:00:00Z")]);
  eq("unparseable ts sorts last", out.map((p: { id: string }) => p.id), ["good", "bad"]);
}

// --- the derived support line --------------------------------------------------
{
  const post = (facts: Record<string, string | number | boolean>, name = "Netflix") =>
    ({ name, facts }) as never;
  eq("name leads",
    supportLine(post({ smartScoreFrom: 8, smartScoreTo: 6, analysts: 25 })),
    "Netflix · Smart Score 8 → 6 · 25 analysts");
  eq("upside and target",
    supportLine(post({ upside: 145, priceTarget: 732.38, analysts: 13 }, "Praxis")),
    "Praxis · 145% to $732.38 · 13 analysts");
  eq("model disagreement",
    supportLine(post({ smartScore: 1, aiScore: 65 }, "Xpo, Inc.")),
    "Xpo, Inc. · Smart Score 1, AI 65");
  eq("no usable facts is just the name", supportLine(post({}, "Acme")), "Acme");
  eq("missing facts object", supportLine({ name: "Acme" } as never), "Acme");
  eq("missing everything", supportLine({} as never), "");
  eq("one analyst is singular", supportLine(post({ upside: 20, analysts: 1 }, "Acme")),
    "Acme · 20% · 1 analyst");
}

if (failed) throw new Error(`${failed} check(s) failed`);
console.log("postfeed OK — dd/mm HH:mm local stamp, newest-first ordering, derived support line");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the `tsc` step reports FAIL — `Cannot find module './components/PostFeed'`

- [ ] **Step 3: Write minimal implementation**

Create `src/components/PostFeed.tsx`:

```tsx
import { useEffect, useRef } from "react";
import posts from "../data/posts.json";
import { paint } from "../postArt";

export type Post = {
  id: string;
  ts: string;
  kind: string;
  ticker: string;
  name: string;
  sector: string;
  text: string;
  score: number;
  reasons: string[];
  facts: Record<string, string | number | boolean>;
};

const p2 = (n: number) => String(n).padStart(2, "0");

/** Created-at, in the VIEWER'S local timezone, as `dd/mm HH:mm`. getDate/getMonth/getHours
 *  are local-time getters, so a post written at 13:44 UTC reads 16:44 in Israel — which is
 *  the point. Returns "" for a bad value rather than rendering "NaN/NaN" into the feed. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Newest first. The generator already prepends, but ordering the feed is the feed's job —
 *  a hand-edited or merged posts.json must still render in the right order. */
export function sortNewestFirst(list: Post[]): Post[] {
  const key = (p: Post) => {
    const t = Date.parse(p?.ts);
    return Number.isFinite(t) ? t : -Infinity; // an unparseable stamp sinks to the bottom
  };
  return [...list].sort((a, b) => key(b) - key(a));
}

/** The line under the art, built from the post's own facts. Deliberately NOT generated: a
 *  second model field would need its own prompt, scoring and failure mode to produce what is
 *  really just data formatting. */
export function supportLine(post: Post): string {
  const f = post?.facts ?? {};
  const parts: string[] = [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const ssFrom = num(f.smartScoreFrom), ssTo = num(f.smartScoreTo);
  if (ssFrom !== null && ssTo !== null) parts.push(`Smart Score ${ssFrom} → ${ssTo}`);
  else if (num(f.smartScore) !== null && num(f.aiScore) !== null)
    parts.push(`Smart Score ${f.smartScore}, AI ${f.aiScore}`);

  const up = num(f.upside) ?? num(f.upsideTo);
  const pt = num(f.priceTarget);
  if (up !== null) parts.push(pt !== null ? `${up}% to $${pt}` : `${up}%`);

  const an = num(f.analysts);
  if (an !== null) parts.push(`${an} analyst${an === 1 ? "" : "s"}`);

  return [post?.name, ...parts].filter(Boolean).join(" · ");
}

function PostArt({ post }: { post: Post }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const redraw = () => paint(cv, post.sector, post.ticker);
    redraw();
    // The card is fluid, and the first paint can land before layout has a width.
    const ro = new ResizeObserver(redraw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [post.sector, post.ticker]);

  return <canvas ref={ref} className="feed-art" aria-hidden="true" />;
}

export function PostFeed() {
  const items = sortNewestFirst(posts as Post[]);

  if (!items.length) {
    return (
      <div className="feed-empty">
        <p>No posts yet.</p>
        <p className="feed-empty-sub">The next data refresh writes one.</p>
      </div>
    );
  }

  return (
    <ul className="feed">
      {items.map((p) => (
        <li key={p.id} className={`feed-card k-${p.kind}`}>
          <div className="feed-card-head">
            <span className="feed-kind">{p.kind}</span>
            <time className="feed-stamp" dateTime={p.ts}>{formatStamp(p.ts)}</time>
          </div>
          <h3 className="feed-hook">{p.text}</h3>
          <PostArt post={p} />
          <p className="feed-support">{supportLine(p)}</p>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: `src/postfeed.check.ts` PASS, printing
`postfeed OK — dd/mm HH:mm local stamp, newest-first ordering, derived support line`

- [ ] **Step 5: Add the styles**

Append to the **end** of `src/index.css`. Everything is token-driven so both themes work with
no extra rules, and the three kind accents are set on the card so children inherit them:

```css
/* ---------------------------------------------------------------- feed --
   Layout 01, single stream: one post per row, newest first. Kind accent is set
   on the card and read by the pill; art is drawn by src/postArt.ts. */
.feed { list-style: none; margin: 0; padding: 0; }

.feed-card { --acc: var(--gold); padding: 14px 13px 15px; border-bottom: 1px solid var(--t-line-2); }
.feed-card.k-contrarian { --acc: var(--amber); }
.feed-card.k-surprise   { --acc: var(--green); }
.feed-card.k-movement   { --acc: var(--teal); }

.feed-card-head { display: flex; align-items: center; gap: 8px; }

.feed-kind {
  font-size: 9px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
  padding: 3px 7px; border-radius: 4px; color: var(--acc);
  background: color-mix(in srgb, var(--acc) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--acc) 26%, transparent);
}

.feed-stamp {
  margin-left: auto; font-size: 11px; color: var(--faint);
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum";
}

.feed-hook {
  margin: 10px 0 0; font-size: 19px; line-height: 1.14; font-weight: 700;
  letter-spacing: -.028em; color: var(--ink); text-wrap: balance;
}

/* The canvas is sized by CSS; postArt.ts reads clientWidth/clientHeight and matches the
   backing store to devicePixelRatio, so it stays sharp without a fixed pixel size here. */
.feed-art {
  display: block; width: 100%; aspect-ratio: 4 / 3; margin-top: 10px;
  border-radius: 10px; background: #0a1018;
}

.feed-support { margin: 9px 0 0; font-size: 12px; line-height: 1.4; color: var(--muted); }

.feed-empty { padding: 48px 20px; text-align: center; color: var(--muted); }
.feed-empty p { margin: 0; font-size: 14px; }
.feed-empty-sub { margin-top: 5px !important; font-size: 12px; color: var(--faint); }

@media (prefers-reduced-motion: reduce) { .feed-card { transition: none; } }
```

- [ ] **Step 6: Mount it behind the flag**

In `src/components/NavMenu.tsx`, extend the union on line 3:

```ts
export type NavId = "table" | "best" | "new" | "watch" | "feed";
```

`ICON` is typed `Record<NavId, ReactNode>`, so `tsc` now demands a `feed` entry. Add one in the
same shape as its neighbours — they all carry explicit `width="21" height="21"`:

```tsx
  feed: (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 11a9 9 0 0 1 9 9" />
      <path d="M4 4a16 16 0 0 1 16 16" />
      <circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
```

Replace `ITEMS` (line 36) so the Feed entry exists only when the flag is on. It is computed
once at module load, not per render — a flag cannot change without a reload anyway:

```ts
import { flagOn } from "../featureFlags";

const ITEMS: { id: NavId; label: string }[] = [
  { id: "table", label: "Stocks" },
  { id: "best", label: "Best" },
  { id: "new", label: "New" },
  { id: "watch", label: "Watchlist" },
  // Hidden until `?ff=feed`. Off for everyone by default.
  ...(flagOn("feed") ? [{ id: "feed" as NavId, label: "Feed" }] : []),
];
```

In `src/App.tsx`, import the component beside the other component imports:

```ts
import { PostFeed } from "./components/PostFeed";
```

and add a branch to the `nav ===` chain (~line 454), between the `new` branch and the final
`Watchlist` fallback:

```tsx
      ) : nav === "feed" ? (
        FEED_ON ? <PostFeed /> : null
```

and read the flag once, next to the other module-level constants near the top of `App.tsx`:

```ts
const FEED_ON = flagOn("feed");
```

with `flagOn` imported alongside the component:

```ts
import { flagOn } from "./featureFlags";
```

`nav` defaults to `"table"` and the NavMenu item does not exist with the flag off, so this
branch is already unreachable for a normal visitor. The guard is deliberate belt-and-braces:
it means **no path through the app renders the feed without the flag**, whatever a future
change does to how `nav` is set. Two redundant checks, both one line.

- [ ] **Step 7: Verify both states**

Run: `npm run build`
Expected: `tsc` clean, Vite build succeeds.

Seed the feed so there is something to look at (`posts.json` is `[]` until the first CI run):

```bash
POST_PROVIDER=stub POSTS_PER_RUN=6 node ci/generate-posts.mjs
npm run dev
```

Then check, in order:
- `http://localhost:5173/` — bottom nav shows **four** items, no Feed.
- `http://localhost:5173/?ff=feed` — a fifth **Feed** item appears; open it.
- Newest post is at the top; each stamp reads `dd/mm HH:mm` **in your own timezone**.
- Every card has art, and a card's art does not change when you resize the window.
- Reload plain `http://localhost:5173/` — Feed is still there (it persisted).
- `http://localhost:5173/?ff=-feed` — it is gone again.
- Toggle the OS to dark mode — hook, stamp and support line all stay legible.

Throw the stub posts away before committing:

```bash
git checkout src/data/posts.json
```

- [ ] **Step 8: Commit**

```bash
git add src/components/PostFeed.tsx src/postfeed.check.ts src/index.css \
        src/components/NavMenu.tsx src/App.tsx
git commit -m "feat: single-stream post feed behind the feed flag"
```

## Before the first live run

- [ ] Create a Cloudflare account (free). Copy the **Account ID** from the dashboard URL.
- [ ] Create an API token with the **Workers AI → Read** permission.
- [ ] Run the connectivity curl from Task 0 → "Still unproven". This is the one thing the spike could not verify.
- [ ] Add both as repo secrets: `CF_ACCOUNT_ID`, `CF_API_TOKEN`.
- [ ] Trigger **Actions → Refresh data & deploy → Run workflow** and read the "Generate social post" step's log. It prints the candidate count and the winning score per hook, so a weak model shows up immediately as "none publishable".
- [ ] Read the first ~10 posts by hand. If they read as machine-written, the fix is `ci/style-corpus.json` (better exemplars) or `POST_PROVIDER: anthropic` — not prompt tinkering.

## Deliberately out of scope

Each is a follow-up plan, built on top of what this one ships:

- **Images.** Cloudflare Flux Schnell on the same free quota (~58 neurons/image, ~3% of the daily budget at this cadence). Abstract/editorial prompts only — image models render fake numbers and garbled tickers, so no chart or figure ever goes through one.
- **Scraped style corpus.** A weekly workflow pulling high-engagement StockTwits posts into `ci/style-corpus.json`, replacing the hand-written exemplars. Bigger quality win than any prompt change.
- **Cross-posting.** The feed file is the interface; a publisher reads `src/data/posts.json` and pushes to X/LinkedIn.
