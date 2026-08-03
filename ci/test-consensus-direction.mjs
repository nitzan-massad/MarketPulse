// Self-check for the analyst-consensus upgrade/downgrade direction (src/consensus.ts),
// used by the "Changes" column in src/components/NewArrivals.tsx.
//
// The bug this guards against: the rank map keyed "Hold", but the pipeline only ever
// emits "Neutral" (ci/keep.mjs:50 CON_NAME) — across the whole history of
// src/data/stocks.json the only values are Buy, Neutral, StrongBuy and null, never Hold.
// So CONS_RANK["Neutral"] was undefined, coerced to 0, and Neutral → Sell /
// Neutral → StrongSell were rendered as a GREEN "up" badge: a downgrade shown as an
// upgrade. Buy → Neutral and Neutral → Buy came out right by luck, which hid it.
//
// Run: node ci/test-consensus-direction.mjs   (needs Node >= 22.18 / 23 for .ts imports)
import assert from "node:assert/strict";
import { consDir, consRank } from "../src/consensus.ts";

// --- THE REGRESSION: every downgrade out of Neutral must read as a downgrade ------
assert.equal(consDir("Neutral", "Sell"), "down", "Neutral → Sell is a downgrade");
assert.equal(consDir("Neutral", "StrongSell"), "down", "Neutral → StrongSell is a downgrade");

// --- the two that accidentally worked before, and must keep working --------------
assert.equal(consDir("Buy", "Neutral"), "down", "Buy → Neutral is a downgrade");
assert.equal(consDir("Neutral", "Buy"), "up", "Neutral → Buy is an upgrade");

// --- the rest of the ladder (CON_NAME 1..5 in ci/keep.mjs) -----------------------
assert.equal(consDir("StrongBuy", "Buy"), "down", "StrongBuy → Buy is a downgrade");
assert.equal(consDir("Buy", "StrongBuy"), "up");
assert.equal(consDir("StrongSell", "Sell"), "up");
assert.equal(consDir("Sell", "StrongSell"), "down");
// the mirror image of the reported bug: the old map also called these two backwards
assert.equal(consDir("Sell", "Neutral"), "up", "Sell → Neutral is an upgrade");
assert.equal(consDir("StrongSell", "Neutral"), "up", "StrongSell → Neutral is an upgrade");
assert.equal(consDir("StrongSell", "StrongBuy"), "up");
assert.equal(consDir("StrongBuy", "StrongSell"), "down");

// --- "Hold" is kept as a synonym of "Neutral", not a separate rung ---------------
assert.equal(consRank("Hold"), consRank("Neutral"), "Hold and Neutral rank the same");
assert.equal(consDir("Hold", "Sell"), "down", "a passthrough 'Hold' must still downgrade");
assert.equal(consDir("Buy", "Hold"), "down");
assert.equal(consDir("Neutral", "Hold"), null, "same rank → no direction, not a green arrow");

// --- fail safe: an unknown label must NOT produce a confident arrow --------------
for (const unknown of ["Moderate Buy", "ModerateSell", "Overweight", "", "3", "Sideways"]) {
  assert.equal(consDir("Buy", unknown), null, `unknown "${unknown}" as new value → no direction`);
  assert.equal(consDir(unknown, "Buy"), null, `unknown "${unknown}" as old value → no direction`);
  assert.equal(consRank(unknown), null, `unknown "${unknown}" has no rank`);
}

// --- null/undefined (con is nullable in the data: AMTX, NXXT, SNES, CBUS, BEAT) ---
for (const missing of [null, undefined]) {
  assert.equal(consDir(missing, "StrongSell"), null, "missing old value → no direction");
  assert.equal(consDir("StrongBuy", missing), null, "missing new value → no direction");
  assert.equal(consDir(missing, missing), null, "both missing → no direction");
  assert.equal(consRank(missing), null);
}

// --- label spelling is normalised the way ci/keep.mjs normalises sectors ---------
assert.equal(consDir("Strong Buy", "buy"), "down", "spaces/case must not break the rank lookup");
assert.equal(consRank("strongsell"), consRank("StrongSell"));

// --- the vocabulary this file claims to cover is the one the pipeline emits ------
// (guard: if ci/keep.mjs ever grows a new CON_NAME label, this test fails loudly)
const keep = await import("node:fs").then((fs) => fs.readFileSync(new URL("./keep.mjs", import.meta.url), "utf8"));
const conName = keep.match(/const CON_NAME = \{([^}]*)\}/);
assert.ok(conName, "could not find CON_NAME in ci/keep.mjs — re-point this check");
const labels = [...conName[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
assert.deepEqual(labels.slice().sort(), ["Buy", "Neutral", "Sell", "StrongBuy", "StrongSell"].sort(),
  "ci/keep.mjs CON_NAME changed — every label it emits needs a rank in src/consensus.ts");
for (const l of labels) assert.notEqual(consRank(l), null, `pipeline label "${l}" must be ranked`);

console.log("consensus direction: ok");
