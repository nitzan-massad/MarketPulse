// Guards ci/track-requests.mjs: which requests get tracked, fetched, marked, cleared, and kept alive.
import assert from "node:assert/strict";
import { planFetch, planKeepalive, planMarks, planTracks, planUnrequest } from "./track-requests.mjs";

const req = (ts, tracked = false) => ({ uid: "u", ts, tracked });
const iso = (ms) => new Date(ms).toISOString();

// oldest first, skips pinned and done, decodes BRK_B, drops junk keys, carries the request date
assert.deepEqual(
  planTracks({ NVDA: req(3), BRK_B: req(1), AAPL: req(2), DONE: req(0, true), "bad key": req(0) }, ["AAPL"], {}),
  [["BRK.B", iso(1)], ["NVDA", iso(3)]],
);
// already tracked with the same date → no rewrite; a newer re-request (after a drop) → new date
assert.deepEqual(planTracks({ NVDA: req(3) }, [], { NVDA: iso(3) }), []);
assert.deepEqual(planTracks({ NVDA: req(9) }, [], { NVDA: iso(3) }), [["NVDA", iso(9)]]);
// the per-run cap holds
assert.equal(planTracks(Object.fromEntries([...Array(30)].map((_, i) => [`T${i}`, req(i)])), [], {}).length, 20);
assert.deepEqual(planTracks(null, [], {}), []);

// only pending requests whose ticker now has a row get marked
assert.deepEqual(planMarks({ BRK_B: req(1), NVDA: req(2), OLD: req(0, true) }, ["BRK.B", "OLD"], 99), {
  "BRK_B/tracked": true,
  "BRK_B/trackedAt": 99,
});

// fetch only tracked, pending, row-less tickers
assert.deepEqual(planFetch({ BRK_B: req(1), NVDA: req(2), AAPL: req(3), OLD: req(0, true) }, ["BRK.B", "AAPL", "OLD"], ["AAPL"]), ["BRK.B"]);

// a done request whose row is gone (expired) is deleted so it can be requested again;
// pending ones and live ones are left alone
assert.deepEqual(planUnrequest({ GONE: req(1, true), LIVE: req(1, true), WAIT: req(1) }, ["LIVE"]), { GONE: null });

// watchlists (object or legacy array) are merged, de-duplicated, sorted, uid-free
assert.deepEqual(
  planKeepalive({ u1: { NVDA: "a", BRK_B: "b" }, u2: ["NVDA", "AMD", "bad key"], u3: null }, { TSM: 5, BAD: "x" }),
  { watched: ["AMD", "BRK.B", "NVDA"], viewed: { TSM: 5 } },
);
assert.deepEqual(planKeepalive(null, null), { watched: [], viewed: {} });

console.log("track-requests: ok");
