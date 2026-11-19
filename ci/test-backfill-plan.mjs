// Backfill planning: which off-pull tickers the full-universe screener pull can serve, and which
// need a per-ticker stock-aianalyst payload. No network.
import assert from "node:assert/strict";
import { universeMap, universeItems, planBackfill, UNIVERSE_URL, universeOk, itemsFor, ambiguousCarried } from "./backfill-plan.mjs";
import { readFileSync } from "node:fs";

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
// R3: stored rows now hold the DISPLAY name, so the tie-break matches either the listing's
// companyDisplayName or its legal companyName (rows written before the switch hold either).
{
  const dn = (t, disp, legal, tag) => ({ tradingInformationData: { ticker: t, companyDisplayName: disp, companyName: legal, stockListingIsPrimaryMarket: false, tag } });
  const items = [dn("T", "Other Thing", "Other Thing Ltd", "other"), dn("T", "TSMC", "Taiwan Semiconductor Manufacturing Company Limited", "ours")];
  const byDisp = universeMap(items, { prev: new Map([["T", { n: "TSMC" }]]) });
  console.log("R3 tie-break on stored display name ->", byDisp.get("T")?.tradingInformationData.tag);
  assert.equal(byDisp.get("T")?.tradingInformationData.tag, "ours", "a stored display name matches the listing's companyDisplayName");
  const byLegal = universeMap(items, { prev: new Map([["T", { n: "Taiwan Semiconductor Manufacturing Co Ltd" }]]) });
  assert.equal(byLegal.get("T")?.tradingInformationData.tag, "ours", "a stored legal name still matches companyName");
}
// planBackfill: a skipped ticker needs a payload (then carries)
assert.deepEqual(planBackfill(["X"], universeMap([it("X", false, "a"), it("X", false, "b")])), { fromUniverse: [], needPayload: ["X"] });

// junk items are skipped, a missing list gives an empty map
assert.equal(universeMap([null, {}, { tradingInformationData: {} }]).size, 0);
assert.equal(universeMap(undefined).size, 0);

assert.match(UNIVERSE_URL, /pageSize=20000&sortDir=2$/);

// B5: a parsed-but-reshaped universe body must throw (-> health "universe pull failed"), never pass
// as an empty map. scripts/refresh-data.mjs had `.items || []`, which hid the reshape locally.
assert.deepEqual(universeItems({ items: [1, 2] }), [1, 2]);
assert.deepEqual(universeItems({ items: [] }), [], "a real empty list is an answer");
for (const bad of [{}, { items: null }, { items: {} }, { data: [] }, null, undefined, "x"]) {
  assert.throws(() => universeItems(bad), /no items/, `reshaped body ${JSON.stringify(bad)} throws`);
}
// both refresh scripts (they fetch on import, so source-level) use the shared guard and report it
for (const p of ["ci/refresh-data-ci.mjs", "scripts/refresh-data.mjs"]) {
  const src = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  console.log(`B5 ${p}: universeItems=${/universeItems\(/.test(src)}, health=${/health\("universe pull failed"\)/.test(src)}`);
  assert.match(src, /universeItems\(/, `${p} must parse the universe with universeItems`);
  assert.match(src, /health\("universe pull failed"\)/, `${p} must raise the universe health line`);
  assert.doesNotMatch(src, /\)\.items \|\| \[\]/, `${p} must not swallow a reshaped body with \`.items || []\``);
}

// M2: the universe pull's `ok` predicate. A plain 200 that is not the JSON (an HTML maintenance or
// error page that isChallenge misses) must fall through to FlareSolverr instead of failing the parse.
// Cheap on purpose: the body is ~77 MB, so no full parse here.
assert.equal(universeOk('{"items":[{"a":1}],"totalCount":1}'), true);
assert.equal(universeOk('  <html><body><pre>{"items":[]}</pre></body></html>'), true, "FlareSolverr's <pre>-wrapped JSON");
assert.equal(universeOk("<pre>{&quot;items&quot;:[]}</pre>"), true, "HTML-escaped quotes");
for (const bad of ["<html><title>Down for maintenance</title></html>", "Service Unavailable", "", '{"error":"rate limited"}', null, undefined]) {
  assert.equal(universeOk(bad), false, `not the universe: ${JSON.stringify(bad)}`);
}
{
  const src = readFileSync(new URL("../ci/refresh-data-ci.mjs", import.meta.url), "utf8");
  const call = src.slice(src.indexOf("getText(UNIVERSE_URL"), src.indexOf("getText(UNIVERSE_URL") + 200);
  console.log("M2 universe getText call:", call.split("\n")[0].trim());
  assert.match(call, /ok:\s*universeOk/, "the CI universe fetch passes ok: universeOk");
}

// M8: only the missing tickers' items are kept (all of their duplicates, so universeMap's tie-break
// still sees every listing) — the local script filters in the page, CI before universeMap.
{
  const items = [it("A", true, "a"), it("B", false, "b1"), it("B", true, "b2"), it("C", true, "c"), null, {}];
  const got = itemsFor(items, ["B", "C", "Q"]);
  console.log("M8 itemsFor ->", got.map((x) => x.tradingInformationData.tag));
  assert.deepEqual(got.map((x) => x.tradingInformationData.tag), ["b1", "b2", "c"]);
  assert.deepEqual(itemsFor(items, []), []);
  assert.equal(universeMap(itemsFor(items, ["B"])).get("B").tradingInformationData.tag, "b2", "duplicates survive the filter");
  const ci = readFileSync(new URL("../ci/refresh-data-ci.mjs", import.meta.url), "utf8");
  assert.match(ci, /universeMap\(itemsFor\(/, "CI filters the universe to the missing tickers before mapping");
  const local = readFileSync(new URL("../scripts/refresh-data.mjs", import.meta.url), "utf8");
  const fu = local.slice(local.indexOf("async function fetchUniverse"), local.indexOf("async function fetchAiAnalyst"));
  assert.match(fu, /page\.evaluate\(async \(\{ url, want \}\)/, "the local universe fetch passes the missing tickers into the page");
  assert.match(fu, /\.filter\(/, "and filters there, so only their items cross CDP");
  assert.match(fu, /universeItems\(/, "a reshaped body still throws through universeItems");
}

// M6: an ambiguous duplicate is a health line only when it also ended up CARRIED (real staleness);
// covered by its payload it is a log line, or a permanent duplicate turns every run red.
assert.deepEqual(ambiguousCarried(["X", "Y", "Z"], new Set(["Y"])), ["Y"]);
assert.deepEqual(ambiguousCarried(["X"], new Set()), []);
for (const p of ["ci/refresh-data-ci.mjs", "scripts/refresh-data.mjs"]) {
  const src = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  assert.match(src, /ambiguousCarried\(/, `${p} reports ambiguous duplicates through ambiguousCarried`);
  const hl = src.match(/health\(`universe: [^`]*`\)/g) || [];
  console.log(`M6 ${p}: ${hl.join(" | ")}`);
  assert.equal(hl.length, 1, `${p}: one ambiguous health line`);
  assert.match(hl[0], /carried/, `${p}: the ambiguous health line is about carried rows`);
  assert(src.indexOf("ambiguousCarried(") > src.indexOf("carried++"), `${p}: decided after the backfill knows what carried`);
}
console.log("backfill plan: all cases passed");
