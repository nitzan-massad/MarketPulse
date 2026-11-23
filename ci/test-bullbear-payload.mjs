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

// 4. empty body dropped (the data gate rejects b: "")
const emptied = structuredClone(j);
emptied.models.stocks_extra[1].aiAnalysis.keyPoints[3].description = "";
assert.equal(parseBullBearPayload(emptied, "AAPL").bear.length, 2);

// 5. extractJson: raw and FlareSolverr's <pre>-wrapped, entity-escaped form; a challenge page throws
const wrapped = `<html><body><pre>${raw.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}</pre></body></html>`;
assert.deepEqual(extractJson(wrapped), j);
assert.deepEqual(extractJson(raw), j);
assert.throws(() => extractJson("<html><title>Just a moment...</title></html>"));

console.log("bullbear-payload: 5 checks ok (3↑ 3↓ on AAPL)");
