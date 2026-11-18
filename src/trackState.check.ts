// Dependency-free self-check for trackState.ts (mirrors fmtPx.check.ts). Run: npm test
import { noAnalystCoverage, trackStateOf } from "./trackState";

let failed = 0;
function eq(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) { failed++; console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}

eq("no request", trackStateOf(null), "none");
eq("pending", trackStateOf({ tracked: false }), "pending");
eq("tracked", trackStateOf({ tracked: true }), "tracked");
eq("pending + err = failed", trackStateOf({ tracked: false, err: { at: 1, msg: "fetch failed" } }), "failed");
eq("tracked wins over a stale err", trackStateOf({ tracked: true, err: { at: 1, msg: "fetch failed" } }), "tracked");

eq("all null", noAnalystCoverage({ con: null, pt: null, ai: null }), true);
eq("NNNN shape: Neutral 0/0/0, no pt, no ai", noAnalystCoverage({ con: "Neutral", b: 0, h: 0, s: 0, pt: null, ai: null }), true);
eq("a real consensus count is coverage", noAnalystCoverage({ con: "Buy", b: 3, h: 1, s: 0, pt: null, ai: null }), false);
eq("a price target is coverage", noAnalystCoverage({ con: null, pt: 5, ai: null }), false);
eq("an AI score is coverage", noAnalystCoverage({ con: null, pt: null, ai: 70 }), false);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("trackState: ok");
