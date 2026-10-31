// Guards ci/scrape-earnings.mjs's pure parts. The bugs this exists to catch:
//   1. a later quarter (Finnhub lists them too) replacing the NEXT report
//   2. a past report surviving as "next" after its date
//   3. the request windows leaving a day uncovered, or overlapping, so a company is missed
//   4. a full (capped) window that cannot be split looping forever
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { halve, mergeNext, mergeRecent, nearEarnings, windows } from "./scrape-earnings.mjs";

const today = "2026-10-11";
const e = mergeNext(
  [
    { symbol: "WYNN", date: "2027-02-10", hour: "amc" },
    { symbol: "WYNN", date: "2026-11-05", hour: "amc" },
    { symbol: "OLD", date: "2026-10-01", hour: "bmo" },
    { symbol: "aapl ", date: "2026-10-29", hour: "dmh" }, // odd hour -> unknown; symbol normalised
    { symbol: "BAD", date: "soon" },
    { date: "2026-10-20" },
  ],
  today,
);
assert.deepEqual(e, { WYNN: ["2026-11-05", "amc"], AAPL: ["2026-10-29", ""] });

// a later window must not push the date out; a same-day row may fill in an unknown hour
mergeNext([{ symbol: "WYNN", date: "2026-12-01", hour: "bmo" }, { symbol: "AAPL", date: "2026-10-29", hour: "amc" }], today, e);
assert.deepEqual(e.WYNN, ["2026-11-05", "amc"]);
assert.deepEqual(e.AAPL, ["2026-10-29", "amc"]);
assert.deepEqual(mergeNext({ error: "bad key" }, today), {});

// windows tile the horizon exactly: first starts today, each starts the day after the last ends
const w = windows(today, 120, 7);
assert.equal(w[0][0], today);
assert.equal(w.at(-1)[1], "2027-02-07"); // today + 119 days
for (let i = 1; i < w.length; i++) assert.equal(Date.parse(w[i][0]) - Date.parse(w[i - 1][1]), 864e5);
assert.equal(w.length, 18);

// halving also tiles, and a single day stops
assert.deepEqual(halve("2026-10-11", "2026-10-17"), [["2026-10-11", "2026-10-14"], ["2026-10-15", "2026-10-17"]]);
assert.deepEqual(halve("2026-10-11", "2026-10-12"), [["2026-10-11", "2026-10-11"], ["2026-10-12", "2026-10-12"]]);
assert.equal(halve("2026-10-11", "2026-10-11"), null);

// recent keeps each company's latest report inside [from, today) only
assert.deepEqual(
  mergeRecent(
    [
      { symbol: "MU", date: "2026-10-09" },
      { symbol: "MU", date: "2026-10-10" },
      { symbol: "OLD", date: "2026-10-08" }, // before the window
      { symbol: "NOW", date: "2026-10-11" }, // today belongs to `e`, not `recent`
    ],
    "2026-10-09",
    today,
  ),
  { MU: "2026-10-10" },
);

// near = next report within 2 days ahead, or a report within the last 2 days
const near = nearEarnings(
  {
    e: {
      TODAY: ["2026-10-11", "amc"], IN2: ["2026-10-13", ""], IN3: ["2026-10-14", "bmo"],
      PAST: ["2026-10-10", ""], // a stale "next" from an old file is not trusted
    },
    recent: { AGO1: "2026-10-10", AGO2: "2026-10-09", AGO3: "2026-10-08" },
  },
  today,
);
assert.deepEqual([...near].sort(), ["AGO1", "AGO2", "IN2", "TODAY"]);
assert.equal(nearEarnings({}, today).size, 0); // an older file without `recent` still works
assert.equal(nearEarnings(null, today).size, 0);

// the committed file, when present, has the shape the app reads
if (existsSync("public/earnings.json")) {
  const f = JSON.parse(readFileSync("public/earnings.json", "utf8"));
  assert.match(f.asOf, /^\d{4}-\d{2}-\d{2}$/);
  const rows = Object.entries(f.e);
  assert.ok(rows.length >= 500, `only ${rows.length} companies in public/earnings.json`);
  for (const [t, [d, h]] of rows) {
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/, t);
    assert.ok(h === "" || h === "bmo" || h === "amc", `${t}: hour ${h}`);
  }
}

console.log("test-earnings: all passed");
