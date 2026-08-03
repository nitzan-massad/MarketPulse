// Self-check for the HTML-fallback GATE in ci/scrape-forecasts.mjs.
// Run: node ci/test-forecast-gate.mjs   (no network, no filesystem outside os.tmpdir())
//
// !!! THIS FILE MIRRORS LOGIC THAT LIVES IN ci/scrape-forecasts.mjs !!!
// The two must be changed together. Importing the scraper is not an option: it has no
// exports and its module body immediately runs a live FlareSolverr scrape of ~90 tickers
// and writes public/forecasts/. So the two decisions it makes per ticker are restated here
// verbatim, and the mirror is kept honest by asserting the exact source lines still exist
// (see SOURCE FIDELITY at the bottom) — if someone edits the scraper without touching this
// file, that check fails and names the line that moved.
//
// The gate matters because it is the only thing standing between "the API paywalled this
// ticker" (fetch the 260 KB SSR page) and "TipRanks genuinely has no analysts" (don't).
// Getting it wrong in one direction costs ~300 needless page fetches per run; in the other
// it silently reinstates the "No analyst forecasts" bug on ~48 micro-caps.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { parseForecastHtml, withStars } from "./forecast-html.mjs";

/* ---------------------------------------------------------------- the mirror */

// MIRROR of scrape-forecasts.mjs:106
//   if (!fc.length && data.expertRatingsFilteredCount > 0) { ...fetch the SSR page... }
const shouldFallBack = (fc, data) => !fc.length && data.expertRatingsFilteredCount > 0;

// MIRROR of scrape-forecasts.mjs:108-112
//   const rows = withStars(parseForecastHtml(page), data);
//   if (rows.length) { fc = rows; viaHtml++; }
//   if (fc.length) { writeFileSync(`${OUT}/${t}.json`, JSON.stringify(fc)); ok++; }
//   else { empty++; }
// `page` is null here when the gate said not to fetch. Returns what the scraper would do.
function runTicker({ ticker, jsonRows, data, page, out }) {
  let fc = jsonRows;
  let viaHtml = false;
  if (shouldFallBack(fc, data)) {
    const rows = withStars(parseForecastHtml(page ?? ""), data);
    if (rows.length) { fc = rows; viaHtml = true; }
  }
  const file = join(out, `${ticker}.json`);
  let wrote = false;
  if (fc.length) { writeFileSync(file, JSON.stringify(fc)); wrote = true; }
  // MIRROR of scrape-forecasts.mjs:116 — asOf is stamped on empty too, but NOT on throw
  return { wrote, viaHtml, fetchedPage: shouldFallBack(jsonRows, data), rows: fc, stamped: true };
}

const OUT = mkdtempSync(join(tmpdir(), "mp-forecast-gate-"));
const JSON_ROW = { n: "Real Analyst", f: "Real Firm", st: 4, r: "Buy", pt: 12, opt: null, d: "2026-07-01" };
const PAGE = readFileSync(new URL("./fixtures/adct-forecast.html", import.meta.url), "utf8");

/* ------------------------------------------------- 1. JSON returned rows -> no fallback */
{
  // The cheap path. 300+ healthy tickers must never pay the page fetch, even when the
  // payload also admits to withholding some rows (a large cap: AAPL has 194 experts, 4 hidden).
  for (const filtered of [0, 4, 194, undefined, null]) {
    const r = runTicker({ ticker: "OK", jsonRows: [JSON_ROW], data: { expertRatingsFilteredCount: filtered }, page: PAGE, out: OUT });
    assert.equal(r.fetchedPage, false, `filteredCount=${filtered}: JSON had rows, must not fetch the page`);
    assert.equal(r.viaHtml, false);
    assert.equal(r.wrote, true);
    assert.deepEqual(r.rows, [JSON_ROW], "the JSON rows must be written unchanged");
  }
  assert.deepEqual(JSON.parse(readFileSync(join(OUT, "OK.json"), "utf8")), [JSON_ROW]);
}

