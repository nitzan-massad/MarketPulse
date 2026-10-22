// Guards ci/track-requests.mjs: which requests get tracked, fetched, marked, cleared, and kept alive.
import assert from "node:assert/strict";
import { planFetch, planFold, planKeepalive, planMarks, planTracks, planUnrequest, seenFor, trackedEntry } from "./track-requests.mjs";

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

// ---- fold: lite-run trackedRows → repo files (site.yml, before pin) ----
const AS = "2026-10-21T10:00:00.000Z";
const T0 = "2026-10-20T00:00:00.000Z";
const brk = { t: "BRK.B", n: "Berkshire", ss: null, ai: 70, con: null, px: 500 };
const entry = trackedEntry(brk, { forecast: '[{"pt":1}]', bullbear: '{"bull":[],"bear":[],"asOf":"2026-10-21"}', pe: null }, T0, AS);
// the row travels as JSON text, so its explicit nulls (data, not gaps) survive RTDB
assert.equal(entry.row, JSON.stringify(brk));
assert.equal(entry.pe, null);
const base = { stocks: [{ t: "AAPL" }], tracked: {}, seen: {}, fcAsOf: { AAPL: T0 }, peIndex: {}, has: () => false };
const f = planFold({ BRK_B: entry }, base);
assert.deepEqual(f.stocks.map((r) => r.t), ["AAPL", "BRK.B"]);
assert.deepEqual(f.stocks[1], brk); // ss: null / con: null intact
assert.deepEqual(f.tracked, { "BRK.B": T0 }); // pin won't re-add it (request is already tracked=true)
assert.deepEqual(f.seen["BRK.B"], seenFor(brk, AS));
assert.deepEqual(f.files, [["public/forecasts/BRK.B.json", '[{"pt":1}]'], ["public/bullbear/BRK.B.json", '{"bull":[],"bear":[],"asOf":"2026-10-21"}']]);
assert.deepEqual(f.fcAsOf, { AAPL: T0, "BRK.B": AS }); // stamped like scrape-forecasts, so staleness still works
assert.deepEqual(f.peIndex, {}); // no P/E payload → no index entry → "updating", retried first
assert.deepEqual(f.folded, { BRK_B: AS });
assert.deepEqual(base.stocks, [{ t: "AAPL" }]); // inputs untouched
// a P/E payload gets its chart file and an ok index entry
assert.deepEqual(planFold({ X: trackedEntry({ t: "X" }, { pe: '{"asOf":"d","pts":[]}' }, T0, AS) }, base).peIndex, { X: { a: AS, ok: true } });
// row already in the repo (site run got it itself): no duplicate, existing files and seen kept,
// a newer tracked date kept — but it still counts as folded so `clear` deletes it
const again = planFold({ BRK_B: entry }, { ...base, stocks: [brk], seen: { "BRK.B": { d: "x" } }, tracked: { "BRK.B": AS }, has: () => true });
assert.equal(again.stocks.length, 1);
assert.deepEqual(again.files, []);
assert.deepEqual(again.seen, { "BRK.B": { d: "x" } });
assert.deepEqual(again.tracked, { "BRK.B": AS });
assert.deepEqual(again.folded, { BRK_B: AS });
// scrape-pe's cache rides along: written for a new ticker, kept if the repo already has one
assert.deepEqual(planFold({ BRK_B: entry }, { ...base, peCache: { BRK_B: "c" } }).files.at(-1), ["ci/cache/pe/BRK.B.json", "c"]);
assert.deepEqual(planFold({ BRK_B: entry }, { ...base, stocks: [brk], has: () => true, hasCache: () => true, peCache: { BRK_B: "c" } }).files, []);
// a ticker new to stocks.json overwrites orphaned files from an earlier tenure
assert.equal(planFold({ BRK_B: entry }, { ...base, has: () => true }).files.length, 2);
// junk (unparseable row, row for another ticker, no asOf) is skipped and never cleared
const junk = planFold({ A: { row: "{", asOf: AS }, B: trackedEntry({ t: "C" }, {}, T0, AS), D: { row: '{"t":"D"}' } }, base);
assert.deepEqual([junk.stocks.length, junk.folded], [1, {}]);
assert.deepEqual(planFold(null, base).folded, {});

console.log("track-requests: ok");
