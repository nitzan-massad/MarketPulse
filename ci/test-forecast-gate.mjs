// Self-check for the per-ticker pipeline of ci/scrape-forecasts.mjs: payload.json only (the HTML
// /forecast page fallback was dropped 2026-11-22), then last run's rows so a file never shrinks on a
// fetch failure.
// Run: node ci/test-forecast-gate.mjs   (no network, no filesystem outside os.tmpdir())
//
// !!! runTicker() BELOW MIRRORS ci/scrape-forecasts.mjs scrape() !!!
// Importing the scraper is not an option: it has no exports and its module body immediately runs a
// live FlareSolverr scrape and writes public/forecasts/. Every decision calls the REAL functions
// (ci/forecast-merge.mjs); only the sequence is restated, and SOURCE FIDELITY
// at the bottom asserts the scraper still has exactly these lines — edit one, update both.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { carryPrevGuarded, carryStars, forecastsFromPayload, hiddenAnalysts, payloadOk, keepPrevRating } from "./forecast-merge.mjs";

/* ---------------------------------------------------------------- the mirror */
// `fj` = the parsed payload, or null when the fetch failed. Returns what the scraper would write.
function runTicker({ ticker, fj, out, now = Date.now() }) {
  const file = join(out, `${ticker}.json`);
  let prev = null;
  try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { /* first fetch */ }
  const src = fj ? forecastsFromPayload(fj, ticker) : null;
  const ok = payloadOk(src, prev);
  let fc = carryStars(ok ? src : [], prev);
  fc = keepPrevRating(fc, prev);
  fc = carryPrevGuarded(fc, prev, { ok, now, hold: ok ? hiddenAnalysts(fj, ticker, prev ?? []) : [] }).rows;
  let wrote = false;
  if (fc.length) { writeFileSync(file, JSON.stringify(fc)); wrote = true; }
  return { wrote, rows: fc };
}

const OUT = mkdtempSync(join(tmpdir(), "mp-forecast-gate-"));
const NOW = Date.UTC(2026, 6, 10);
const payload = (ratings, experts) => ({ models: { experts, ratings } });
const EXPERT = { _id: "analyst|1", uid: "u1", name: "Real Analyst", firm: "Real Firm", rank: { rank: 0.8 } };
const rating = (d, pt) => ({ object: { ticker: "T" }, expert: { uid: "u1", id: "analyst|1" }, date: `${d}T00:00:00.000Z`, position: "buy", priceTarget: pt == null ? null : { value: pt } });
const GOOD = [
  { n: "Kept Analyst", f: "Kept Firm", st: 3, r: "Buy", pt: 9, opt: null, d: "2026-06-01" },
  { n: "Older Analyst", f: "Older Firm", st: 1, r: "Sell", pt: 4, opt: null, d: "2025-01-01" },
];

/* -------------------------------------------------------------- 1. payload ok -> its rows */
{
  const r = runTicker({ ticker: "T", fj: payload([rating("2026-07-01", 12)], [EXPERT]), out: OUT, now: NOW });
  assert.deepEqual(r.rows, [{ n: "Real Analyst", f: "Real Firm", r: "Buy", pt: 12, opt: null, d: "2026-07-01", st: 4 }]);
  assert.equal(r.rows[0].st, 4, "stars from the payload rank, round(5 x 0.8, 1)");
}

/* --------------------- 2. payload withholds a newer target -> the stored row with a target stays */
{
  const r = runTicker({ ticker: "T", fj: payload([rating("2026-07-05", null), rating("2026-07-01", 12)], [EXPERT]), out: OUT, now: NOW });
  assert.ok(r.rows.some((x) => x.n === "Real Analyst" && x.pt === 12), "payload row with a target kept");
}

