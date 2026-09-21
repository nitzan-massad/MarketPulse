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
