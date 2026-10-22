// Dependency-free self-check for trackedRows.ts — the merge of lite-run RTDB rows over the bundle.
//
// What this guards:
//   1. The bundle wins. A ticker that is already in stocks.json must never be duplicated or
//      replaced by its (older, about-to-be-cleared) trackedRows copy.
//   2. Explicit nulls survive. Payloads travel as JSON text precisely so `ss: null` / `con: null`
//      reach the UI as null (renders "—"), not as a dropped key.
//   3. Junk is ignored, never thrown on: the page must render from the bundle regardless.
//
// Run:
//   npx tsc src/trackedRows.ts src/trackedRows.check.ts --outDir /tmp/tr \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/tr/trackedRows.check.js
import { mergeTracked, parseTracked } from "./trackedRows";
import type { Stock } from "./types";

let fails = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) {
    fails++;
    console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`);
  }
}

const row = (t: string, extra: Partial<Stock> = {}) => ({ t, n: t, ss: null, con: null, ...extra }) as unknown as Stock;
const bundle = [row("AAPL", { ss: 9 })];
const BUNDLED = new Set(bundle.map((s) => s.t));
const entry = (r: unknown, more: Record<string, unknown> = {}) => ({ row: JSON.stringify(r), forecast: null, bullbear: null, pe: null, asOf: "x", ...more });

const tracked = parseTracked(
  {
    BRK_B: entry(row("BRK.B"), { forecast: '[{"pt":1}]', pe: '{"asOf":"d","pts":[]}' }),
    AAPL: entry(row("AAPL", { ss: 1 })), // bundled → skipped
    BAD: { row: "{" }, // unparseable
    OTHER: entry(row("NVDA")), // names another ticker
    NUL: null,
  },
  BUNDLED,
);
eq("keys", [...tracked.keys()], ["BRK.B"]);
eq("nulls kept", tracked.get("BRK.B")!.row.ss, null);
eq("forecast parsed", tracked.get("BRK.B")!.forecast, [{ pt: 1 }]);
eq("missing payload is null", tracked.get("BRK.B")!.bullbear, null);
eq("pe parsed", tracked.get("BRK.B")!.pe, { asOf: "d", pts: [] });

const merged = mergeTracked(bundle, tracked);
eq("merged order", merged.map((s) => s.t), ["AAPL", "BRK.B"]);
eq("bundled row wins", merged[0].ss, 9);
eq("empty merge keeps identity", mergeTracked(bundle, new Map()) === bundle, true);
eq("null snapshot", parseTracked(null, BUNDLED).size, 0);
eq("non-object snapshot", parseTracked("x", BUNDLED).size, 0);

if (fails) throw new Error(`${fails} trackedRows check(s) failed`);
console.log("trackedRows: ok");
