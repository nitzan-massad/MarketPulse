// npx tsc src/postfeed.check.ts --outDir node_modules/.tmp/checks --module commonjs \
//   --target es2020 --lib es2020,dom --jsx react-jsx --esModuleInterop --resolveJsonModule --skipLibCheck
//
// --jsx react-jsx (not classic "react"): PostFeed.tsx has real JSX and, like every other
// component in this repo, imports no "React" binding — it relies on the automatic runtime,
// same as `tsc`'s own tsconfig.json. The classic transform needs "React" in scope for its
// `React.createElement` calls and fails with TS2686 here; ci/run-tests.mjs uses react-jsx too.
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
// One case per hook kind that ci/hooks.mjs actually emits, using the EXACT fact keys
// each rule writes there (not hand-rolled shapes that merely look plausible) — see
// ci/hooks.mjs `detectHooks` for the numbered rule each of these mirrors. This is the
// regression test for a real production bug: supportLine was written against four kinds
// (surprise, contrarian, movement, list) and never revisited when five window kinds
// (record, trend, steady, churn, newcomer) were added later, so those five rendered a
// bare name or near-bare line — the card people see most (list was the top-ranked hook
// on live data) had NO derived line at all.
{
  const post = (kind: string, facts: Record<string, string | number | boolean>, name: string) =>
    ({ kind, name, facts }) as never;

  // One fixture per real hook kind, keyed to the rule number in ci/hooks.mjs `detectHooks`
  // that emits it, using the EXACT fact keys that rule writes (not a hand-rolled shape that
  // merely looks plausible). Each is checked two ways below: the exact resulting line, AND
  // that the line is not bare-name-only — the second is the actual regression assertion,
  // since a wording tweak could still coincidentally break the first without the intent
  // ("state the fact that makes this kind worth posting") being violated.
  const KIND_FIXTURES: [string, Record<string, string | number | boolean>, string, string][] = [
    // 1. SURPRISE — unchanged behaviour (generic reading).
    ["surprise",
      { upside: 42, price: 12.34, priceTarget: 17.5, consensus: "Buy", analysts: 9, sector: "Technology" },
      "Acme",
      "Acme · 42% to $17.5 · 9 analysts"],
    // 2. CONTRARIAN — unchanged behaviour (generic reading).
    ["contrarian",
      { smartScore: 2, aiScore: 70, aiRating: "Strong Buy", consensus: "Hold", upside: 30, price: 20, analysts: 5, bullish: "ai" },
      "Beta Corp",
      "Beta Corp · Smart Score 2, AI 70 · 30% · 5 analysts"],
    // 3. MOVEMENT, with the optional smartScoreFrom/To pair present — unchanged behaviour
    // (generic reading): `upside` is absent on movement facts so it falls through to
    // `upsideTo`, and `priceTarget` IS present here (unlike contrarian/trend).
    ["movement",
      { upsideFrom: 10, upsideTo: 25, consensusFrom: "Hold", consensusTo: "Buy", price: 40,
        priceTarget: 55, analysts: 12, sector: "Industrials", smartScoreFrom: 4, smartScoreTo: 7 },
      "Gamma Inc",
      "Gamma Inc · Smart Score 4 → 7 · 25% to $55 · 12 analysts"],
    // 4. RECORD — NEW branch. Was previously "76.7% to $70.22 · 13 analysts", omitting that
    // this is a window high. Real numbers from the live window that exposed this bug.
    ["record",
      { upside: 76.7, windowLow: 22.4, windowHigh: 76.7, snapshots: 15, days: 3.1, price: 40,
        priceTarget: 70.22, analysts: 13 },
      "Xenon Pharmaceuticals",
      "Xenon Pharmaceuticals · 22.4% → 76.7%, a 3.1-day high · 13 analysts"],
    // 5. TREND — unchanged behaviour (generic reading); was already "OK" before this fix.
    ["trend",
      { smartScoreFrom: 5, smartScoreTo: 2, direction: "down", snapshots: 30, days: 6.3,
        upside: 26.2, consensus: "Buy", analysts: 36 },
      "Datadog Inc",
      "Datadog Inc · Smart Score 5 → 2 · 26.2% · 36 analysts"],
    // 6. STEADY — NEW branch. Was previously "23% · 26 analysts", omitting the streak that
    // makes it worth posting at all.
    ["steady",
      { smartScore: 10, snapshots: 30, days: 6.3, upside: 23, consensus: "Buy", analysts: 26 },
      "Alphabet Inc. Class A",
      "Alphabet Inc. Class A · Smart Score 10 for 6.3 days · 23% upside · 26 analysts"],
    // 7. CHURN — NEW branch. Was previously just "17 analysts", saying nothing about the churn.
    ["churn",
      { distinctScores: 4, low: 6, high: 9, smartScore: 9, snapshots: 30, days: 6.3, analysts: 17 },
      "Conocophillips",
      "Conocophillips · 4 different scores in 6.3 days · 6 to 9 · 17 analysts"],
    // 8. NEWCOMER, with the optional smartScore present — NEW branch. Was previously
    // "49.7% · 7 analysts", omitting that it just arrived.
    ["newcomer",
      { seenIn: 5, windowSnapshots: 30, days: 3.1, upside: 49.7, consensus: "Buy", analysts: 7, smartScore: 6 },
      "United Airlines Holdings, Inc.",
      "United Airlines Holdings, Inc. · New 3.1 days ago · 49.7% upside · 7 analysts"],
    // 9. LIST — NEW branch. Was previously the BARE NAME, no data at all: the worst case,
    // and also the most common (list was the top-ranked hook on live data). `members` is
    // deliberately NOT surfaced (see listLine's comment) — only its count and the leader.
    ["list",
      { members: "IRD (153.7% to $13.14), FRVO (147.8% to $41.91), PRAX (145% to $732.38), VERA (131.3% to $78.63), TNGX (120.7% to $48)",
        count: 5, leader: "IRD", leaderUpside: 153.7 },
      "Opus Genetics",
      "Opus Genetics · 5 names · IRD leads at 153.7%"],
  ];
  for (const [kind, facts, name, want] of KIND_FIXTURES) {
    const line = supportLine(post(kind, facts, name));
    eq(kind, line, want);
    eq(`${kind} is NOT a bare name (has real facts)`, line === name, false);
  }

  // The one case where a bare name IS correct even for a kind with a dedicated branch:
  // genuinely empty facts. Every kind above must NOT degrade to bare-name-only, but an
  // empty facts object always must, whatever the kind.
  eq("genuinely empty facts still degrades to the bare name, even with a real kind",
    supportLine(post("list", {}, "Acme")), "Acme");

  // No kind (or a kind with no dedicated branch) falls back to the generic reading — this
  // is also what a pre-this-fix or hand-edited posts.json row exercises.
  const generic = (facts: Record<string, string | number | boolean>, name = "Netflix") =>
    ({ name, facts }) as never;
  eq("no kind falls back to the generic reading",
    supportLine(generic({ smartScoreFrom: 8, smartScoreTo: 6, analysts: 25 })),
    "Netflix · Smart Score 8 → 6 · 25 analysts");
  eq("unknown kind falls back to the generic reading",
    supportLine(post("some-future-kind", { upside: 20, analysts: 1 }, "Acme")),
    "Acme · 20% · 1 analyst");
  eq("one analyst is singular (generic)", supportLine(generic({ upside: 20, analysts: 1 }, "Acme")),
    "Acme · 20% · 1 analyst");
  eq("no usable facts is just the name", supportLine(generic({}, "Acme")), "Acme");
  eq("missing facts object", supportLine({ name: "Acme" } as never), "Acme");
  eq("missing everything", supportLine({} as never), "");
}

if (failed) throw new Error(`${failed} check(s) failed`);
console.log("postfeed OK — dd/mm HH:mm local stamp, newest-first ordering, derived support line");
