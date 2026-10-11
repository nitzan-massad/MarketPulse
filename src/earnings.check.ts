// Dependency-free self-check for the next-earnings logic (mirrors feargreed.check.ts).
// Run:
//   npx tsc src/earnings.ts src/earnings.check.ts --outDir /tmp/ec \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/ec/earnings.check.js
import { earningsParts, fromEntry } from "./earnings";

function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// file entries: a past date (the file can be a day old) or a malformed one shows nothing
eq(fromEntry(["2026-11-05", "amc"], "2026-10-11"), { date: "2026-11-05", hour: "amc" }, "upcoming");
eq(fromEntry(["2026-11-05", "amc"], "2026-11-05"), { date: "2026-11-05", hour: "amc" }, "report day still counts");
eq(fromEntry(["2026-10-10", "bmo"], "2026-10-11"), null, "already reported");
eq(fromEntry(undefined, "2026-10-11"), null, "not in the file");
eq(fromEntry(["soon"], "2026-10-11"), null, "malformed");

eq(earningsParts({ date: "2026-11-05", hour: "amc" }, "2026-10-11"), { mon: "NOV", day: "5", text: "Thu · after close · in 25 days" }, "WYNN");
eq(earningsParts({ date: "2026-10-12", hour: "bmo" }, "2026-10-11").text, "Mon · before open · tomorrow", "tomorrow");
eq(earningsParts({ date: "2026-10-11", hour: "" }, "2026-10-11").text, "Sun · today", "today, unknown hour");
// crosses the March DST change without drifting a day
eq(earningsParts({ date: "2027-03-20", hour: "" }, "2027-03-01").text, "Sat · in 19 days", "across DST");

console.log("earnings.check: all passed");
