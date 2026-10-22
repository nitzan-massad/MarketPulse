// worker/bars.js — CNBC chart bars, the pure half: range -> upstream URL, parsing into Twelve
// Data's stamp shapes, regular-hours trimming, and split-only closes for the P/E history.
// Run: node ci/test-cnbc-bars.mjs
//
// Why each block exists:
//   • barsUrl — the SERVER owns the window (CNBC doesn't cap it: 5M for a year is 2 MB), and a
//     day-granular URL lets CNBC's own cache answer repeats.
//   • parseBars — the chart, its 1D session logic and peHistory read Twelve Data's stamp shapes;
//     CNBC stamps weeks on SUNDAY and includes 04:00-20:00 bars.
//   • splitOnlyCloses — CNBC's "adjusted" also back-adjusts spin-offs (CTVA 6.665x), which would
//     chart pre-spin P/E 6.7x too low; splits must stay adjusted.
// Fixtures in ci/fixtures/cnbc-bars/ are real CNBC answers (trimmed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { barsUrl, CNBC_BARS, etToday, isRth, mondayOf, NoData, parseBars, RANGES, sessionStarted, splitOnlyCloses } from "../worker/bars.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = (n) => JSON.parse(readFileSync(path.join(HERE, "fixtures", "cnbc-bars", `${n}.json`), "utf8"));
let failed = 0;
let passed = 0;
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
const at = (iso) => Date.parse(iso);
const NOW = at("2026-10-22T16:59:00Z"); // Thu 12:59 ET
const path6 = (u) => u.slice(CNBC_BARS.length).split("/");

// ---- etToday / barsUrl ------------------------------------------------------------------------
t("etToday: New York date, not UTC", () => {
  assert.deepEqual(etToday(at("2026-10-23T03:30:00Z")), { y: 2026, m: 10, d: 22 }); // 23:30 ET
  assert.deepEqual(etToday(at("2026-10-22T04:30:00Z")), { y: 2026, m: 10, d: 22 }); // 00:30 ET
  assert.deepEqual(etToday(at("2026-03-08T04:30:00Z")), { y: 2026, m: 3, d: 7 }); // 23:30 EST, DST night
  assert.deepEqual(etToday(at("2026-11-01T05:30:00Z")), { y: 2026, m: 11, d: 1 }); // 01:30 EDT/EST
});
t("barsUrl: interval + day-granular window per range (end = tomorrow 00:00 ET)", () => {
  const want = {
    "1D": ["5M", "20261022000000"], // session under way: today only
    "1W": ["30M", "20261012000000"],
    "1M": ["1D", "20260922000000"],
    "3M": ["1D", "20260722000000"],
    "6M": ["1D", "20260422000000"],
    YTD: ["1D", "20251220000000"],
    "1Y": ["1D", "20251022000000"],
    "2Y": ["1D", "20241022000000"],
    "5Y": ["1W", "20211022000000"],
    ALL: ["1MO", "19700101000000"],
    PE: ["1W", "20211001000000"],
  };
  for (const [r, [int, start]] of Object.entries(want)) {
    const [sym, i, s, e, adj, tz] = path6(barsUrl("AAPL", r, NOW));
    assert.deepEqual([sym, i, s, e, adj, tz], ["AAPL", int, start, "20261023000000", "adjusted", "EST5EDT.json"], r);
  }
  assert.deepEqual(Object.keys(RANGES).sort(), Object.keys(want).sort(), "every range is covered");
});
t("barsUrl: unadjusted on request; dotted class shares stay dotted", () => {
  assert.ok(barsUrl("BRK.B", "PE", NOW, "unadjusted").startsWith(`${CNBC_BARS}BRK.B/1W/`));
  assert.ok(barsUrl("BRK.B", "PE", NOW, "unadjusted").endsWith("/unadjusted/EST5EDT.json"));
});
t("barsUrl: month arithmetic clamps (Mar 31 - 1M = Feb 28; leap Feb 29)", () => {
  assert.equal(path6(barsUrl("A", "1M", at("2026-03-31T16:00:00Z")))[2], "20260228000000");
  assert.equal(path6(barsUrl("A", "1M", at("2028-03-31T16:00:00Z")))[2], "20280229000000");
  assert.equal(path6(barsUrl("A", "3M", at("2026-05-31T16:00:00Z")))[2], "20260228000000");
  assert.equal(path6(barsUrl("A", "1Y", at("2028-02-29T17:00:00Z")))[2], "20270228000000");
});
t("barsUrl: date rollover and year end use ET", () => {
  // 23:30 ET on Dec 31 is already Jan 1 in UTC — still Dec 31 in New York
  const [, , s, e] = path6(barsUrl("A", "1M", at("2027-01-01T04:30:00Z")));
  assert.deepEqual([s, e], ["20261130000000", "20270101000000"]);
  const [, , ys] = path6(barsUrl("A", "YTD", at("2027-01-02T15:00:00Z")));
  assert.equal(ys, "20261220000000");
});
t("1D: today only once the session started; 5 days before 09:30, on weekends, and when `wide`", () => {
  const s1D = (iso, wide) => path6(barsUrl("A", "1D", at(iso), "adjusted", wide))[2];
  assert.equal(s1D("2026-10-22T13:30:00Z"), "20261022000000"); // 09:30 ET Thu
  assert.equal(s1D("2026-10-22T13:29:00Z"), "20261017000000"); // 09:29 ET
  assert.equal(s1D("2026-10-24T16:00:00Z"), "20261019000000"); // Saturday noon
  assert.equal(s1D("2026-10-22T17:00:00Z", true), "20261017000000"); // holiday retry
  assert.equal(s1D("2026-10-23T02:00:00Z"), "20261022000000"); // 22:00 ET: still today's session
});
t("sessionStarted: weekday at/after 09:30 New York, DST-aware", () => {
  assert.equal(sessionStarted(at("2026-10-22T13:30:00Z")), true); // 09:30 EDT
  assert.equal(sessionStarted(at("2026-10-22T13:29:00Z")), false);
  assert.equal(sessionStarted(at("2026-12-01T14:30:00Z")), true); // 09:30 EST
  assert.equal(sessionStarted(at("2026-12-01T14:29:00Z")), false);
  assert.equal(sessionStarted(at("2026-10-24T16:00:00Z")), false); // Saturday
  assert.equal(sessionStarted(at("2026-10-25T16:00:00Z")), false); // Sunday
});
t("1D window reaches the last session after a weekend + Monday holiday", () => {
  // Tue 2026-09-08 pre-market (Labor Day Monday): last session = Fri Sep 4, inside 5 days
  assert.equal(path6(barsUrl("A", "1D", at("2026-09-08T12:00:00Z")))[2], "20260903000000");
});

