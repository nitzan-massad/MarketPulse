// Data gate for the per-ticker payloads and tracked.json: every shipped public/forecasts/<T>.json
// and public/bullbear/<T>.json has the shape the modal reads, and tracked.json maps tickers to
// real dates. ci/test-pe-files.mjs does the same for public/pe/. Runs in `npm test`, so it vets
// what a scrape just wrote — in site.yml before the commit, in the lite run before the Firebase upload.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const TICKER = /^[A-Z][A-Z0-9.-]*\.json$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;
const filesIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => TICKER.test(f)) : []);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

let analysts = 0;
const fc = filesIn("public/forecasts");
for (const f of fc) {
  const j = read(`public/forecasts/${f}`);
  assert.ok(Array.isArray(j), `forecasts/${f}: an array of analyst ratings`);
  for (const a of j) {
    assert.ok(typeof a.n === "string" && a.n && typeof a.r === "string" && a.r, `forecasts/${f}: analyst name + rating`);
    assert.match(a.d, DATE, `forecasts/${f}: ${a.n} has a dated rating`);
    assert.ok(Number.isFinite(a.pt) && a.pt > 0, `forecasts/${f}: ${a.n} price target ${a.pt} is a positive number`);
    assert.ok(a.opt === null || a.opt === undefined || Number.isFinite(a.opt), `forecasts/${f}: ${a.n} previous target is a number or null`);
    assert.ok(a.st === null || a.st === undefined || Number.isFinite(a.st), `forecasts/${f}: ${a.n} stars is a number or null`);
  }
  analysts += j.length;
}

const bb = filesIn("public/bullbear");
for (const f of bb) {
  const j = read(`public/bullbear/${f}`);
  // a pre-asOf file is legal (scrape-bullbear rotates it first); a present one must be a date —
  // staleness keys off it, never mtime
  if (j.asOf !== undefined) assert.match(j.asOf, DATE, `bullbear/${f}: asOf is a date`);
  for (const side of ["bull", "bear"]) {
    assert.ok(Array.isArray(j[side]), `bullbear/${f}: ${side} is an array`);
    for (const p of j[side]) assert.ok(typeof p.t === "string" && p.t && typeof p.b === "string" && p.b, `bullbear/${f}: every ${side} point has a title and body`);
  }
}

const tracked = existsSync("src/data/tracked.json") ? read("src/data/tracked.json") : {};
for (const [t, iso] of Object.entries(tracked)) {
  assert.match(t, /^[A-Z0-9.-]{1,12}$/, `tracked.json: ${t} is a ticker`);
  assert.ok(!Number.isNaN(Date.parse(iso)), `tracked.json: ${t} has a real request date`);
}

console.log(`payload files ok — ${fc.length} forecasts (${analysts} ratings), ${bb.length} bullbear, ${Object.keys(tracked).length} tracked`);
