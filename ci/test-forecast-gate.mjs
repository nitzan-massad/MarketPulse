// Self-check for the per-ticker pipeline of ci/scrape-forecasts.mjs: payload.json first, the forecast
// page only when the payload failed or withholds a target, then last run's rows so a file never
// shrinks on a fetch failure.
// Run: node ci/test-forecast-gate.mjs   (no network, no filesystem outside os.tmpdir())
//
// !!! runTicker() BELOW MIRRORS ci/scrape-forecasts.mjs scrape() !!!
// Importing the scraper is not an option: it has no exports and its module body immediately runs a
// live FlareSolverr scrape and writes public/forecasts/. Every decision calls the REAL functions
// (ci/forecast-merge.mjs, ci/forecast-html.mjs); only the sequence is restated, and SOURCE FIDELITY
// at the bottom asserts the scraper still has exactly these lines — edit one, update both.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { parseForecastHtml, withStars } from "./forecast-html.mjs";
import { carryRecentPrev, carryStars, forecastsFromPayload, hiddenTargets, keepNewerPrev, keepPrevRating, latestPerAnalyst, mergeForecasts, missingOf, topUpRows } from "./forecast-merge.mjs";

/* ---------------------------------------------------------------- the mirror */
// `fj` = the parsed payload, or null when the fetch failed. `page` = the page HTML, or null when the
// page fetch failed. Returns what the scraper would write, and whether it fetched the page.
function runTicker({ ticker, fj, page, out, now = Date.now() }) {
  const file = join(out, `${ticker}.json`);
  let prev = null;
  try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { /* first fetch */ }
  const src = fj ? forecastsFromPayload(fj, ticker, null) : null;
  let fc = carryStars(src ?? [], prev);
  const needPage = src === null || hiddenTargets(fj, ticker, prev ?? []).length > 0;
  if (needPage && page != null) {
    const rows = parseForecastHtml(page);
    if (src !== null) fc = mergeForecasts(fc, topUpRows(withStars(rows), missingOf(fc, rows, now)));
    else fc = withStars(rows);
  }
  fc = carryStars(fc, prev);
  fc = keepPrevRating(fc, prev);
  fc = carryRecentPrev(fc, prev, { now, all: src === null });
  fc = keepNewerPrev(fc, prev);
  fc = latestPerAnalyst(fc);
  let wrote = false;
  if (fc.length) { writeFileSync(file, JSON.stringify(fc)); wrote = true; }
  return { wrote, fetchedPage: needPage, rows: fc };
}

const OUT = mkdtempSync(join(tmpdir(), "mp-forecast-gate-"));
const PAGE = readFileSync(new URL("./fixtures/adct-forecast.html", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 6, 10); // the ADCT fixture's rows are 2026-06-04 .. 2026-07-07
const payload = (ratings, experts) => ({ models: { experts, ratings } });
const EXPERT = { _id: "analyst|1", uid: "u1", name: "Real Analyst", firm: "Real Firm", rank: { rank: 0.8 } };
const rating = (d, pt) => ({ object: { ticker: "T" }, expert: { uid: "u1", id: "analyst|1" }, date: `${d}T00:00:00.000Z`, position: "buy", priceTarget: pt == null ? null : { value: pt } });

/* ------------------------------------------- 1. payload ok, no hidden target -> no page fetch */
{
  // The cheap path: ~0.8s per ticker, no FlareSolverr Chrome.
  const r = runTicker({ ticker: "T", fj: payload([rating("2026-07-01", 12)], [EXPERT]), page: PAGE, out: OUT, now: NOW });
  assert.equal(r.fetchedPage, false, "payload rows with targets -> no page");
  assert.deepEqual(r.rows, [{ n: "Real Analyst", f: "Real Firm", r: "Buy", pt: 12, opt: null, d: "2026-07-01", st: 4 }]);
  assert.equal(r.rows[0].st, 4, "stars from the payload rank, round(5 x 0.8, 1)");
}

/* ------------------------------------- 2. payload withholds a newer target -> fetch the page */
{
  const r = runTicker({ ticker: "T", fj: payload([rating("2026-07-05", null), rating("2026-07-01", 12)], [EXPERT]), page: PAGE, out: OUT, now: NOW });
  assert.equal(r.fetchedPage, true, "newest payload rating has no target and is newer than the file row -> page");
  assert.ok(r.rows.some((x) => x.f === "RBC Capital"), "page analysts the payload lacks are added");
  assert.ok(r.rows.some((x) => x.n === "Real Analyst" && x.pt === 12), "payload row kept");
}

/* --------------------------- 3. payload failed -> the page, and EVERY previous row is kept */
{
  const file = join(OUT, "ADCT.json");
  const old = { n: "Year Old", f: "Old Bank", st: 2, r: "Hold", pt: 5, opt: null, d: "2025-09-01" };
  writeFileSync(file, JSON.stringify([old]));
  const r = runTicker({ ticker: "ADCT", fj: null, page: PAGE, out: OUT, now: NOW });
  assert.equal(r.fetchedPage, true, "payload failed -> page");
  assert.deepEqual(r.rows.map((x) => x.f), ["RBC Capital", "Guggenheim", "Stephens", "Old Bank"], "page rows + all of last run's (all:true)");
  assert.deepEqual(Object.keys(r.rows[0]), ["n", "f", "st", "r", "pt", "opt", "d"], "page rows in the Forecast shape");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].st, null, "st survives the JSON round-trip as null");
}

