// Dependency-free self-check for theme options in the Sector filter (lib.ts + data/themes.json).
// What this guards: a theme option must match its classified members (which sit in OTHER
// sectors), a plain sector must still match by `sec`, "exclude" must invert both, and a theme
// with no members yet must not be offered as an option that empties the table.
// Run:
//   npx tsc src/lib.ts src/themes.check.ts --outDir /tmp/th \
//     --module commonjs --target es2020 --lib es2020,dom --resolveJsonModule \
//     --esModuleInterop --skipLibCheck \
//   && node /tmp/th/themes.check.js
import { inSector, passes, themeNames } from "./lib";
import themesData from "./data/themes.json";
import type { Stock } from "./types";

let n = 0;
function ok(c: boolean, what: string): void {
  n++;
  if (!c) throw new Error(what);
}

const row = (t: string, sec: string): Stock => ({ t, n: t, sec } as unknown as Stock);
const base = { q: "", sectorNot: false, consensuses: [], cap: 0 };

ok(inSector(row("AAA", "Technology"), "Technology"), "plain sector still matches");
ok(!inSector(row("AAA", "Technology"), "Healthcare"), "other sector does not");

const themes = themesData as Record<string, string[]>;
for (const [name, members] of Object.entries(themes)) {
  ok(themeNames.includes(name) === members.length > 0, `${name}: offered only once it has members`);
  for (const t of members) {
    const r = row(t, "General");
    ok(inSector(r, name), `${t} matches ${name}`);
    ok(passes(r, { ...base, sectors: [name] } as never), `${t} kept by ${name}`);
    ok(!passes(r, { ...base, sectors: [name], sectorNot: true } as never), `${t} dropped by NOT ${name}`);
  }
  ok(!inSector(row("NOT-A-MEMBER", "General"), name), `${name}: non-member excluded`);
}
ok(passes(row("AAA", "Technology"), { ...base, sectors: ["Technology", "Healthcare"] } as never), "multi-select is OR");

console.log(`themes.check: all ${n} passed`);
