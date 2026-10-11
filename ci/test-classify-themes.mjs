// Guards ci/classify-themes.mjs. The bugs this exists to catch:
//   1. a chatty answer ("Yes, IonQ builds…") or a hedge ("Possibly") being misread as a verdict
//   2. a company asked again every run (cost) — or never re-asked after its description changed
//   3. a company that left the snapshot still showing in the filter
//   4. the committed files drifting from the shape the app reads
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildOut, hashOf, needsAsk, parseVerdict, THEMES } from "./classify-themes.mjs";

assert.equal(parseVerdict("Yes"), 1);
assert.equal(parseVerdict("yes."), 1);
assert.equal(parseVerdict("  No — it sells protein sequencers"), 0);
assert.equal(parseVerdict("**Yes**"), 1);
assert.equal(parseVerdict("Possibly"), null);
assert.equal(parseVerdict("Yesterday's filing says"), null); // a word boundary, not a prefix
assert.equal(parseVerdict(undefined), null);

const IONQ = { t: "IONQ", n: "IonQ Inc", desc: "Builds trapped-ion quantum computers." };
const QSI = { t: "QSI", n: "Quantum-Si", desc: "Protein sequencing instruments." };
const NODESC = { t: "ZZZ", n: "No Desc Co", desc: "" };

// asked once; a changed description re-asks; no description is never asked
assert.deepEqual(needsAsk([IONQ, QSI, NODESC], {}).map((s) => s.t), ["IONQ", "QSI"]);
const v = { IONQ: [hashOf(IONQ), 1], QSI: [hashOf(QSI), 0] };
assert.deepEqual(needsAsk([IONQ, QSI], v), []);
assert.deepEqual(needsAsk([{ ...QSI, desc: "Now builds quantum processors." }, IONQ], v).map((s) => s.t), ["QSI"]);

// only "yes" companies still in the snapshot reach the app, sorted
const name = Object.keys(THEMES)[0];
const out = buildOut([IONQ, QSI], { [name]: { ...v, RGTI: ["x", 1], AAA: ["y", 1] } });
assert.deepEqual(out[name], ["IONQ"]);
assert.deepEqual(Object.keys(out), Object.keys(THEMES));

// committed files: every theme present, members are tickers, cache entries are [hash, 0|1]
if (existsSync("src/data/themes.json")) {
  const f = JSON.parse(readFileSync("src/data/themes.json", "utf8"));
  for (const [k, list] of Object.entries(f)) {
    assert.ok(Array.isArray(list), k);
    for (const t of list) assert.match(t, /^[A-Z0-9.\-]+$/, `${k}: ${t}`);
  }
}
if (existsSync("ci/cache/themes.json")) {
  const c = JSON.parse(readFileSync("ci/cache/themes.json", "utf8"));
  for (const verdicts of Object.values(c))
    for (const [t, e] of Object.entries(verdicts)) assert.ok(Array.isArray(e) && (e[1] === 0 || e[1] === 1), t);
}

console.log("test-classify-themes: all passed");
