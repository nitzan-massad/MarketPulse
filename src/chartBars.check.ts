// Dependency-free self-check for chartBars.ts — reading the Worker's /bars body, today's live
// point on daily/weekly/monthly charts, and the 1D baseline. No test framework by design.
//
// Why each block exists:
//   • readBars — a malformed body must read as "chart unavailable", never as a half chart.
//   • withLive — CNBC's daily bars stop at yesterday: without today's price a 1M/1Y % ignores
//     today's move (a regression vs Twelve Data). But pre-market / nights / weekends must NOT
//     grow a phantom bar, and the cached series must never be mutated.
//   • sessionBase — the dashed "prev close" line must be the close BEFORE the plotted session,
//     including the first minutes after 9:30 when CNBC's quote hasn't rolled yet.
//
// Run (from repo root):
//   npx tsc src/chartBars.ts src/chartBars.check.ts --outDir /tmp/cb \
//     --module commonjs --target es2020 --lib es2020,dom --strict --skipLibCheck \
//   && node /tmp/cb/chartBars.check.js
import { readBars, sessionBase, withLive, type Bars } from "./chartBars";

let failed = 0;
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.error(`FAIL ${label}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ---- readBars ----------------------------------------------------------------------------------
eq("readBars: the Worker's shape", readBars({ s: "AAPL", r: "1M", t: ["2026-10-20", "2026-10-21"], c: [1, 2], v: [5, 6] }), {
  stamps: ["2026-10-20", "2026-10-21"],
  closes: [1, 2],
});
eq("readBars: bad rows skipped, arrays stay parallel", readBars({ t: ["a", 5, "c", "d"], c: [1, 2, 0, -1] }), { stamps: ["a"], closes: [1] });
eq(
  "readBars: malformed bodies -> null",
  [null, {}, { t: [], c: [] }, { t: ["a"], c: [] }, { t: "x", c: [1] }, { error: "upstream" }, { t: ["a"], c: [0] }].map(readBars),
  [null, null, null, null, null, null, null],
);

// ---- withLive ----------------------------------------------------------------------------------
const day: Bars = { stamps: ["2026-10-19", "2026-10-20", "2026-10-21"], closes: [10, 11, 12] };
const live = { day: "2026-10-22", px: 13 };
eq("day: today after the last bar -> appended", withLive(day, live, "day"), { stamps: [...day.stamps, "2026-10-22"], closes: [10, 11, 12, 13] });
eq("day: the quote still on the last bar's day (pre-market, weekend) -> unchanged", withLive(day, { day: "2026-10-21", px: 99 }, "day"), day);
eq("day: an older quote -> unchanged", withLive(day, { day: "2026-10-01", px: 99 }, "day"), day);
eq("day: no live price -> the same object", withLive(day, null, "day") === day, true);
eq("day: px <= 0 -> unchanged", withLive(day, { day: "2026-10-22", px: 0 }, "day"), day);
withLive(day, live, "day");
eq("day: the input series is never mutated (it is cached)", day, { stamps: ["2026-10-19", "2026-10-20", "2026-10-21"], closes: [10, 11, 12] });
eq("day: Twelve Data fallback already has today -> unchanged", withLive({ stamps: ["2026-10-21", "2026-10-22"], closes: [1, 2] }, live, "day").closes, [1, 2]);

const week: Bars = { stamps: ["2026-10-12", "2026-10-19"], closes: [20, 21] };
eq("week: same week -> the last close replaced", withLive(week, live, "week"), { stamps: week.stamps, closes: [20, 13] });
eq("week: a Monday of a new week -> its Monday appended", withLive(week, { day: "2026-10-26", px: 30 }, "week"), {
  stamps: ["2026-10-12", "2026-10-19", "2026-10-26"],
  closes: [20, 21, 30],
});
eq("week: Sunday rolls back to its own week's Monday", withLive(week, { day: "2026-10-25", px: 30 }, "week").stamps.length, 2);
eq("week: a live day older than the series -> unchanged", withLive(week, { day: "2026-10-09", px: 1 }, "week"), week);

const month: Bars = { stamps: ["2026-09-01", "2026-10-01"], closes: [40, 41] };
eq("month: same month -> replaced", withLive(month, live, "month"), { stamps: month.stamps, closes: [40, 13] });
eq("month: a new month -> its 1st appended", withLive(month, { day: "2026-11-02", px: 50 }, "month").stamps, ["2026-09-01", "2026-10-01", "2026-11-01"]);
eq("month: year rollover", withLive({ stamps: ["2026-12-01"], closes: [1] }, { day: "2027-01-04", px: 2 }, "month").stamps, ["2026-12-01", "2027-01-01"]);

eq("intraday -> unchanged (1D/1W draw the live session from bars)", withLive({ stamps: ["2026-10-22 09:30"], closes: [1] }, live, "intraday").closes, [1]);
eq("empty series -> unchanged", withLive({ stamps: [], closes: [] }, live, "day").stamps, []);

// ---- sessionBase -------------------------------------------------------------------------------
eq("base: the quote is FOR the plotted session -> its prior close", sessionBase("2026-10-22", 50, { day: "2026-10-22", px: 52, pc: 49 }), 49);
eq(
  "base: 9:30-9:35, the quote still on yesterday -> its price IS yesterday's close",
  sessionBase("2026-10-22", 50, { day: "2026-10-21", px: 48.5, pc: 47 }),
  48.5,
);
eq("base: pre-market, plotting yesterday, quote on yesterday -> pc", sessionBase("2026-10-21", 50, { day: "2026-10-21", px: 48.5, pc: 47 }), 47);
eq("base: Finnhub-priced quote (no day) -> its pc, as before", sessionBase("2026-10-22", 50, { day: null, px: 52, pc: 49 }), 49);
eq("base: no day and no pc -> the session's first close", sessionBase("2026-10-22", 50, { day: null, px: 52, pc: null }), 50);
eq("base: no quote at all -> the first close", sessionBase("2026-10-22", 50, null), 50);
eq("base: quote day AFTER the plotted session (bars lag) -> first close", sessionBase("2026-10-21", 50, { day: "2026-10-22", px: 52, pc: 49 }), 50);

if (failed) throw new Error(`${failed} chartBars check(s) failed`);
console.log("\nall chartBars checks passed");
