// Dependency-free self-check for the search's keyboard navigation. No test framework by
// design (mirrors alertEngine.check.ts). What this guards:
//   1. the wrap arithmetic — the classic off-by-one, and the -1 "nothing highlighted"
//      state that every fresh query starts in
//   2. arrowing on an empty result list never selecting a row that isn't rendered
//   3. the three result sources flattening into ONE list in render order, so the index
//      the arrows produce addresses the row the user actually sees
// Run:
//   npx tsc src/searchNav.ts src/searchNav.check.ts --outDir /tmp/sn \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/sn/searchNav.check.js
import { buildOptions, nextIndex } from "./searchNav";
import type { Stock } from "./types";

let n = 0;
function eq(label: string, got: unknown, want: unknown): void {
  n++;
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`FAIL ${label}: got ${g}, want ${w}`);
}

const stock = (t: string) => ({ t, n: t + " Inc" }) as Stock;

// ---- 1. wrap arithmetic ---------------------------------------------------
eq("first ArrowDown from nothing lands on the first row", nextIndex(-1, 5, 1), 0);
eq("first ArrowUp from nothing lands on the last row", nextIndex(-1, 5, -1), 4);
eq("down steps forward", nextIndex(0, 5, 1), 1);
eq("up steps back", nextIndex(3, 5, -1), 2);
eq("down past the end wraps to the top", nextIndex(4, 5, 1), 0);
eq("up past the top wraps to the end", nextIndex(0, 5, -1), 4);
eq("a single row wraps to itself going down", nextIndex(0, 1, 1), 0);
eq("a single row wraps to itself going up", nextIndex(0, 1, -1), 0);

// ---- 2. nothing to select -------------------------------------------------
// "No matches" is a div, not an option — arrowing must not produce an index for it.
eq("ArrowDown on an empty list selects nothing", nextIndex(-1, 0, 1), -1);
eq("ArrowUp on an empty list selects nothing", nextIndex(-1, 0, -1), -1);
eq("a stale index on a now-empty list still resolves to nothing", nextIndex(3, 0, 1), -1);

// ---- 3. the three sources flatten in render order --------------------------
const ranked = [stock("AMAT"), stock("AMZN")];
const remote = [{ t: "ARMK", n: "Aramark" }, { t: "AKAM", n: "Akamai" }];

const all = buildOptions(ranked, remote, null);
eq("ranked first, then remote", all.map((o) => o.key), ["s:AMAT", "s:AMZN", "r:ARMK", "r:AKAM"]);
eq("length is the sum of the sources", all.length, 4);
eq("a ranked row carries its stock", all[0].kind === "stock" && all[0].stock.t, "AMAT");
eq("a remote row carries its ticker", all[2].kind === "ticker" && all[2].ticker, "ARMK");

// The raw-ticker guess is a FALLBACK: it renders only when the lookup found nothing, and
// arrowing must match that, or the last index would point past the rendered rows.
eq("the raw-ticker guess is suppressed while remote rows exist",
  buildOptions(ranked, remote, "AMA").map((o) => o.key),
  ["s:AMAT", "s:AMZN", "r:ARMK", "r:AKAM"]);
eq("…and appears when there are none",
  buildOptions(ranked, [], "AMA").map((o) => o.key),
  ["s:AMAT", "s:AMZN", "o:AMA"]);
eq("a query with no matches at all yields no options", buildOptions([], [], null).length, 0);
eq("keys are unique, so React rows never collide",
  new Set(buildOptions(ranked, remote, null).map((o) => o.key)).size, 4);

// Walking down from "nothing highlighted" reaches the last row after `length` presses —
// the first press spends itself entering the list rather than stepping within it — and
// one more press wraps to the top.
const opts = buildOptions(ranked, remote, null);
let i = -1;
for (let k = 0; k < opts.length; k++) i = nextIndex(i, opts.length, 1);
eq("pressing down `length` times from nothing lands on the last row", i, opts.length - 1);
eq("one more press wraps to the first", nextIndex(i, opts.length, 1), 0);

// and the same walk upward is symmetric
let j = -1;
for (let k = 0; k < opts.length; k++) j = nextIndex(j, opts.length, -1);
eq("pressing up `length` times from nothing lands on the first row", j, 0);
eq("one more press wraps to the last", nextIndex(j, opts.length, -1), opts.length - 1);

console.log(`searchNav.check OK — ${n} assertions`);