/* -------------------------------- 2. JSON empty AND filteredCount > 0 -> fallback fires */
{
  // The bug this whole subsystem exists for: every row anonymized, so toForecasts() dropped
  // them all on the !e.name guard and we wrote [].
  const r = runTicker({ ticker: "ADCT", jsonRows: [], data: { expertRatingsFilteredCount: 4 }, page: PAGE, out: OUT });
  assert.equal(r.fetchedPage, true, "JSON empty + payload admits withholding -> fetch the SSR page");
  assert.equal(r.viaHtml, true, "the page's rows must replace the empty JSON result");
  assert.equal(r.wrote, true);
  assert.equal(r.rows.length, 3, "the ADCT page yields 3 usable rows");
  assert.deepEqual(Object.keys(r.rows[0]), ["n", "f", "st", "r", "pt", "opt", "d"],
    "the fallback must emit the same Forecast shape as the JSON path");
  assert.deepEqual(JSON.parse(readFileSync(join(OUT, "ADCT.json"), "utf8")).map((x) => x.f),
    ["RBC Capital", "Guggenheim", "Stephens"]);
  // a filteredCount of exactly 1 is still > 0 — the boundary
  assert.equal(shouldFallBack([], { expertRatingsFilteredCount: 1 }), true, "filteredCount=1 must fall back");
}

/* ------------------------- 3. JSON empty AND filteredCount === 0 -> NO fallback at all */
{
  // TipRanks genuinely covers nobody. Fetching the 260 KB page would be pure waste and
  // would parse to [] anyway.
  const r = runTicker({ ticker: "NOCOV", jsonRows: [], data: { expertRatingsFilteredCount: 0 }, page: PAGE, out: OUT });
  assert.equal(r.fetchedPage, false, "filteredCount=0 means nothing was withheld — do not fetch");
  assert.equal(r.viaHtml, false);
  assert.equal(r.wrote, false, "nothing to write");
  assert.equal(existsSync(join(OUT, "NOCOV.json")), false, "no file may be created for a genuinely uncovered ticker");
  assert.equal(r.stamped, true, "but _asOf IS stamped on empty, so it rotates out of the LIMIT queue");
}

/* ----------------------------- 4. filteredCount absent / undefined / null / odd types */
{
  // `undefined > 0` and `null > 0` are both false, so a payload that never carries the
  // field takes the cheap path. That is the intended conservative default: an older or
  // changed payload shape must not start hammering the SSR page for all ~300 tickers.
  assert.equal(shouldFallBack([], {}), false, "field absent -> no fallback");
  assert.equal(shouldFallBack([], { expertRatingsFilteredCount: undefined }), false, "undefined -> no fallback");
  assert.equal(shouldFallBack([], { expertRatingsFilteredCount: null }), false, "null -> no fallback");
  assert.equal(shouldFallBack([], { expertRatingsFilteredCount: NaN }), false, "NaN -> no fallback");
  assert.equal(shouldFallBack([], { expertRatingsFilteredCount: -1 }), false, "a negative count -> no fallback");
  assert.equal(shouldFallBack([], { expertRatingsFilteredCount: false }), false, "false -> no fallback");
  assert.equal(shouldFallBack([], { expertRatingsFilteredCount: "" }), false, "empty string -> no fallback");
  // FINDING (reported, not fixed): the comparison is `>` on a raw value, so a payload that
  // ever ships the count as a STRING silently keeps working ("4" > 0 is true) — fine — but
  // "" and null read as "nothing withheld" rather than "unknown". Documented, and both are
  // the safe direction (skip the fetch), so no change requested.
  assert.equal(shouldFallBack([], { expertRatingsFilteredCount: "4" }), true, "a stringified count still falls back");
  for (const r of [{}, { experts: [] }, { experts: null }]) {
    assert.equal(shouldFallBack([], r), false, "a payload with no count and no experts -> no fallback");
    assert.equal(runTicker({ ticker: "SKIP", jsonRows: [], data: r, page: PAGE, out: OUT }).wrote, false);
  }
  assert.equal(existsSync(join(OUT, "SKIP.json")), false);
}

