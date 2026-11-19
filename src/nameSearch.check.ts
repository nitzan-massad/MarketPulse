// Dependency-free self-check for name search (lib.ts nameMatches, used by Search.tsx and the table
// filter `passes`). What this guards (M7): R3 made `n` the DISPLAY name ("TSMC"), so a search for
// the legal name ("taiwan") stopped finding the row. The legal name rides along in `ln` (only when
// it differs) and is searched, never displayed.
// Run:
//   npx tsc src/lib.ts src/nameSearch.check.ts --outDir /tmp/ns \
//     --module commonjs --target es2020 --lib es2020,dom --resolveJsonModule \
//     --esModuleInterop --skipLibCheck \
//   && node /tmp/ns/nameSearch.check.js
import { nameMatches, passes } from "./lib";
import type { Stock } from "./types";

let n = 0;
function ok(c: boolean, what: string): void {
  n++;
  if (!c) throw new Error(what);
}

const tsm = { t: "TSM", n: "TSMC", ln: "Taiwan Semiconductor Manufacturing Company Limited", sec: "Technology" } as unknown as Stock;
const aapl = { t: "AAPL", n: "Apple", ln: null, sec: "Technology" } as unknown as Stock;
const old = { t: "OLD", n: "Old Row Inc", sec: "Technology" } as unknown as Stock; // written before `ln` existed

ok(nameMatches(tsm, "taiwan"), "legal name finds TSM");
ok(nameMatches(tsm, "tsmc"), "display name still finds TSM");
ok(nameMatches(tsm, "tsm"), "ticker still finds TSM");
ok(!nameMatches(tsm, "apple"), "no false hit");
ok(nameMatches(aapl, "appl"), "ln null: ticker/display name as before");
ok(nameMatches(old, "old row"), "a row with no ln key still matches on n");
ok(!nameMatches(old, "taiwan"), "and nothing else");

const base = { sectors: [], sectorNot: false, consensuses: [], cap: 0 };
ok(passes(tsm, { ...base, q: "Taiwan" } as never), "the table filter finds TSM by legal name (case-insensitive)");
ok(!passes(aapl, { ...base, q: "taiwan" } as never), "the table filter drops a non-match");

console.log(`nameSearch: ${n} assertions passed`);
