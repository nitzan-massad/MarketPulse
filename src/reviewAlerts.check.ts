// Dependency-free self-check for the review diff. No test framework by design.
// Run:
//   npx tsc src/reviewAlerts.ts src/reviewAlerts.check.ts --outDir /tmp/ra \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/ra/reviewAlerts.check.js
import { allReviewKeys, newReviewKeys, reviewKey, type ReviewLike } from "./reviewAlerts";

let failed = 0;
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.error(`FAIL ${label}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const mk = (n: string, d: string, pt: number, r = "Buy", f = "Firm"): ReviewLike => ({ n, f, d, r, pt });

eq("stable key", reviewKey(mk("Ann", "2026-07-25", 340)), "Ann|Firm|2026-07-25|Buy|340");
eq("re-issue on a new date is a different key",
  reviewKey(mk("Ann", "2026-07-25", 340)) === reviewKey(mk("Ann", "2026-07-20", 340)), false);
eq("changed target is a different key",
  reviewKey(mk("Ann", "2026-07-25", 340)) === reviewKey(mk("Ann", "2026-07-25", 360)), false);

const cur = [mk("Ann", "2026-07-25", 340), mk("Bob", "2026-07-25", 300), mk("Cy", "2026-07-18", 315)];
const seen = [reviewKey(mk("Cy", "2026-07-18", 315))];
eq("only unseen returned", newReviewKeys(cur, seen), [reviewKey(cur[0]), reviewKey(cur[1])]);
eq("all seen -> none new", newReviewKeys(cur, allReviewKeys(cur)), []);
eq("empty seen sees all (baseline)", newReviewKeys(cur, []).length, 3);
eq("duplicate rows collapse to one key", newReviewKeys([mk("Ann", "2026-07-25", 340), mk("Ann", "2026-07-25", 340)], []).length, 1);

if (failed) throw new Error(`${failed} reviewAlerts check(s) failed`);
console.log("\nall reviewAlerts checks passed");
