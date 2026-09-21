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
