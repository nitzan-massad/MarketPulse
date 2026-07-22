// Dependency-free self-check for the Finnhub 429 backoff parsing. No test framework
// by design (mirrors alertEngine.check.ts).
// Run (from repo root; NODE_PATH lets the compiled module resolve React's
// import — the check itself only touches the pure backoffMsFromHeader):
//   npx tsc src/useLiveQuotes.ts src/useLiveQuotes.check.ts --outDir /tmp/ulq \
//     --module commonjs --target es2020 --lib es2020,dom --jsx react --skipLibCheck \
//   && NODE_PATH=node_modules node /tmp/ulq/useLiveQuotes.check.js
import { backoffMsFromHeader } from "./useLiveQuotes";

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

// Expected constants mirror useLiveQuotes.ts: BACKOFF_MS=2000, MAX_BACKOFF_MS=15000.
eq("no header → fixed backoff", backoffMsFromHeader(null), 2000);
eq("integer seconds honored", backoffMsFromHeader("5"), 5000);
eq("seconds with junk suffix parses leading int", backoffMsFromHeader("7abc"), 7000);
eq("non-numeric → fixed backoff", backoffMsFromHeader("soon"), 2000);
eq("zero → fixed backoff", backoffMsFromHeader("0"), 2000);
eq("negative → fixed backoff", backoffMsFromHeader("-3"), 2000);
eq("huge value clamped", backoffMsFromHeader("99999"), 15000);

if (failed) throw new Error(`${failed} useLiveQuotes check(s) failed`);
console.log("\nall useLiveQuotes checks passed");
