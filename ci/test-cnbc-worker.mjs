// worker/cnbc.js — CNBC's display strings -> plain numbers. Run: node ci/test-cnbc-worker.mjs
//
// CNBC's quote service is undocumented and sends every number as a display string
// ("1,270.75", "+1.32%", "UNCH", "5.02T", "0.00" for an empty open). A parser that drops the
// comma handling reads LLY at $1 — every alert on it fires. The fixture is a trimmed copy of a
// real 500-ticker pre-market response (2026-10-22): AAPL, LLY (commas), GETY (realTime
// "false", OTC-mapped), LMFA (code 1 = unknown), SQNS (ADR), PROK (UNCH day), CRIS (sub-dollar,
// ExtendedMktQuote POST_MKT_PREV).
//
// Also cross-checks that the browser's normSym (src/quotes.ts) and the Worker's agree — the
// client keys CNBC answers by its own canon, so any drift silently loses quotes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHUNK,
  MAX_SYMBOLS,
  normSym,
  parseQuote,
  parseSymbols,
  rowsBySymbol,
  toChg,
  toNum,
  toScaled,
} from "../worker/cnbc.js";
import { batchStale, etClock, finnhubSymbols, mergeQuotes, normSym as clientNormSym } from "../src/quotes.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, "fixtures", "cnbc-quotes.json"), "utf8"));

