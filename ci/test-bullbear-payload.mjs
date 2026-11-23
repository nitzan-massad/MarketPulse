// Self-check for the Bulls Say / Bears Say payload parser (ci/bullbear-payload.mjs).
// Run: node ci/test-bullbear-payload.mjs   (no network; fixture = real trimmed AAPL stock-aianalyst payload)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { extractJson, parseBullBearPayload } from "./bullbear-payload.mjs";

const raw = readFileSync(new URL("./fixtures/aianalyst-aapl-keypoints.json", import.meta.url), "utf8");
const j = JSON.parse(raw);

// 1. real payload: 3 + 3, picks the AAPL entry (not the first one), case-insensitive ticker
const r = parseBullBearPayload(j, "aapl");
assert.equal(r.bull.length, 3);
assert.equal(r.bear.length, 3);
assert.equal(r.bull[0].t, "Ecosystem Scale");
for (const p of [...r.bull, ...r.bear]) assert.ok(p.b.length > 40, `body too short: ${p.t}`);

// 2. ticker in the payload with no thesis -> empty, not a throw
assert.deepEqual(parseBullBearPayload(j, "GPRO"), { bull: [], bear: [] });

// 3. reshaped / error body -> throws
for (const bad of [{}, { data: null, error: "not found" }, { models: {} }])
  assert.throws(() => parseBullBearPayload(bad, "AAPL"), /no stocks_extra/);

// 3b. ticker absent from the payload -> throws (was silently "empty"); odd sentiment case / null point tolerated
assert.throws(() => parseBullBearPayload(j, "MSFT"), /ticker not in payload/);
const odd = structuredClone(j);
odd.models.stocks_extra[1].aiAnalysis.keyPoints[0].sentiment = "Bullish";
odd.models.stocks_extra[1].aiAnalysis.keyPoints.push(null);
odd.models.stocks_extra.unshift({ _id: 42 });
assert.equal(parseBullBearPayload(odd, "AAPL").bull.length, 3);

// 4. empty body dropped (the data gate rejects b: "")
const emptied = structuredClone(j);
emptied.models.stocks_extra[1].aiAnalysis.keyPoints[3].description = "";
assert.equal(parseBullBearPayload(emptied, "AAPL").bear.length, 2);

// 5. extractJson: raw and FlareSolverr's <pre>-wrapped, entity-escaped form; a challenge page throws
const wrapped = `<html><body><pre>${raw.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}</pre></body></html>`;
assert.deepEqual(extractJson(wrapped), j);
assert.deepEqual(extractJson(raw), j);
assert.throws(() => extractJson("<html><title>Just a moment...</title></html>"));
// FlareSolverr entity forms seen in real payloads: nbsp, numeric; &amp;lt; must stay literal "&lt;"
assert.deepEqual(extractJson('<pre>{&quot;a&quot;:&quot;x&nbsp;y&#39;z&#x27;&amp;lt;&quot;}</pre>'), { a: "x\u00a0y'z'&lt;" });

console.log("bullbear-payload: 5 checks ok (3↑ 3↓ on AAPL)");
