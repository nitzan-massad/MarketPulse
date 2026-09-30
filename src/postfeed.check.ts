// npx tsc src/postfeed.check.ts --outDir node_modules/.tmp/checks --module commonjs \
//   --target es2020 --lib es2020,dom --jsx react-jsx --esModuleInterop --resolveJsonModule --skipLibCheck
//
// --jsx react-jsx (not classic "react"): PostFeed.tsx has real JSX and, like every other
// component in this repo, imports no "React" binding — it relies on the automatic runtime,
// same as `tsc`'s own tsconfig.json. The classic transform needs "React" in scope for its
// `React.createElement` calls and fails with TS2686 here; ci/run-tests.mjs uses react-jsx too.
// The two pure helpers behind the feed. The component is markup; ordering and the timestamp
// are the parts that can silently go wrong. (There used to be a third — the derived support
// line — but the card no longer renders one at all: text now overlays the art directly, so
// there is nothing left under it to derive or test.)

import { formatStamp, sortNewestFirst, hasGenuineChange, contextSentence } from "./components/PostFeed";

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

// ==================== (3)/(4) hasGenuineChange — mirrors ci/hooks.mjs's own rule ============
// Fixtures use the EXACT fact shapes ci/hooks.mjs's detectHooks() emits for each kind (see
// ci/test-hooks.mjs, which pins the same shapes at the source) — not a hand-rolled guess, so a
// future change to either side's fact keys is caught by drift, not silently ignored.
eq("movement's upsideFrom/upsideTo is a genuine change",
  hasGenuineChange({ upsideFrom: 10, upsideTo: 40, price: 100, analysts: 12 }), true);
eq("record's windowLow/windowHigh is a genuine change",
  hasGenuineChange({ upside: 80, windowLow: 60, windowHigh: 80, snapshots: 30, days: 6.3 }), true);
eq("a Smart Score before/after pair alone is a genuine change",
  hasGenuineChange({ smartScoreFrom: 4, smartScoreTo: 9 }), true);
eq("surprise's bare upside is NOT a genuine change (a standing forecast)",
  hasGenuineChange({ upside: 42, price: 100, priceTarget: 142, analysts: 18, sector: "Technology" }), false);
eq("contrarian's bare smartScore/aiScore is NOT a genuine change (two models, one moment)",
  hasGenuineChange({ smartScore: 9, aiScore: 25, aiRating: "Bearish", bullish: "quant" }), false);
eq("steady's bare smartScore is NOT a genuine change (it fires on the ABSENCE of one)",
  hasGenuineChange({ smartScore: 10, snapshots: 30, days: 6.3, upside: 32 }), false);
eq("newcomer's bare upside is NOT a genuine change (no prior reading to compare against)",
  hasGenuineChange({ seenIn: 10, windowSnapshots: 30, days: 2.1, upside: 70 }), false);
eq("list's leaderUpside is NOT a genuine change (a ranking of standing figures)",
  hasGenuineChange({ members: "A (40% to $10)", count: 3, leader: "A", leaderUpside: 40 }), false);
eq("empty facts is not a genuine change", hasGenuineChange({}), false);

// ==================== (5)/(6) contextSentence — derived, never a bare company name ===========
type PFacts = Record<string, string | number | boolean>;
const mkPost = (kind: string, facts: PFacts, sector = "Technology", name = "Alpha Inc") =>
  ({ id: "AAA-x", ts: "2026-09-30T00:00:00Z", kind, ticker: "AAA", name, sector,
     text: "placeholder", score: 90, reasons: [], facts }) as never;

const KIND_FIXTURES: [string, PFacts][] = [
  ["surprise", { upside: 42, price: 148, priceTarget: 210, consensus: "StrongBuy", analysts: 38, sector: "Technology" }],
  ["contrarian", { smartScore: 9, aiScore: 25, aiRating: "Bearish", consensus: "Hold", upside: 20, price: 90, analysts: 10, bullish: "quant" }],
  ["movement", { upsideFrom: 10, upsideTo: 40, consensusFrom: "Hold", consensusTo: "StrongBuy",
                 price: 100, priceTarget: 140, analysts: 12, sector: "Technology", smartScoreFrom: 4, smartScoreTo: 9 }],
  ["record", { upside: 80, windowLow: 60, windowHigh: 80, snapshots: 30, days: 6.3, price: 210, priceTarget: 260, analysts: 15 }],
  ["steady", { smartScore: 10, snapshots: 30, days: 6.3, upside: 32, consensus: "StrongBuy", analysts: 20 }],
  ["newcomer", { seenIn: 10, windowSnapshots: 30, days: 2.1, upside: 70, consensus: "Buy", analysts: 8, smartScore: 8 }],
  ["list", { members: "Alpha Inc (40% to $10), Beta Co (35% to $20)", count: 2, leader: "Alpha Inc", leaderUpside: 40 }],
];

for (const [kind, facts] of KIND_FIXTURES) {
  const line = contextSentence(mkPost(kind, facts));
  if (!line || line.trim().length < 10) { console.log(`FAIL ${kind}: sentence too short/empty: "${line}"`); failed++; }
  if (line === "Alpha Inc." || line === "Alpha Inc") { console.log(`FAIL ${kind}: degraded to the bare company name`); failed++; }
  if (!/[.]$/.test(line)) { console.log(`FAIL ${kind}: sentence "${line}" does not end with a period`); failed++; }
}

// --- (4) only movement/record's sentence ever says "since"/"over the past" (a timed change) ---
const WHEN_RE = /since the last update|over the past|window low/i;
eq("movement's sentence states when the change happened",
  WHEN_RE.test(contextSentence(mkPost("movement", KIND_FIXTURES[2][1]))), true);
eq("record's sentence states when the change happened",
  WHEN_RE.test(contextSentence(mkPost("record", KIND_FIXTURES[3][1]))), true);
for (const kind of ["surprise", "contrarian", "steady", "newcomer", "list"]) {
  const facts = KIND_FIXTURES.find(([k]) => k === kind)![1];
  eq(`${kind}'s sentence never claims a timed change ("since the last update"/"over the past")`,
    /since the last update|over the past/i.test(contextSentence(mkPost(kind, facts))), false);
}

// --- money is real (fmtPx-formatted), not dropped or left as a raw number --------------------
eq("surprise's sentence carries a real, dollar-formatted price",
  /\$148/.test(contextSentence(mkPost("surprise", KIND_FIXTURES[0][1]))), true);

// --- a kind with no matching branch still never degrades to the bare name (defence in depth) --
{
  const line = contextSentence(mkPost("madeUpKind", { upside: 55, analysts: 9 }));
  eq("an unknown kind with real facts reads them (generic fallback), not the bare name",
    line, "55% upside, 9 analysts covering it.");
}
{
  // ...and with NO usable facts at all, the fallback still names the company IN A SENTENCE,
  // never as a bare, standalone name (the exact failure mode that killed the old supportLine).
  const line = contextSentence(mkPost("madeUpKind", {}));
  eq("an unknown kind with no facts at all still isn't a bare name", line === "Alpha Inc" || line === "Alpha Inc.", false);
  eq("...it reads as a sentence naming the company", line, "Fresh data on Alpha Inc this update.");
}

if (failed) throw new Error(`${failed} check(s) failed`);
console.log("postfeed OK — dd/mm HH:mm local stamp, newest-first ordering, genuine-change " +
            "classification mirroring ci/hooks.mjs, and a derived context sentence for every " +
            "hook kind that never degrades to the bare company name");