let failed = 0;
let passed = 0;
// Float multiply noise (4.06 * 1e6 = 4059999.9999999995) is not a parse error: compare to 1e-9 relative.
const near = (got, want, msg) => assert.ok(Math.abs(got - want) <= Math.abs(want) * 1e-9, `${msg ?? ""} got ${got}, want ${want}`);
function t(label, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}: ${e.message}`);
  }
}

// ---- toNum ------------------------------------------------------------------------
t("toNum: comma thousands -> 1270.75, never 1", () => {
  assert.equal(toNum("1,270.75"), 1270.75);
  assert.equal(toNum("31,018,583"), 31018583);
});
t("toNum: % and + signs stripped", () => {
  assert.equal(toNum("+1.32%"), 1.32);
  assert.equal(toNum("-1.01%"), -1.01);
  assert.equal(toNum("+4.49"), 4.49);
  assert.equal(toNum("-1.9019%"), -1.9019);
});
t("toNum: $ and whitespace stripped", () => {
  assert.equal(toNum("$4"), 4);
  assert.equal(toNum(" 12.5 "), 12.5);
});
t("toNum: sub-penny and leading-dot", () => {
  assert.equal(toNum("0.0193"), 0.0193);
  assert.equal(toNum(".5"), 0.5);
});
t("toNum: scientific (CNBC's pcttendayvol '1.0E-4')", () => assert.equal(toNum("1.0E-4"), 0.0001));
t("toNum: UNCH / empty / N/A / junk -> null", () => {
  for (const v of ["UNCH", "", " ", "N/A", "--", "1.2.3", "abc", "1.", "-", "+"]) assert.equal(toNum(v), null, JSON.stringify(v));
});
t("toNum: numbers pass, non-finite -> null", () => {
  assert.equal(toNum(3.5), 3.5);
  assert.equal(toNum(0), 0);
  assert.equal(toNum(Infinity), null);
  assert.equal(toNum(NaN), null);
});
t("toNum: non-string non-number -> null", () => {
  for (const v of [null, undefined, {}, [], true]) assert.equal(toNum(v), null);
});

// ---- toChg ------------------------------------------------------------------------
t("toChg: UNCH is 0, not missing (any case / padding)", () => {
  assert.equal(toChg("UNCH"), 0);
  assert.equal(toChg(" unch "), 0);
});
t("toChg: otherwise behaves like toNum", () => {
  assert.equal(toChg("+15.25"), 15.25);
  assert.equal(toChg("-12.91"), -12.91);
  assert.equal(toChg("+1.20%"), 1.2);
  assert.equal(toChg(""), null);
  assert.equal(toChg(undefined), null);
});

// ---- toScaled ---------------------------------------------------------------------
t("toScaled: K/M/B/T suffixes", () => {
  near(toScaled("61.1K"), 61100);
  near(toScaled("4.06M"), 4.06e6);
  near(toScaled("890.997B"), 890.997e9);
  near(toScaled("5.02T"), 5.02e12);
});
t("toScaled: lower-case suffix and inner space", () => {
  near(toScaled("4.06m"), 4.06e6);
  assert.equal(toScaled("2 B"), 2e9);
});
t("toScaled: plain and comma numbers, no suffix", () => {
  assert.equal(toScaled("1,234"), 1234);
  assert.equal(toScaled("0.09M"), 90000);
});
t("toScaled: junk -> null", () => {
  for (const v of ["", "N/A", "4.06X", "M", "1.2.3M"]) assert.equal(toScaled(v), null, JSON.stringify(v));
});
t("toScaled: non-string delegates to toNum", () => {
  assert.equal(toScaled(7), 7);
  assert.equal(toScaled(null), null);
});

// ---- normSym / parseSymbols -------------------------------------------------------
t("normSym: class-share separators -> dot", () => {
  for (const v of ["BRK-B", "brk_b", "BRK/B", "brk.b", " BRK-B "]) assert.equal(normSym(v), "BRK.B", v);
});
t("normSym: plain tickers upper-cased", () => {
  assert.equal(normSym("aapl"), "AAPL");
  assert.equal(normSym("BRK"), "BRK");
  assert.equal(normSym("A"), "A");
  assert.equal(normSym("GOOGL"), "GOOGL");
  assert.equal(normSym("ABCDEF"), "ABCDEF"); // 6 chars: the max
});
t("normSym: junk -> null", () => {
  for (const v of ["", " ", "1ABC", "ABCDEFG", "^GSPC", "BRK.BCD", "BRK-B-C", "AA PL", "$AAPL", "A.B.C", "EUR=X", "."]) {
    assert.equal(normSym(v), null, JSON.stringify(v));
  }
  assert.equal(normSym(null), null);
  assert.equal(normSym(42), null);
});
t("normSym: Worker and client (src/quotes.ts) agree on a shared corpus", () => {
  const corpus = ["AAPL", "aapl", "BRK-B", "brk_b", "BRK/B", "BRK.B", "BRK", "GOOGL", "ABCDEF", "ABCDEFG", "1ABC", "^GSPC", "", " msft ", "A.B.C", "BF-A"];
  for (const v of corpus) assert.equal(clientNormSym(v), normSym(v), JSON.stringify(v));
});
t("parseSymbols: dedupes after normalizing, keeps first-seen order", () => {
  assert.deepEqual(parseSymbols("A,b,BRK-B,A,brk.b"), ["A", "B", "BRK.B"]);
});
t("parseSymbols: empty / malformed / empty segment -> null", () => {
  assert.equal(parseSymbols(""), null);
  assert.equal(parseSymbols(null), null);
  assert.equal(parseSymbols("AAPL,,MSFT"), null);
  assert.equal(parseSymbols("AAPL,^GSPC"), null);
  assert.equal(parseSymbols(","), null);
});
const syms = (n) => Array.from({ length: n }, (_, i) => `S${i}`);
t(`parseSymbols: exactly MAX_SYMBOLS (${MAX_SYMBOLS}) accepted`, () => {
  assert.equal(parseSymbols(syms(MAX_SYMBOLS).join(","))?.length, MAX_SYMBOLS);
});
t(`parseSymbols: ${MAX_SYMBOLS + 1} -> null (Worker answers 400)`, () => {
  assert.equal(parseSymbols(syms(MAX_SYMBOLS + 1).join(",")), null);
});
t("parseSymbols: 301 raw that dedupe to 300 are accepted (cap is on unique symbols)", () => {
  assert.equal(parseSymbols([...syms(300), "S0"].join(","))?.length, 300);
});
t("CHUNK divides the cap into a handful of CNBC calls", () => {
  assert.equal(CHUNK, 100);
  assert.equal(MAX_SYMBOLS, 300);
});

// ---- rowsBySymbol -----------------------------------------------------------------
t("rowsBySymbol: fixture keyed by upper-case symbol", () => {
  const rows = rowsBySymbol(FIXTURE);
  assert.deepEqual(Object.keys(rows).sort(), ["AAPL", "CRIS", "GETY", "LLY", "LMFA", "PROK", "SQNS"]);
  assert.equal(rows.LLY.last, "1,270.75");
});
t("rowsBySymbol: lower-case symbol upper-cased, symbol-less rows skipped", () => {
  const rows = rowsBySymbol({ FormattedQuoteResult: { FormattedQuote: [{ symbol: "aapl", code: 0 }, { code: 0 }, null] } });
  assert.deepEqual(Object.keys(rows), ["AAPL"]);
});
t("rowsBySymbol: empty FormattedQuote is fine (not malformed)", () => {
  assert.deepEqual(rowsBySymbol({ FormattedQuoteResult: { FormattedQuote: [] } }), {});
});
t("rowsBySymbol: malformed envelope throws", () => {
  for (const b of [null, undefined, {}, { FormattedQuoteResult: {} }, { FormattedQuoteResult: { FormattedQuote: {} } }, "x", []]) {
    assert.throws(() => rowsBySymbol(b), /unexpected envelope/, JSON.stringify(b));
  }
});

// ---- parseQuote on the real fixture -----------------------------------------------
const R = rowsBySymbol(FIXTURE);
t("parseQuote AAPL: price, change, prior close = last - change", () => {
  const q = parseQuote(R.AAPL);
  assert.equal(q.px, 343.99);
  assert.equal(q.chg, 4.49);
  assert.equal(q.pct, 1.32);
  assert.equal(q.pc, 339.5);
  assert.equal(q.day, "2026-10-21");
});
t("parseQuote AAPL: pc is NOT previous_day_closing (which equals last off-hours)", () => {
  assert.equal(R.AAPL.previous_day_closing, R.AAPL.last); // the trap, as CNBC sends it
  assert.notEqual(parseQuote(R.AAPL).pc, 343.99);
});
t("parseQuote AAPL: '0.00' open/high/low off-hours -> null", () => {
  const q = parseQuote(R.AAPL);
  assert.equal(q.o, null);
  assert.equal(q.h, null);
  assert.equal(q.l, null);
});
t("parseQuote AAPL: fundamentals parsed", () => {
  const q = parseQuote(R.AAPL);
  assert.equal(q.name, "Apple Inc.");
  assert.equal(q.mc, 5020000); // 5.02T in $ millions
  assert.equal(q.hi52, 348.15);
  assert.equal(q.lo52, 243.42);
  assert.equal(q.pe, 39.58);
  assert.equal(q.fpe, 37.12);
  assert.equal(q.eps, 8.69);
  assert.equal(q.beta, 1.08);
  near(q.vol10, 39.39e6);
});
t("parseQuote AAPL: PRE_MKT ext parsed with timestamp", () => {
  const q = parseQuote(R.AAPL);
  assert.deepEqual(q.ext, { type: "pre", px: 343.48, chg: -0.51, pct: -0.15, t: Date.parse("2026-10-22T08:17:34.689-04:00") });
  assert.ok(Number.isFinite(q.ext.t));
});
t("parseQuote LLY: comma prices everywhere (last, 52w high, ext)", () => {
  const q = parseQuote(R.LLY);
  assert.equal(q.px, 1270.75);
  assert.equal(q.chg, -12.91);
  assert.equal(q.pc, 1283.66);
  assert.equal(q.hi52, 1311.75);
  assert.equal(q.ext.px, 1286);
  assert.equal(q.ext.chg, 15.25);
  assert.equal(q.mc, 1196000); // 1.196T
});
t("parseQuote GETY: realTime 'false' (OTC-mapped GETYQ) -> null", () => {
  assert.equal(R.GETY.realTime, "false");
  assert.equal(parseQuote(R.GETY), null);
});
t("parseQuote: realTime missing -> null", () => {
  const { realTime, ...row } = R.AAPL;
  assert.equal(parseQuote(row), null);
});
t("parseQuote LMFA: code 1 (unknown) -> null", () => assert.equal(parseQuote(R.LMFA), null));
t("parseQuote: code other than 0 -> null even if fields look fine", () => {
  assert.equal(parseQuote({ ...R.AAPL, code: 2 }), null);
  assert.equal(parseQuote({ ...R.AAPL, code: "0" }), null);
});
t("parseQuote: absent row (CNBC dropped the symbol) -> null", () => {
  assert.equal(parseQuote(undefined), null);
  assert.equal(parseQuote(null), null);
});
t("parseQuote: non-USD -> null; missing currency allowed", () => {
  assert.equal(parseQuote({ ...R.AAPL, currencyCode: "CAD" }), null);
  const { currencyCode, ...row } = R.AAPL;
  assert.equal(parseQuote(row)?.px, 343.99);
});
t("parseQuote: last '0.00' / 'UNCH' / missing -> null (no usable price)", () => {
  assert.equal(parseQuote({ ...R.AAPL, last: "0.00" }), null);
  assert.equal(parseQuote({ ...R.AAPL, last: "UNCH" }), null);
  assert.equal(parseQuote({ ...R.AAPL, last: undefined }), null);
  assert.equal(parseQuote({ ...R.AAPL, last: "-1.00" }), null);
});
t("parseQuote SQNS (ADR): prior close re-derived = 2.42", () => {
  const q = parseQuote(R.SQNS);
  assert.equal(q.px, 2.54);
  assert.equal(q.pc, 2.42);
  assert.equal(q.pct, 4.96);
  assert.equal(q.pe, -0.26); // raw; the modal's mergeModal decides what to do with <= 0
  assert.equal(q.ext, null); // no ExtendedMktQuote on this row
  near(q.vol10, 90000);
});
t("parseQuote PROK: UNCH day -> chg 0, pct 0, pc = px", () => {
  const q = parseQuote(R.PROK);
  assert.equal(q.chg, 0);
  assert.equal(q.pct, 0);
  assert.equal(q.pc, 1.44);
  assert.deepEqual({ chg: q.ext.chg, pct: q.ext.pct }, { chg: 0, pct: 0 });
});
t("parseQuote CRIS: sub-dollar prior close rounded to 4dp (0.392 - -0.0076)", () => {
  const q = parseQuote(R.CRIS);
  assert.equal(q.px, 0.392);
  assert.equal(q.pc, 0.3996);
  assert.equal(q.pct, -1.9019);
});
t("parseQuote CRIS: ExtendedMktQuote POST_MKT_PREV (yesterday's after-hours) -> ext null", () => {
  assert.equal(R.CRIS.ExtendedMktQuote.type, "POST_MKT_PREV");
  assert.equal(parseQuote(R.CRIS).ext, null);
});
t("parseQuote: POST_MKT ext -> type 'post'", () => {
  const q = parseQuote({ ...R.AAPL, ExtendedMktQuote: { ...R.AAPL.ExtendedMktQuote, type: "POST_MKT" } });
  assert.equal(q.ext.type, "post");
});
t("parseQuote: ext with '0.00' last -> no ext", () => {
  const q = parseQuote({ ...R.AAPL, ExtendedMktQuote: { ...R.AAPL.ExtendedMktQuote, last: "0.00" } });
  assert.equal(q.ext, null);
});
t("parseQuote: ext with unparseable time keeps px, t null", () => {
  const q = parseQuote({ ...R.AAPL, ExtendedMktQuote: { ...R.AAPL.ExtendedMktQuote, last_time: "8:17 AM" } });
  assert.equal(q.ext.px, 343.48);
  assert.equal(q.ext.t, null);
});
t("parseQuote: change missing -> chg/pct/pc null, price still served", () => {
  const q = parseQuote({ ...R.AAPL, change: "", change_pct: "N/A" });
  assert.equal(q.px, 343.99);
  assert.deepEqual([q.chg, q.pct, q.pc], [null, null, null]);
});
t("parseQuote: change that implies a non-positive prior close -> pc null", () => {
  assert.equal(parseQuote({ ...R.AAPL, last: "5.00", change: "+5.00" }).pc, null);
  assert.equal(parseQuote({ ...R.AAPL, last: "5.00", change: "+6.00" }).pc, null);
});
t("parseQuote: in-session open/high/low parsed with commas", () => {
  const q = parseQuote({ ...R.LLY, open: "1,268.00", high: "1,290.10", low: "1,260.25" });
  assert.deepEqual([q.o, q.h, q.l], [1268, 1290.1, 1260.25]);
});
t("parseQuote: day = the date part of last_time (bare date off-hours, ISO in the session)", () => {
  assert.equal(parseQuote({ ...R.AAPL, last_time: "2026-10-21" }).day, "2026-10-21");
  assert.equal(parseQuote({ ...R.AAPL, last_time: "2026-10-22T09:32:54.175-0400" }).day, "2026-10-22");
});
t("parseQuote: last_time without a leading date -> day null", () => {
  assert.equal(parseQuote({ ...R.AAPL, last_time: "10/21/26" }).day, null);
  assert.equal(parseQuote({ ...R.AAPL, last_time: undefined }).day, null);
  assert.equal(parseQuote({ ...R.AAPL, last_time: 20261021 }).day, null);
});
t("parseQuote: mktcap suffixes -> $ millions; junk/zero -> null", () => {
  assert.equal(parseQuote({ ...R.AAPL, mktcapView: "61.1K" }).mc, 0.0611);
  assert.equal(parseQuote({ ...R.AAPL, mktcapView: "435.345M" }).mc, 435.345);
  assert.equal(parseQuote({ ...R.AAPL, mktcapView: "890.997B" }).mc, 890997);
  assert.equal(parseQuote({ ...R.AAPL, mktcapView: "0" }).mc, null);
  assert.equal(parseQuote({ ...R.AAPL, mktcapView: "N/A" }).mc, null);
  assert.equal(parseQuote({ ...R.AAPL, mktcapView: undefined }).mc, null);
});
t("parseQuote: blank name -> null; name trimmed", () => {
  assert.equal(parseQuote({ ...R.AAPL, name: "   " }).name, null);
  assert.equal(parseQuote({ ...R.AAPL, name: " Apple " }).name, "Apple");
});
t("parseQuote: 52w low '0.00' (GETY-style) -> null, not $0", () => {
  assert.equal(parseQuote({ ...R.AAPL, yrloprice: "0.00" }).lo52, null);
});
t("parseQuote: every fixture row yields null or a quote with a positive numeric px", () => {
  for (const [s, row] of Object.entries(R)) {
    const q = parseQuote(row);
    if (q) assert.ok(typeof q.px === "number" && q.px > 0, s);
  }
});

// ---- Worker parse -> client merge, end to end on the real payload ------------------------------
// What the browser receives is { SYMBOL: parseQuote(row) } — feed that straight into the
// client's rules, so a shape drift between worker/cnbc.js and src/quotes.ts fails here.
const served = Object.fromEntries(Object.entries(R).map(([s, row]) => [s, parseQuote(row)]));
const CNBC_ON = { source: "cnbc", fails: 0 };
t("pipeline: LLY reaches the price map as 1270.75, AAPL as 343.99", () => {
  const { price, pct } = mergeQuotes(["LLY", "AAPL"], served, CNBC_ON, { LLY: 1, AAPL: 1 }, {});
  assert.deepEqual(price, { LLY: 1270.75, AAPL: 343.99 });
  assert.deepEqual(pct, { LLY: -1.01, AAPL: 1.32 });
});
t("pipeline: GETY + LMFA (null at CNBC) go to Finnhub; quoted ones do not", () => {
  assert.deepEqual(finnhubSymbols(["AAPL", "GETY", "LMFA", "LLY", "QNCX"], served, CNBC_ON), ["GETY", "LMFA"]);
});
t("pipeline: GETY is priced by Finnhub, AAPL by CNBC, in the same merge", () => {
  const { price } = mergeQuotes(["GETY", "AAPL"], served, CNBC_ON, { GETY: 0.02, AAPL: 999 }, {});
  assert.deepEqual(price, { GETY: 0.02, AAPL: 343.99 });
});
t("pipeline: this pre-market payload (all dated 10-21) is fine at 08:30 ET 10-22…", () => {
  assert.equal(batchStale(served, etClock(new Date("2026-10-22T12:30:00Z"))), false);
});
t("pipeline: …but the same payload at 10:00 ET 10-22 is a frozen cache (stale)", () => {
  assert.equal(batchStale(served, etClock(new Date("2026-10-22T14:00:00Z"))), true);
});
t("pipeline: the payload's quotes are JSON-safe (what the Worker serializes)", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(served)), served);
});

// ---- in-session payload (captured 2026-10-22 09:33 ET) -----------------------------------
// The off-hours fixture above never shows the session shape: ISO `last_time`, real
// open/high/low, and a correct previous_day_closing. Day must come out as today's date, or
// every in-session batch reads as stale and the whole session falls to Finnhub.
const SESSION = rowsBySymbol(JSON.parse(readFileSync(path.join(HERE, "fixtures", "cnbc-quotes-session.json"), "utf8")));
t("in-session AAPL: today's day, O/H/L present, pc = last - change = previous_day_closing", () => {
  const q = parseQuote(SESSION.AAPL);
  assert.equal(q.day, "2026-10-22");
  assert.deepEqual([q.px, q.o, q.h, q.l], [345.69, 344.94, 347.28, 344.6]);
  assert.equal(q.pc, 343.99);
  assert.equal(q.pc, parseQuote(SESSION.AAPL).pc);
});
t("in-session LLY: comma prices everywhere", () => {
  const q = parseQuote(SESSION.LLY);
  assert.deepEqual([q.px, q.o, q.h, q.l, q.pc], [1279.17, 1281.76, 1288.89, 1275.1, 1270.76]);
});
t("in-session PROK: UNCH -> 0 change, pc = px", () => {
  const q = parseQuote(SESSION.PROK);
  assert.deepEqual([q.chg, q.pct, q.pc], [0, 0, 1.44]);
});
t("in-session batch is NOT stale at 10:00 ET (would hand the session to Finnhub)", () => {
  const quotes = Object.fromEntries(Object.entries(SESSION).map(([k, r]) => [k, parseQuote(r)]));
  assert.equal(batchStale(quotes, { ymd: "2026-10-22", mins: 600, weekend: false }), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} cnbc.js check(s) failed`);
console.log("cnbc.js parser OK");
