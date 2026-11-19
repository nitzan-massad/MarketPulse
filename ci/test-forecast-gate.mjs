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
import { carryPrevGuarded, carryStars, forecastsFromPayload, hiddenAnalysts, hiddenTargetKeys, pageNeeded, payloadOk, keepPrevRating, mergeForecasts, missingOf, prunedTried, topUpRows } from "./forecast-merge.mjs";

/* ---------------------------------------------------------------- the mirror */
// `fj` = the parsed payload, or null when the fetch failed. `page` = the page HTML, or null when the
// page fetch failed. Returns what the scraper would write, and whether it fetched the page.
function runTicker({ ticker, fj, page, out, now = Date.now(), tried = {} }) {
  const file = join(out, `${ticker}.json`);
  let prev = null;
  try { prev = JSON.parse(readFileSync(file, "utf8")); } catch { /* first fetch */ }
  const src = fj ? forecastsFromPayload(fj, ticker, null) : null;
  const ok = payloadOk(src, prev);
  let fc = carryStars(ok ? src : [], prev);
  const hidden = ok ? hiddenTargetKeys(fj, ticker, prev ?? []) : [];
  const needPage = pageNeeded({ srcOk: ok, hidden, tried: tried[ticker] });
  tried[ticker] = prunedTried(tried[ticker], hidden, ok);
  if (needPage && page != null) {
    const rows = parseForecastHtml(page);
    if (ok) fc = mergeForecasts(fc, topUpRows(withStars(rows), missingOf(fc, rows, now)));
    else fc = withStars(rows);
    tried[ticker] = hidden;
  }
  if (!tried[ticker].length) delete tried[ticker];
  fc = carryStars(fc, prev);
  fc = keepPrevRating(fc, prev);
  fc = carryPrevGuarded(fc, prev, { ok, now, hold: ok ? hiddenAnalysts(fj, ticker, prev ?? []) : [] }).rows;
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

/* ------------------------- 5. a hidden target costs ONE page fetch, not one per run (_pageTried) */
{
  writeFileSync(join(OUT, "T.json"), JSON.stringify([{ n: "Real Analyst", f: "Real Firm", st: 4, r: "Buy", pt: 12, opt: null, d: "2026-07-01" }]));
  const fj = payload([rating("2026-07-05", null), rating("2026-07-01", 12)], [EXPERT]);
  const tried = {};
  assert.equal(runTicker({ ticker: "T", fj, page: "", out: OUT, now: NOW, tried }).fetchedPage, true, "run 1: new hidden target -> page");
  assert.deepEqual(tried, { T: ["real analyst|2026-07-05"] }, "the key is recorded");
  assert.equal(runTicker({ ticker: "T", fj, page: "", out: OUT, now: NOW, tried }).fetchedPage, false, "run 2: already tried -> no page");
  // the analyst re-rates with a target: the hidden key disappears and is pruned
  runTicker({ ticker: "T", fj: payload([rating("2026-07-08", 14)], [EXPERT]), page: "", out: OUT, now: NOW, tried });
  assert.deepEqual(tried, {}, "keys no longer hidden are pruned");
  // payload failure always fetches the page, tried or not
  assert.equal(runTicker({ ticker: "T", fj: null, page: "", out: OUT, now: NOW, tried: { T: ["real analyst|2026-07-05"] } }).fetchedPage, true);
  // F2: payload AND page failed -> the _pageTried keys are not pruned (a failed payload lists no hidden targets)
  const keepTried = { T: ["real analyst|2026-07-05"] };
  runTicker({ ticker: "T", fj: null, page: null, out: OUT, now: NOW, tried: keepTried });
  assert.deepEqual(keepTried, { T: ["real analyst|2026-07-05"] }, "failed payload keeps _pageTried");
}

/* ------------------- 6. a payload that parses to 0 rows over a non-empty file = payload failure */
{
  const GOOD = [
    { n: "Kept Analyst", f: "Kept Firm", st: 3, r: "Buy", pt: 9, opt: null, d: "2026-06-01" },
    { n: "Older Analyst", f: "Older Firm", st: 1, r: "Sell", pt: 4, opt: null, d: "2025-01-01" },
  ];
  writeFileSync(join(OUT, "ZERO.json"), JSON.stringify(GOOD));
  const r = runTicker({ ticker: "ZERO", fj: payload([], []), page: null, out: OUT, now: NOW });
  assert.equal(r.fetchedPage, true, "0-row payload over a non-empty file -> page fallback");
  assert.deepEqual(r.rows, GOOD, "...and every previous row kept (all:true), even the year-old one");
}

/* --- 7. R2 (e2e): hidden re-rating the page does not render -> the stored 92-365 day row survives */
{
  // WYNN shape: the stored Buy row is 106 days old; the analyst's only payload rating is a newer Hold
  // with priceTarget null, and the page (cut at ~15 rows) does not list him.
  const stored = { n: "Real Analyst", f: "Real Firm", st: 4.7, r: "Buy", pt: 130, opt: 115, d: "2026-03-26" }; // NOW - 106 days
  writeFileSync(join(OUT, "T.json"), JSON.stringify([stored]));
  // a second analyst with a target, so the payload parses to rows (ok) rather than counting as a failure
  const other = { _id: "analyst|2", uid: "u2", name: "Other Analyst", firm: "Other Firm", rank: { rank: 0.5 } };
  const otherRating = { object: { ticker: "T" }, expert: { uid: "u2", id: "analyst|2" }, date: "2026-07-01T00:00:00.000Z", position: "buy", priceTarget: { value: 20 } };
  const r2 = runTicker({ ticker: "T", fj: payload([rating("2026-07-09", null), otherRating], [EXPERT, other]), page: PAGE, out: OUT, now: NOW, tried: {} });
  console.log("R2 pipeline (page fetched, analyst not on it) ->", JSON.stringify(r2.rows.filter((x) => x.n === "Real Analyst")));
  assert.equal(r2.fetchedPage, true);
  assert.deepEqual(r2.rows.filter((x) => x.n === "Real Analyst"), [stored], "stored rating kept whole, one row");
}

/* --------------------------------------------------------------- SOURCE FIDELITY
   runTicker() above restates the scraper's per-ticker flow, so pin the load-bearing source lines.
   If one of these fails the scraper changed — update BOTH. */
{
  const src = readFileSync(new URL("./scrape-forecasts.mjs", import.meta.url), "utf8");
  for (const line of [
    "src = forecastsFromPayload(fj, t, null);",
    "const ok = payloadOk(src, prev);",
    "let fc = carryStars(ok ? src : [], prev);",
    "const hidden = ok ? hiddenTargetKeys(fj, t, prev ?? []) : [];",
    "const needPage = pageNeeded({ srcOk: ok, hidden, tried: tried[t] });",
    "tried[t] = prunedTried(tried[t], hidden, ok);",
    "if (needPage && !skipOpen(\"forecast page\", pageBreaker)) {",
    "plain: false, ok: (h) => usablePage(h, 1), breaker: pageBreaker",
    "fc = mergeForecasts(fc, topUpRows(withStars(page), missingOf(fc, page)));",
    "fc = withStars(page);",
    "tried[t] = hidden;",
    "if (!tried[t].length) delete tried[t];",
    "fc = carryStars(fc, prev);",
    "fc = keepPrevRating(fc, prev);",
    "const g = carryPrevGuarded(fc, prev, { ok, hold: ok ? hiddenAnalysts(fj, t, prev ?? []) : [] });",
    "fc = g.rows;",
    "if (fc.length) {\n      writeFileSync(",
    "const PARALLEL = Math.max(1, ",
  ]) assert.ok(src.includes(line), `PIPELINE MOVED: scrape-forecasts.mjs no longer has \`${line}\` — update runTicker() in this file`);
  assert.ok(!/getData/.test(src.replace(/^\s*\/\/.*$/gm, "")), "getData is Cloudflare-blocked: the scraper must not fetch it");
  assert.ok(!/^\s*import\s.*scrape-forecasts/m.test(readFileSync(new URL("./test-forecast-gate.mjs", import.meta.url), "utf8")),
    "this test must never import scrape-forecasts.mjs — its module body runs a live scrape");
}

rmSync(OUT, { recursive: true, force: true }); // only on success — a failure leaves the evidence

console.log("forecast pipeline gate: ok (page gate, payload-failed keep-all, never-shrink on bad pages, one fetch per hidden target, 0-row payload, source fidelity)");
