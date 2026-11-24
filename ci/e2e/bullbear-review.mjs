// Offline review checks for ci/bullbear-payload.mjs (commit dfc2000d6). No network.
// Run: node ci/e2e/bullbear-review.mjs
// BUG lines are real defects and make the exit code 1; NOTE lines are behaviour worth knowing, not failures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractJson, parseBullBearPayload } from "../bullbear-payload.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/outlook-aapl-keypoints.json", import.meta.url), "utf8"));
let bugs = 0;
const check = (kind, name, fn) => {
  try { fn(); console.log(`ok    ${name}`); }
  catch (e) { if (kind === "BUG") bugs++; console.log(`${kind.padEnd(5)} ${name}\n      ${e.message.split("\n")[0]}`); }
};

// Chrome's HTML serializer (FlareSolverr returns page_source) escapes only & < > and U+00A0 in a
// text node: quotes are NOT escaped, and U+00A0 becomes &nbsp;. Seen in real cached FlareSolverr
// bodies (AAPL 2, KO 7, TSLA 1 &nbsp;).
const chromeWrap = (raw) => `<html><head></head><body><pre>${raw.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;")}</pre><div class="json-formatter-container"></div></body></html>`;

// 1. BUG: U+00A0 in a keyPoint comes back as the literal text "&nbsp;" via FlareSolverr (plain fetch is fine).
//    The old HTML parser's unent() decoded &nbsp;; extractJson does not.
check("BUG", "FlareSolverr body with U+00A0 in a keyPoint parses the same as the plain body", () => {
  const j = structuredClone(fixture);
  j.models.stocks_extra[1].aiAnalysis.keyPoints[0].description = "Apple\u00a0Inc. has 2.5\u00a0billion devices";
  const raw = JSON.stringify(j);
  assert.deepEqual(parseBullBearPayload(extractJson(chromeWrap(raw)), "AAPL"), parseBullBearPayload(JSON.parse(raw), "AAPL"));
});

// 2. Entity decode order and JSON-structural characters inside strings survive the <pre> unwrap.
check("BUG", "&amp;lt; / &#39; / quotes / } and </pre> inside strings round-trip", () => {
  const j = structuredClone(fixture);
  j.models.stocks_extra[1].aiAnalysis.keyPoints[0].title = `A&amp;B "x" {y} </pre> &lt;z&gt; it's &#39;`;
  const raw = JSON.stringify(j);
  assert.deepEqual(extractJson(chromeWrap(raw)), j);
});

// 3. Dotted ticker: a real BRK.B payload has _id "BRK.B" (slug brk.b) — exact-case match works.
check("BUG", "dotted ticker BRK.B matches _id BRK.B", () => {
  const j = { models: { stocks_extra: [{ _id: "BRK.B", aiAnalysis: { keyPoints: [{ sentiment: "bullish", title: "T", description: "D" }] } }] } };
  assert.equal(parseBullBearPayload(j, "BRK.B").bull.length, 1);
});

// 4. NOTE: payload for the wrong ticker (redirect, slug alias like BRK-B vs BRK.B, aiAnalysis renamed)
//    is "empty", not "failed". The old HTML parser threw on a missing section; README says "never silent".
check("NOTE", "ticker absent from stocks_extra throws (counts as failed, not empty)", () => {
  assert.throws(() => parseBullBearPayload(fixture, "MSFT"));
});
check("NOTE", "aiAnalysis reshaped (keyPoints renamed) throws", () => {
  const j = structuredClone(fixture);
  j.models.stocks_extra[1].aiAnalysis = { points: j.models.stocks_extra[1].aiAnalysis.keyPoints };
  assert.throws(() => parseBullBearPayload(j, "AAPL"));
});

// 5. NOTE: sentiment is matched case-sensitively and only bullish/bearish; anything else is dropped silently.
check("NOTE", "capitalised sentiment 'Bullish' is kept", () => {
  const j = structuredClone(fixture);
  for (const k of j.models.stocks_extra[1].aiAnalysis.keyPoints) k.sentiment = k.sentiment[0].toUpperCase() + k.sentiment.slice(1);
  assert.equal(parseBullBearPayload(j, "AAPL").bull.length, 3);
});

// 6. NOTE: one null keyPoint / non-string _id throws a TypeError for the whole ticker (counted failed).
check("NOTE", "a null keyPoint is skipped, the rest kept", () => {
  const j = structuredClone(fixture);
  j.models.stocks_extra[1].aiAnalysis.keyPoints.push(null);
  assert.equal(parseBullBearPayload(j, "AAPL").bull.length, 3);
});
check("NOTE", "a numeric _id elsewhere in stocks_extra does not break the lookup", () => {
  const j = structuredClone(fixture);
  j.models.stocks_extra.unshift({ _id: 700 });
  assert.equal(parseBullBearPayload(j, "AAPL").bull.length, 3);
});

// 7. NOTE: no <pre> (sibling extractJson copies in refresh-data-ci / scrape-forecasts fall back to the whole body).
check("NOTE", "entity-escaped JSON without a <pre> wrapper still extracts", () => {
  const raw = JSON.stringify(fixture);
  assert.deepEqual(extractJson(`<html><body>${raw.replace(/&/g, "&amp;")}</body></html>`), fixture);
});

console.log(bugs ? `\n${bugs} bug(s) reproduced` : "\nno bugs reproduced");
process.exitCode = bugs ? 1 : 0;
