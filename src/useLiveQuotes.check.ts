// Dependency-free self-check for the pure bits of the live-quote hook: the 429
// backoff parse, client-side Day% computation, the live-subscription set
// (watchlist ∪ visible, capped), and the subscribe/unsubscribe delta. No test
// framework by design (mirrors alertEngine.check.ts).
//
// Run (from repo root; the check only touches the pure exports, but tsc still
// type-checks the hook's React import, hence --jsx + the DOM lib):
//   npx tsc src/useLiveQuotes.ts src/useLiveQuotes.check.ts --outDir /tmp/ulq \
//     --module commonjs --target es2020 --lib es2020,dom --jsx react --skipLibCheck \
//   && NODE_PATH=node_modules node /tmp/ulq/useLiveQuotes.check.js
import { backoffMsFromHeader, dayPct, diffSubs, liveSymbols } from "./useLiveQuotes";

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

// --- backoffMsFromHeader (BACKOFF_MS=2000, MAX_BACKOFF_MS=15000) --------------
eq("no header → fixed backoff", backoffMsFromHeader(null), 2000);
eq("integer seconds honored", backoffMsFromHeader("5"), 5000);
eq("seconds with junk suffix parses leading int", backoffMsFromHeader("7abc"), 7000);
eq("non-numeric → fixed backoff", backoffMsFromHeader("soon"), 2000);
eq("zero → fixed backoff", backoffMsFromHeader("0"), 2000);
eq("negative → fixed backoff", backoffMsFromHeader("-3"), 2000);
eq("huge value clamped", backoffMsFromHeader("99999"), 15000);

// --- dayPct: ((p - prevClose) / prevClose) * 100 ------------------------------
eq("flat day → 0%", dayPct(100, 100), 0);
eq("up 5%", dayPct(105, 100), 5);
eq("down 2%", dayPct(98, 100), -2);
eq("non-round baseline", dayPct(200, 160), 25);
eq("missing prevClose → null", dayPct(105, 0), null);
eq("negative prevClose → null", dayPct(105, -1), null);
eq("NaN price → null", dayPct(NaN, 100), null);

// --- liveSymbols: watchlist first, then visible, deduped, capped --------------
eq("union dedupes across sets", liveSymbols(["AAPL", "MSFT"], ["MSFT", "TSLA"]), [
  "AAPL",
  "MSFT",
  "TSLA",
]);
eq("empty watchlist → visible only", liveSymbols([], ["TSLA", "NVDA"]), ["TSLA", "NVDA"]);
eq("empty visible → watchlist only", liveSymbols(["AAPL"], []), ["AAPL"]);
eq("watchlist wins the cap, visible tail dropped", liveSymbols(["A", "B", "C"], ["D", "E"], 4), [
  "A",
  "B",
  "C",
  "D",
]);
eq("watchlist alone can fill the cap", liveSymbols(["A", "B", "C"], ["D"], 2), ["A", "B"]);
eq("visible symbol already watched isn't double-counted at the cap", liveSymbols(["A", "B"], ["A", "C"], 3), [
  "A",
  "B",
  "C",
]);

// --- diffSubs: only the delta, never the whole set ----------------------------
eq("added + removed", diffSubs(["AAPL", "MSFT"], ["MSFT", "TSLA"]), {
  add: ["TSLA"],
  remove: ["AAPL"],
});
eq("no change → empty delta", diffSubs(["AAPL", "MSFT"], ["MSFT", "AAPL"]), {
  add: [],
  remove: [],
});
eq("first subscribe → all add", diffSubs([], ["AAPL", "MSFT"]), {
  add: ["AAPL", "MSFT"],
  remove: [],
});
eq("clear all → all remove", diffSubs(["AAPL", "MSFT"], []), {
  add: [],
  remove: ["AAPL", "MSFT"],
});

if (failed) throw new Error(`${failed} useLiveQuotes check(s) failed`);
console.log("\nall useLiveQuotes checks passed");
