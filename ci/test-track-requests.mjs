// Guards ci/track-requests.mjs: which requests get pinned, and which get marked tracked.
import assert from "node:assert/strict";
import { planFetch, planMarks, planPins } from "./track-requests.mjs";

const req = (ts, tracked = false) => ({ uid: "u", ts, tracked });

// oldest first, skips already-pinned and tracked, decodes BRK_B, drops junk keys
assert.deepEqual(
  planPins({ NVDA: req(3), BRK_B: req(1), AAPL: req(2), DONE: req(0, true), "bad key": req(0) }, ["AAPL"]),
  ["BRK.B", "NVDA"],
);
// the per-run cap holds
assert.equal(planPins(Object.fromEntries([...Array(30)].map((_, i) => [`T${i}`, req(i)])), []).length, 20);
assert.deepEqual(planPins(null, []), []);

// only pending requests whose ticker now has a row get marked
assert.deepEqual(planMarks({ BRK_B: req(1), NVDA: req(2), OLD: req(0, true) }, ["BRK.B", "OLD"], 99), {
  "BRK_B/tracked": true,
  "BRK_B/trackedAt": 99,
});

// fetch only pinned, pending, row-less tickers
assert.deepEqual(planFetch({ BRK_B: req(1), NVDA: req(2), AAPL: req(3), OLD: req(0, true) }, ["BRK.B", "AAPL", "OLD"], ["AAPL"]), ["BRK.B"]);

console.log("track-requests: ok");