/* ========== 4. BOTH sources fail / the page parses to [] -> the file is never shrunk or blanked */
{
  const GOOD = [
    { n: "Kept Analyst", f: "Kept Firm", st: 3, r: "Buy", pt: 9, opt: null, d: "2026-06-01" },
    { n: "Older Analyst", f: "Older Firm", st: 1, r: "Sell", pt: 4, opt: null, d: "2025-01-01" },
  ];
  const badPages = {
    "page fetch failed": null,
    "empty body": "",
    "cloudflare 403 body": "<html><body>Access denied</body></html>",
    "markup change: analyst link path renamed": PAGE.replaceAll("/experts/analysts/", "/experts/analyst-profile/"),
    "table header only, no rows": PAGE.slice(0, PAGE.indexOf('<div class="rt-tr-group">')),
  };
  for (const [label, page] of Object.entries(badPages)) {
    const file = join(OUT, "KEEP.json");
    writeFileSync(file, JSON.stringify(GOOD));
    const r = runTicker({ ticker: "KEEP", fj: null, page, out: OUT, now: NOW });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), GOOD, `${label}: last run's file must survive whole`);
    assert.equal(r.rows.length, GOOD.length, `${label}: no shrink`);
  }
  // a reshaped payload is a failure too (forecastsFromPayload -> null), not "no analysts"
  writeFileSync(join(OUT, "KEEP.json"), JSON.stringify(GOOD));
  assert.equal(runTicker({ ticker: "KEEP", fj: { models: {} }, page: null, out: OUT, now: NOW }).rows.length, 2, "reshaped payload -> keep all");
  // no file yet and nothing parsed -> no file is created
  assert.equal(runTicker({ ticker: "FRESH", fj: null, page: "", out: OUT, now: NOW }).wrote, false);
  assert.equal(existsSync(join(OUT, "FRESH.json")), false, "an empty result must not create an empty file");
  // a genuinely uncovered ticker (payload ok, no ratings) writes nothing and fetches no page
  const nocov = runTicker({ ticker: "NOCOV", fj: payload([], []), page: PAGE, out: OUT, now: NOW });
  assert.equal(nocov.fetchedPage, false);
  assert.equal(nocov.wrote, false);
}

/* --------------------------------------------------------------- SOURCE FIDELITY
   runTicker() above restates the scraper's per-ticker flow, so pin the load-bearing source lines.
   If one of these fails the scraper changed — update BOTH. */
{
  const src = readFileSync(new URL("./scrape-forecasts.mjs", import.meta.url), "utf8");
  for (const line of [
    "src = forecastsFromPayload(fj, t, null);",
    "fc = carryStars(src ?? [], prev);",
    "const needPage = src === null || hiddenTargets(fj, t, prev ?? []).length > 0;",
    "if (needPage && !skipOpen(\"forecast page\", pageBreaker)) {",
    "plain: false, ok: (h) => usablePage(h, 1), breaker: pageBreaker",
    "fc = mergeForecasts(fc, topUpRows(withStars(page), missingOf(fc, page)));",
    "fc = withStars(page);",
    "fc = carryStars(fc, prev);",
    "fc = keepPrevRating(fc, prev);",
    "fc = carryRecentPrev(fc, prev, { all: src === null });",
    "fc = keepNewerPrev(fc, prev);",
    "fc = latestPerAnalyst(fc);",
    "if (fc.length) {\n      writeFileSync(",
    "const PARALLEL = Math.max(1, ",
  ]) assert.ok(src.includes(line), `PIPELINE MOVED: scrape-forecasts.mjs no longer has \`${line}\` — update runTicker() in this file`);
  assert.ok(!/getData/.test(src.replace(/^\s*\/\/.*$/gm, "")), "getData is Cloudflare-blocked: the scraper must not fetch it");
  assert.ok(!/^\s*import\s.*scrape-forecasts/m.test(readFileSync(new URL("./test-forecast-gate.mjs", import.meta.url), "utf8")),
    "this test must never import scrape-forecasts.mjs — its module body runs a live scrape");
}

rmSync(OUT, { recursive: true, force: true }); // only on success — a failure leaves the evidence

console.log("forecast pipeline gate: ok (page gate, payload-failed keep-all, never-shrink on bad pages, source fidelity)");