/* ================ 5. the fallback itself yields [] -> the EXISTING FILE IS LEFT ALONE */
{
  // The failure mode that would be worst of all: the gate fires, TipRanks has changed its
  // markup (or served a 403 body), the parser correctly returns [], and we overwrite a good
  // file with `[]` — turning a stale forecast into a missing one across the whole universe
  // in a single run. `if (fc.length)` is the guard. Pin it against real bad-input shapes.
  const GOOD = [{ n: "Kept Analyst", f: "Kept Firm", st: 3, r: "Buy", pt: 9, opt: null, d: "2026-06-01" }];
  const badPages = {
    "empty body": "",
    "cloudflare 403 body": "<html><body>Access denied</body></html>",
    "getData JSON served instead of the page": JSON.stringify({ experts: [] }),
    "markup change: analyst link path renamed": PAGE.replaceAll("/experts/analysts/", "/experts/analyst-profile/"),
    "markup change: column header renamed": PAGE.replaceAll("Analyst Profile", "Analyst"),
    "markup change: date format": PAGE.replace(/<span>(\d{2})\/(\d{2})\/(\d{2})<\/span>/g, "<span>20$3-$1-$2</span>"),
    "table header only, no rows": PAGE.slice(0, PAGE.indexOf('<div class="rt-tr-group">')),
  };
  for (const [label, page] of Object.entries(badPages)) {
    const file = join(OUT, "KEEP.json");
    writeFileSync(file, JSON.stringify(GOOD));
    const r = runTicker({ ticker: "KEEP", jsonRows: [], data: { expertRatingsFilteredCount: 4 }, page, out: OUT });
    assert.equal(r.fetchedPage, true, `${label}: the gate still fires`);
    assert.equal(r.viaHtml, false, `${label}: an empty parse must not count as an HTML success`);
    assert.equal(r.wrote, false, `${label}: an empty parse must NOT be written`);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), GOOD,
      `${label}: the existing file must be left untouched, never overwritten with []`);
  }
  // and the same for a ticker that has no file yet — no file must be created either
  const fresh = join(OUT, "FRESH.json");
  assert.equal(runTicker({ ticker: "FRESH", jsonRows: [], data: { expertRatingsFilteredCount: 4 }, page: "", out: OUT }).wrote, false);
  assert.equal(existsSync(fresh), false, "an empty parse must not create an empty file");
}

/* ------------------------------- 6. a page that parses but joins no stars still writes */
{
  // withStars is applied to the fallback rows with the SAME `data` that was empty of usable
  // experts. It must not filter anything out — a row with st:null is still a forecast.
  const r = runTicker({ ticker: "NOSTARS", jsonRows: [], data: { expertRatingsFilteredCount: 4, experts: [] }, page: PAGE, out: OUT });
  assert.equal(r.wrote, true);
  assert.equal(r.rows.length, 3, "withStars must not drop rows just because no stars joined");
  assert.ok(r.rows.every((x) => x.st === null), "st is null, not undefined — JSON.stringify would drop undefined");
  assert.equal(JSON.parse(readFileSync(join(OUT, "NOSTARS.json"), "utf8"))[0].st, null,
    "st must survive the JSON round-trip as null (undefined would vanish and break the app's Forecast type)");
}

/* --------------------------------------------------------------- SOURCE FIDELITY
   The mirror above is only worth anything if it still matches the scraper. Assert the two
   load-bearing source lines verbatim. If this fails, the scraper changed — update BOTH. */
{
  const src = readFileSync(new URL("./scrape-forecasts.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("if (!fc.length && data.expertRatingsFilteredCount > 0) {"),
    "GATE MOVED: ci/scrape-forecasts.mjs no longer contains the mirrored gate condition — update shouldFallBack() in this file to match");
  assert.ok(src.includes("const rows = withStars(parseForecastHtml(page), data);"),
    "FALLBACK MOVED: the withStars(parseForecastHtml(page), data) call changed — update runTicker() in this file");
  assert.ok(src.includes("if (rows.length) { fc = rows;"),
    "EMPTY-PARSE GUARD MOVED: `if (rows.length)` is what stops an empty parse replacing good JSON rows — update runTicker()");
  assert.ok(src.includes("if (fc.length) { writeFileSync("),
    "WRITE GUARD MOVED: `if (fc.length)` is what stops [] being written over an existing file — update runTicker()");
  assert.ok(!/^\s*import\s.*scrape-forecasts/m.test(readFileSync(new URL("./test-forecast-gate.mjs", import.meta.url), "utf8")),
    "this test must never import scrape-forecasts.mjs — its module body runs a live scrape");
}

rmSync(OUT, { recursive: true, force: true }); // only on success — a failure leaves the evidence

console.log("forecast HTML-fallback gate: ok (gate truth table, empty-parse write guard, source fidelity)");