/* ------------------- 3. payload failed / reshaped -> EVERY previous row is kept, never blanked */
{
  for (const [label, fj] of Object.entries({ "fetch failed": null, "reshaped payload": { models: {} } })) {
    const file = join(OUT, "KEEP.json");
    writeFileSync(file, JSON.stringify(GOOD));
    const r = runTicker({ ticker: "KEEP", fj, out: OUT, now: NOW });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), GOOD, `${label}: last run's file must survive whole`);
    assert.equal(r.rows.length, GOOD.length, `${label}: no shrink`);
  }
  // no file yet and nothing fetched -> no file is created
  assert.equal(runTicker({ ticker: "FRESH", fj: null, out: OUT, now: NOW }).wrote, false);
  assert.equal(existsSync(join(OUT, "FRESH.json")), false, "an empty result must not create an empty file");
  // a genuinely uncovered ticker (payload ok, no ratings) writes nothing
  assert.equal(runTicker({ ticker: "NOCOV", fj: payload([], []), out: OUT, now: NOW }).wrote, false);
}

/* ------------------- 4. a payload that parses to 0 rows over a non-empty file = payload failure */
{
  writeFileSync(join(OUT, "ZERO.json"), JSON.stringify(GOOD));
  const r = runTicker({ ticker: "ZERO", fj: payload([], []), out: OUT, now: NOW });
  assert.deepEqual(r.rows, GOOD, "every previous row kept (all:true), even the year-old one");
}

/* ------------- 5. R2: hidden re-rating -> the stored 92-365 day row survives (hold), one row */
{
  const stored = { n: "Real Analyst", f: "Real Firm", st: 4.7, r: "Buy", pt: 130, opt: 115, d: "2026-03-26" }; // NOW - 106 days
  writeFileSync(join(OUT, "T.json"), JSON.stringify([stored]));
  const other = { _id: "analyst|2", uid: "u2", name: "Other Analyst", firm: "Other Firm", rank: { rank: 0.5 } };
  const otherRating = { object: { ticker: "T" }, expert: { uid: "u2", id: "analyst|2" }, date: "2026-07-01T00:00:00.000Z", position: "buy", priceTarget: { value: 20 } };
  const r2 = runTicker({ ticker: "T", fj: payload([rating("2026-07-09", null), otherRating], [EXPERT, other]), out: OUT, now: NOW });
  assert.deepEqual(r2.rows.filter((x) => x.n === "Real Analyst"), [stored], "stored rating kept whole, one row");
}

/* --------------------------------------------------------------- SOURCE FIDELITY
   runTicker() above restates the scraper's per-ticker flow, so pin the load-bearing source lines.
   If one of these fails the scraper changed — update BOTH. */
{
  const src = readFileSync(new URL("./scrape-forecasts.mjs", import.meta.url), "utf8");
  for (const line of [
    "src = forecastsFromPayload(fj, t);",
    "const ok = payloadOk(src, prev);",
    "let fc = carryStars(ok ? src : [], prev);",
    "fc = keepPrevRating(fc, prev);",
    "const g = carryPrevGuarded(fc, prev, { ok, hold: ok ? hiddenAnalysts(fj, t, prev ?? []) : [] });",
    "fc = g.rows;",
    "if (fc.length) {\n      writeFileSync(",
    "const PARALLEL = Math.max(1, ",
  ]) assert.ok(src.includes(line), `PIPELINE MOVED: scrape-forecasts.mjs no longer has \`${line}\` — update runTicker() in this file`);
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\/api\/stocks\/get/i.test(code), "the old endpoint is Cloudflare-blocked: the scraper must not fetch it");
  assert.ok(!/\/forecast[`'"]/.test(code) && !/forecast-html/.test(code), "the HTML /forecast page is Cloudflare-blocked on runners: the scraper must not fetch it");
  assert.ok(!/^\s*import\s.*scrape-forecasts/m.test(readFileSync(new URL("./test-forecast-gate.mjs", import.meta.url), "utf8")),
    "this test must never import scrape-forecasts.mjs — its module body runs a live scrape");
}

rmSync(OUT, { recursive: true, force: true }); // only on success — a failure leaves the evidence

console.log("forecast pipeline gate: ok (payload rows, hidden-target hold, payload-failed keep-all, 0-row payload, no page fetch, source fidelity)");
