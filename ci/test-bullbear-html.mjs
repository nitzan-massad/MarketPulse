// Self-check for the Bulls Say / Bears Say page parser (ci/bullbear-html.mjs).
// Run: node ci/test-bullbear-html.mjs   (no network; fixture = real trimmed tipranks.com/stocks/onds)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseBullBearHtml } from "./bullbear-html.mjs";

const page = readFileSync(new URL("./fixtures/onds-bullbear.html", import.meta.url), "utf8");

// 1. real page: exact 3 + 3, clean text, typographic apostrophe kept
const r = parseBullBearHtml(page);
assert.deepEqual(r.bull.map((x) => x.t), ["Rapid Revenue Expansion", "Backlog And Order Visibility", "Low Financial Leverage"]);
assert.deepEqual(r.bear.map((x) => x.t), ["Persistent Cash Burn", "Lack Of Operating Profitability", "Acquisition Integration Complexity"]);
for (const p of [...r.bull, ...r.bear]) {
  assert.ok(p.b.length > 40, `body too short: ${p.t}`);
  assert.doesNotMatch(p.t + p.b, /[<>]|&[a-z#0-9]+;/, `markup leaked: ${p.t}`);
}
assert.match(r.bull[0].b, /Ondas’/);

// 2. no section (challenge page, error page, redesign, the retired payload.json body) -> throws
for (const bad of ["", '<pre>{"data":null,"error":"not found"}</pre>', "<html><title>Just a moment...</title></html>"])
  assert.throws(() => parseBullBearHtml(bad), /no bull\/bear section/);

// 3. a later section's <h4><p> pairs must not leak into the bear column
const tail = '<section><h2>Ondas News</h2><h4>Not A Bear</h4><p>news body that is long enough</p></section>';
assert.equal(parseBullBearHtml(page.replace("</body>", tail + "</body>")).bear.length, 3);

// 4. an empty body is dropped (the data gate rejects b: "")
const emptied = page.replace(/(Persistent Cash Burn<\/h4>\s*<p[^>]*>)[\s\S]*?(<\/p>)/, "$1$2");
assert.deepEqual(parseBullBearHtml(emptied).bear.map((x) => x.t), ["Lack Of Operating Profitability", "Acquisition Integration Complexity"]);

// 5. no "Bears Say" heading -> bull column still stops at its own section, nothing leaks in
const noBear = page.replace(/>Bears Say<\/span>(\s*<\/h3>)/, ">Bear Case</span>$1").replace("</body>", tail + "</body>");
const nb = parseBullBearHtml(noBear);
assert.equal(nb.bull.length, 3);
assert.equal(nb.bear.length, 0);

console.log("bullbear-html: 5 checks ok (3↑ 3↓ on ONDS)");
