// Backfill planning: which off-pull tickers the full-universe screener pull can serve, and which
// need a per-ticker stock-aianalyst payload. No network.
import assert from "node:assert/strict";
import { universeMap, planBackfill, UNIVERSE_URL } from "./backfill-plan.mjs";

const it = (t, primary, tag) => ({ tradingInformationData: { ticker: t, stockListingIsPrimaryMarket: primary, tag } });

assert.deepEqual(planBackfill(["AAPL", "ACH"], new Map([["AAPL", {}]])), { fromUniverse: ["AAPL"], needPayload: ["ACH"] });
assert.deepEqual(planBackfill(["AAPL", "ACH"], new Map()), { fromUniverse: [], needPayload: ["AAPL", "ACH"] });
assert.deepEqual(planBackfill([], new Map([["A", {}]])), { fromUniverse: [], needPayload: [] });

// duplicates: the primary listing wins, in either order
let m = universeMap([it("X", false, "otc"), it("X", true, "primary"), it("Y", true, "y")]);
assert.equal(m.size, 2);
assert.equal(m.get("X").tradingInformationData.tag, "primary");
m = universeMap([it("X", true, "primary"), it("X", false, "otc")]);
assert.equal(m.get("X").tradingInformationData.tag, "primary");

// B2: duplicates with no primary listing used to keep the FIRST item — possibly another company.
// Now: the item whose name matches last run's row wins; still ambiguous -> skipped (payload/carry).
const named = (t, name, tag, primary = false) => ({ tradingInformationData: { ticker: t, companyName: name, stockListingIsPrimaryMarket: primary, tag } });
let amb = [];
m = universeMap([it("X", false, "first"), it("X", false, "second")], { ambiguous: amb });
console.log("B2 no primary, no prev ->", m.has("X") ? m.get("X").tradingInformationData.tag : "skipped", amb);
assert.equal(m.has("X"), false, "no primary listing and no previous row: never guess");
assert.deepEqual(amb, ["X"], "skipped ticker reported for health()");
amb = [];
const prev = new Map([["ACH", { t: "ACH", n: "Aluminum Corporation of China Limited" }]]);
m = universeMap([named("ACH", "Achieve Holdings", "other"), named("ACH", "Aluminum Corp. of China Ltd", "ours"), named("Z", "Zeta", "z")], { prev, ambiguous: amb });
console.log("B2 no primary, prev name ->", m.get("ACH")?.tradingInformationData.tag, amb);
assert.equal(m.get("ACH").tradingInformationData.tag, "ours", "the listing matching last run's name wins, in any order");
assert.deepEqual(amb, []);
m = universeMap([named("ACH", "Aluminum Corp. of China Ltd", "ours"), named("ACH", "Achieve Holdings", "other")], { prev });
assert.equal(m.get("ACH").tradingInformationData.tag, "ours");
// both names match (same company, two listings) or neither matches -> skipped
amb = [];
m = universeMap([named("ACH", "Aluminum Corp of China", "a"), named("ACH", "Aluminum Corporation of China", "b"), named("Q", "Foo", "q1"), named("Q", "Bar", "q2")],
  { prev: new Map([...prev, ["Q", { t: "Q", n: "Baz Inc" }]]), ambiguous: amb });
assert.equal(m.has("ACH"), false, "two matching names: still ambiguous");
assert.equal(m.has("Q"), false, "no matching name: skipped, not the first item");
assert.deepEqual(amb.sort(), ["ACH", "Q"]);
// a primary listing still wins outright; two primaries fall to the name rule
m = universeMap([named("P", "Other Co", "otc"), named("P", "Real Co", "primary", true)], { prev: new Map([["P", { n: "Other Co" }]]) });
assert.equal(m.get("P").tradingInformationData.tag, "primary");
m = universeMap([named("P", "Other Co", "p1", true), named("P", "Real Co", "p2", true)], { prev: new Map([["P", { n: "Real Co" }]]) });
assert.equal(m.get("P").tradingInformationData.tag, "p2", "two primaries: the name match decides");
// planBackfill: a skipped ticker needs a payload (then carries)
assert.deepEqual(planBackfill(["X"], universeMap([it("X", false, "a"), it("X", false, "b")])), { fromUniverse: [], needPayload: ["X"] });

// junk items are skipped, a missing list gives an empty map
assert.equal(universeMap([null, {}, { tradingInformationData: {} }]).size, 0);
assert.equal(universeMap(undefined).size, 0);

assert.match(UNIVERSE_URL, /pageSize=20000&sortDir=2$/);
console.log("backfill plan: all cases passed");
