// Checks for ci/sec-reports.mjs's pure date picking — run by `npm test`.
import assert from "node:assert/strict";
import { pickReports, rowsOf } from "./sec-reports.mjs";

const r = (form, filingDate, extra = {}) => ({ form, filingDate, reportDate: "", items: "", accepted: `${filingDate}T08:00:00.000Z`, size: 1000, ...extra });

// US filer: preliminary 2.02 in January, full release later, then the 10-K
const us = [
  r("8-K", "2026-01-12", { items: "2.02,7.01" }), // pre-announcement — the FIRST announcement wins
  r("8-K", "2026-02-05", { items: "2.02,9.01", accepted: "2026-02-05T16:05:00.000Z" }),
  r("8-K/A", "2026-01-10", { items: "2.02" }), // amendment: ignored
  r("8-K", "2026-01-20", { items: "5.02" }), // not results
  r("10-K", "2026-02-20", { reportDate: "2025-12-31" }),
  r("8-K", "2025-10-30", { items: "2.02", accepted: "2025-10-30T16:30:00.000Z" }), // after close
  r("10-Q", "2025-10-31", { reportDate: "2025-09-27" }), // 52/53-week fiscal quarter end
  r("10-Q", "2025-08-05", { reportDate: "2025-06-30" }), // no 2.02 at all for this one
];
// the Jan-12 2.02 is a genuine preliminary release; the Jan-20 one would be read and rejected
const got = await pickReports(us, ["2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31"]);
assert.equal(got["2025-12-31"], "2026-01-12", "the first 2.02 after the quarter, before its 10-K, counts (pre-announcement)");
assert.equal(got["2025-09-30"], "2025-10-31", "an after-close (>= 16:00) release counts from the next day; fiscal end matched within a week");
assert.equal(got["2025-06-30"], "2025-08-05", "no 2.02: the 10-Q filing date");
assert.equal(got["2026-03-31"], undefined, "a quarter not reported yet has no date");

// 2+ candidates: each is read; the first with results wording wins (ABBV-style guidance 8-K skipped)
const noisy = [
  r("8-K", "2025-07-03", { items: "2.02", acc: "a" }), // IPR&D guidance
  r("8-K", "2025-07-31", { items: "2.02,9.01", acc: "b" }), // the results
  r("10-Q", "2025-08-05", { reportDate: "2025-06-30" }),
];
const picked = await pickReports(noisy, ["2025-06-30"], async (row) => row.acc === "b");
assert.equal(picked["2025-06-30"], "2025-07-31", "a non-results 2.02 is skipped");
const none = await pickReports(noisy, ["2025-06-30"], async () => false);
assert.equal(none["2025-06-30"], "2025-07-31", "none reads as results: the one closest to the 10-Q");

// 6-K filer: period must be the quarter AND clearly before the filing; earliest results-sized one
const fx = [
  r("6-K", "2026-07-03", { reportDate: "2026-07-03", size: 900_000 }), // period = filing date: not results
  r("6-K", "2026-07-10", { reportDate: "2026-06-30", size: 90_000 }), // monthly revenue note: too small
  r("6-K", "2026-07-16", { reportDate: "2026-06-30", size: 1_300_000 }), // the results
  r("6-K", "2026-08-14", { reportDate: "2026-06-30", size: 3_000_000 }), // full statements, later
];
assert.equal((await pickReports(fx, ["2026-06-30"]))["2026-06-30"], "2026-07-16", "6-K: earliest results-sized one whose period precedes its filing");
assert.equal((await pickReports(fx.slice(0, 2), ["2026-06-30"]))["2026-06-30"], undefined, "no qualifying 6-K: no date (the 35-day guess)");
// a filer that moved to 10-Q filing: that quarter uses the 10-Q rule
const switched = [...fx, r("10-Q", "2026-08-10", { reportDate: "2026-06-30" })];
assert.equal((await pickReports(switched, ["2026-06-30"]))["2026-06-30"], "2026-08-10", "a quarter with a 10-Q follows the US rule");

// EDGAR's column-oriented block
const rows = rowsOf({ form: ["8-K"], filingDate: ["2026-01-02"], reportDate: [""], items: ["2.02"], acceptanceDateTime: ["2026-01-02T09:00:00.000Z"], size: [5] });
assert.deepEqual(rows[0], { form: "8-K", filingDate: "2026-01-02", reportDate: "", items: "2.02", accepted: "2026-01-02T09:00:00.000Z", size: 5, acc: "", doc: "" });

console.log("sec-reports OK — 11 assertions");