// ---- isRth / mondayOf -------------------------------------------------------------------------
t("isRth: bar START in 09:30..15:55 (the 16:00 closing-auction bar is out)", () => {
  const f = (hm) => isRth(`20261022${hm}00`);
  assert.deepEqual(["0400", "0925", "0930", "1255", "1555", "1600", "1955"].map(f), [false, false, true, true, true, false, false]);
});
t("mondayOf: Sunday stamp -> next day; other days -> that week's Monday; month/year edges", () => {
  assert.equal(mondayOf("20261018000000"), "2026-10-19");
  assert.equal(mondayOf("20260531000000"), "2026-06-01");
  assert.equal(mondayOf("20261227000000"), "2026-12-28");
  assert.equal(mondayOf("20261022000000"), "2026-10-19"); // a Thursday
  assert.equal(mondayOf("20261019000000"), "2026-10-19"); // Monday stays
});

// ---- parseBars --------------------------------------------------------------------------------
t("1D: a real 04:00-19:55 day (192 bars) -> exactly its 78 regular bars", () => {
  const b = parseBars(F("aapl-5m-day"), "1D", NOW);
  assert.equal(b.t.length, 78);
  assert.match(b.t[0], /^\d{4}-\d{2}-\d{2} 09:30$/);
  assert.match(b.t[77], / 15:55$/);
  assert.equal(new Set(b.t.map((x) => x.slice(0, 10))).size, 1);
  assert.equal(b.c.length, 78);
  assert.ok(b.c.every((c) => c > 0));
});
// synthetic CNBC body: `days` of 5-minute (or 30-minute) bars 04:00-19:55
const ladder = (days, step = 5, upTo = "1955") => {
  const pb = [];
  for (const d of days)
    for (let m = 240; m <= 1195; m += step) {
      const hm = `${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;
      if (hm > upTo && d === days[days.length - 1]) break;
      pb.push({ open: "1", high: "1", low: "1", close: `${100 + m / 1000}`, volume: m, tradeTime: `${d}${hm}00`, tradeTimeinMills: 0 });
    }
  return { barData: { priceBars: pb } };
};
t("1D: several days -> only the LATEST session; mid-session keeps today's partial", () => {
  const b = parseBars(ladder(["20261020", "20261021", "20261022"], 5, "1255"), "1D", NOW);
  assert.equal(b.t[0], "2026-10-22 09:30");
  assert.equal(b.t.at(-1), "2026-10-22 12:55");
  assert.equal(b.t.length, 42);
});
t("1D pre-market: today has only 04:00-09:25 bars -> yesterday's 78", () => {
  const b = parseBars(ladder(["20261021", "20261022"], 5, "0925"), "1D", NOW);
  assert.equal(b.t.length, 78);
  assert.ok(b.t.every((x) => x.startsWith("2026-10-21 ")));
});
t("1W: 30-minute bars over 8 days -> the last 5 sessions x 13 bars (09:30..15:30)", () => {
  const days = ["20261013", "20261014", "20261015", "20261016", "20261019", "20261020", "20261021", "20261022"];
  const b = parseBars(ladder(days, 30), "1W", NOW);
  assert.equal(b.t.length, 65);
  assert.equal(b.t[0], "2026-10-16 09:30");
  assert.equal(b.t.at(-1), "2026-10-22 15:30");
});
t("daily: YYYY-MM-DD stamps, oldest first", () => {
  const b = parseBars(F("aapl-1d"), "1M", NOW);
  assert.ok(b.t.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)));
  assert.ok(b.t.every((x, i) => !i || x > b.t[i - 1]));
});
t("weekly (5Y and PE): Monday stamps; monthly: YYYY-MM-01", () => {
  for (const r of ["5Y", "PE"]) {
    const b = parseBars(F("aapl-1w"), r, NOW);
    assert.ok(b.t.every((x) => new Date(x + "T00:00:00Z").getUTCDay() === 1), r);
  }
  const m = parseBars(F("aapl-1mo"), "ALL", NOW);
  assert.ok(m.t.every((x) => /^\d{4}-\d{2}-01$/.test(x)));
});
t("YTD: the last bar before Jan 1 anchors the year, then this year only", () => {
  const pb = ["20251222", "20251229", "20251231", "20260102", "20260105"].map((d, i) => ({ close: `${10 + i}`, volume: 1, tradeTime: `${d}000000` }));
  const b = parseBars({ barData: { priceBars: pb } }, "YTD", at("2026-01-05T17:00:00Z"));
  assert.deepEqual(b.t, ["2025-12-31", "2026-01-02", "2026-01-05"]);
  assert.deepEqual(b.c, [12, 13, 14]);
});
t("YTD on Jan 1 (no bar this year yet) -> just the anchor", () => {
  const pb = [{ close: "5", volume: 1, tradeTime: "20251231000000" }];
  assert.deepEqual(parseBars({ barData: { priceBars: pb } }, "YTD", at("2026-01-01T17:00:00Z")).t, ["2025-12-31"]);
});
t("string closes parse; commas ok; junk / 0 / negative closes dropped; arrays stay parallel", () => {
  const pb = [
    { close: "343.8100", volume: 5, tradeTime: "20261019000000" },
    { close: "1,270.75", volume: 6, tradeTime: "20261020000000" },
    { close: "", volume: 7, tradeTime: "20261021000000" },
    { close: "N/A", volume: 7, tradeTime: "20261021000000" },
    { close: "0.0000", volume: 7, tradeTime: "20261021000000" },
    { close: "-3", volume: 7, tradeTime: "20261021000000" },
    { close: "12.5", tradeTime: "20261022000000" },
    { close: "13", volume: 1, tradeTime: "bad" },
  ];
  const b = parseBars({ barData: { priceBars: pb } }, "1M", NOW);
  assert.deepEqual(b.t, ["2026-10-19", "2026-10-20", "2026-10-22"]);
  assert.deepEqual(b.c, [343.81, 1270.75, 12.5]);
  assert.equal(b.t.length, b.c.length);
});
t("out-of-order input comes back oldest first", () => {
  const pb = [{ close: "3", tradeTime: "20261022000000" }, { close: "1", tradeTime: "20261020000000" }, { close: "2", tradeTime: "20261021000000" }];
  assert.deepEqual(parseBars({ barData: { priceBars: pb } }, "1M", NOW).c, [1, 2, 3]);
});
t("errors: CNBC's real status:ERROR body -> NoData; reshaped envelope -> plain Error", () => {
  assert.throws(() => parseBars(F("err-unknown-sym"), "1M", NOW), NoData);
  for (const body of [{}, { barData: {} }, { barData: { priceBars: "x" } }, null, "html"]) {
    assert.throws(() => parseBars(body, "1M", NOW), (e) => e instanceof Error && !(e instanceof NoData), JSON.stringify(body));
  }
});
t("no bars left (empty window, or no regular-hours bar) -> NoData", () => {
  assert.throws(() => parseBars({ barData: { priceBars: [] } }, "1M", NOW), NoData);
  const pre = { barData: { priceBars: [{ close: "1", tradeTime: "20261022080000" }] } };
  assert.throws(() => parseBars(pre, "1D", NOW), NoData);
});

// ---- splitOnlyCloses ---------------------------------------------------------------------------
const pair = (s) => [parseBars(F(`${s}-1w-adj`), "PE", NOW), parseBars(F(`${s}-1w-unadj`), "PE", NOW)];
const near = (a, b, tol = 1e-3) => a.every((x, i) => Math.abs(x / b[i] - 1) < tol);
t("split (NVDA 10:1, ORLY 15:1) -> the adjusted closes, unchanged", () => {
  for (const s of ["nvda", "orly"]) {
    const [a, u] = pair(s);
    assert.deepEqual(splitOnlyCloses(a, u), a.c, s);
  }
});
t("spin-off (CTVA 6.665x) -> undone: unadjusted before the spin, adjusted after", () => {
  const [a, u] = pair("ctva");
  const o = splitOnlyCloses(a, u);
  const spin = a.t.indexOf("2026-09-28");
  assert.ok(spin > 0);
  assert.ok(near(o.slice(0, spin), u.c.slice(0, spin)), "pre-spin = unadjusted");
  assert.deepEqual(o.slice(spin), a.c.slice(spin));
});
t("split then a later spin: the split stays, the spin is undone", () => {
  // actual prices 133.3, 133.3 | 2:1 split | 13.33 | spin 6.665x | 1  ->  f = unadj/adj = 13.33, 13.33, 6.665, 1
  const adj = { t: ["w1", "w2", "w3", "w4"], c: [10, 10, 2, 1] };
  const unadj = { t: adj.t, c: [133.3, 133.3, 13.33, 1] };
  const o = splitOnlyCloses(adj, unadj);
  assert.ok(Math.abs(o[2] / 13.33 - 1) < 1e-3, "w3 (pre-spin, post-split) = actual");
  assert.ok(Math.abs(o[0] / (133.3 / 2) - 1) < 1e-3, "w1: spin undone, split kept (actual / 2)");
  assert.equal(o[3], 1);
});
t("reverse split (1:10) is a split: kept", () => {
  const adj = { t: ["a", "b"], c: [50, 5] };
  const unadj = { t: ["a", "b"], c: [5, 5] }; // f 0.1 -> 1
  assert.deepEqual(splitOnlyCloses(adj, unadj), [50, 5]);
});
t("no corporate action (factor 1) -> identity; rounding noise < 1% is ignored", () => {
  const adj = { t: ["a", "b", "c"], c: [10, 11, 12] };
  assert.deepEqual(splitOnlyCloses(adj, { t: adj.t, c: [10.0005, 11, 12.001] }), [10, 11, 12]);
});
t("misaligned weeks -> the adjusted closes, unchanged (never a wrong shift)", () => {
  const adj = { t: ["a", "b"], c: [1, 2] };
  assert.deepEqual(splitOnlyCloses(adj, { t: ["a"], c: [9] }), [1, 2]);
  assert.deepEqual(splitOnlyCloses(adj, { t: ["a", "x"], c: [9, 2] }), [1, 2]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} cnbc bars check(s) failed`);
console.log("cnbc bars OK");
