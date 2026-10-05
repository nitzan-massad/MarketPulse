// Data gate for public/pe/ (ci/scrape-pe.mjs): every shipped P/E history file has the shape
// the chart reads, and the index never claims a file that isn't there. Runs in `npm test`,
// so in CI it vets the files the scrape just wrote, before they are committed.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const DIR = "public/pe";
let index = {};
try { index = JSON.parse(readFileSync(`${DIR}/_asOf.json`, "utf8")); } catch { /* none yet */ }
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^[A-Z][A-Z0-9.]*\.json$/.test(f)) : [];

for (const [t, e] of Object.entries(index)) {
  assert.ok(!Number.isNaN(Date.parse(e.a)), `${t}: index entry has a real attempt stamp`);
  if (e.ok) assert.ok(files.includes(`${t}.json`), `${t}: index says ok but ${t}.json is missing`);
}

let points = 0;
for (const f of files) {
  const t = f.slice(0, -5);
  const j = JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"));
  assert.match(j.asOf, /^\d{4}-\d{2}-\d{2}$/, `${t}: asOf is a date`);
  assert.ok(Array.isArray(j.pts) && j.pts.length >= 2, `${t}: at least two points`);
  let prev = "";
  let real = 0;
  for (const [d, v, loss] of j.pts) {
    // a third element marks a loss week, and only ever on a gap
    assert.ok(loss === undefined || (loss === 1 && v === null), `${t}: loss flag on ${d} is 1 on a null`);
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `${t}: point date ${d}`);
    assert.ok(d > prev, `${t}: dates strictly increase (${prev} -> ${d})`);
    prev = d;
    // null is a gap (no positive TTM earnings) — never 0, never negative
    if (v !== null) {
      assert.ok(Number.isFinite(v) && v > 0, `${t}: P/E ${v} on ${d} is a positive number`);
      real++;
    }
  }
  assert.ok(real >= 2, `${t}: at least two weeks with a P/E`);
  points += j.pts.length;
}
console.log(`pe files OK — ${files.length} file(s), ${points} points, ${Object.keys(index).length} indexed`);
