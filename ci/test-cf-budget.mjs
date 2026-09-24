// Checks ci/cf-budget.mjs — the shared "is today's free Cloudflare allocation gone" flag.
// No network anywhere in this file: `markExhausted`/`isExhausted` are pure process state, and
// `isExhaustionError` is pure string/property inspection.

import assert from "node:assert";
import {
  CF_DAILY_ALLOCATION_EXHAUSTED_CODE, isExhausted, isExhaustionError, markExhausted, resetForTest,
} from "./cf-budget.mjs";

assert.equal(CF_DAILY_ALLOCATION_EXHAUSTED_CODE, 4006, "the exact documented Cloudflare code this module watches for");

// --- isExhaustionError ------------------------------------------------------------
assert.equal(isExhaustionError({ cfCode: 4006 }), true, "an error carrying the exact cfCode is recognised");
assert.equal(isExhaustionError({ cfCode: 4029 }), false, "a DIFFERENT Cloudflare error code is not mistaken for exhaustion");
assert.equal(isExhaustionError(new Error("cloudflare 429")), false,
  "a generic 429 with no code attached is not assumed to be exhaustion");
assert.equal(isExhaustionError(new Error("cloudflare 429 (code 4006)")), true,
  "the code appearing in the message text is still recognised as a fallback");
assert.equal(isExhaustionError(null), false, "a null/undefined error never throws and is never exhaustion");
assert.equal(isExhaustionError(undefined), false, "same for undefined");

// --- markExhausted / isExhausted: idempotent, one line only -----------------------
resetForTest();
assert.equal(isExhausted(), false, "starts un-exhausted (after a reset)");

let logs = [];
const realError = console.error;
console.error = (...args) => logs.push(args.join(" "));
try {
  markExhausted();
  markExhausted();
  markExhausted();
} finally {
  console.error = realError;
}
assert.equal(isExhausted(), true, "the flag flips permanently (for this process) on the first call");
assert.equal(logs.length, 1, "three calls to markExhausted print exactly ONE line, not three");
assert.ok(/4006/.test(logs[0]), "the printed line names the real error code");
assert.ok(/daily free allocation/i.test(logs[0]), "the printed line names the real cause in plain English");
assert.ok(/ending this run/i.test(logs[0]), "the printed line says the run is ending, per the brief");

resetForTest();
assert.equal(isExhausted(), false, "resetForTest fully restores a clean slate");

console.log("cf-budget OK — exact-code detection (not a generic 429), and markExhausted is idempotent (one line, not five)");
