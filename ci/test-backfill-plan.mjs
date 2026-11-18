// Backfill planning: which off-pull tickers the full-universe screener pull can serve, and which
// need a per-ticker stock-aianalyst payload. No network.
import assert from "node:assert/strict";
import { universeMap, planBackfill, UNIVERSE_URL } from "./backfill-plan.mjs";

const it = (t, primary, tag) => ({ tradingInformationData: { ticker: t, stockListingIsPrimaryMarket: primary, tag } });

assert.deepEqual(planBackfill(["AAPL", "ACH"], new Map([["AAPL", {}]])), { fromUniverse: ["AAPL"], needPayload: ["ACH"] });
assert.deepEqual(planBackfill(["AAPL", "ACH"], new Map()), { fromUniverse: [], needPayload: ["AAPL", "ACH"] });
assert.deepEqual(planBackfill([], new Map([["A", {}]])), { fromUniverse: [], needPayload: [] });

// duplicates: the primary listing wins, in either order; otherwise the first stays
let m = universeMap([it("X", false, "otc"), it("X", true, "primary"), it("Y", true, "y")]);
assert.equal(m.size, 2);
assert.equal(m.get("X").tradingInformationData.tag, "primary");
m = universeMap([it("X", true, "primary"), it("X", false, "otc")]);
assert.equal(m.get("X").tradingInformationData.tag, "primary");
m = universeMap([it("X", false, "first"), it("X", false, "second")]);
assert.equal(m.get("X").tradingInformationData.tag, "first");

// junk items are skipped, a missing list gives an empty map
assert.equal(universeMap([null, {}, { tradingInformationData: {} }]).size, 0);
assert.equal(universeMap(undefined).size, 0);

assert.match(UNIVERSE_URL, /pageSize=20000&sortDir=2$/);
console.log("backfill plan: all cases passed");
