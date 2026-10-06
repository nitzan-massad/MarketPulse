// Checks for src/peHistory.ts — run by `npm test`.
import { adjustSplits, closeAt, hasPeHistory, lastYears, niceTicks, parseEps, peSeries, peStats, quarterTtm, ttmSum } from "./peHistory";

let n = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${msg}\n  expected ${e}\n  actual   ${a}`);
}
const near = (a: number | null | undefined, b: number, msg: string) => eq(a != null && Math.abs(a - b) < 1e-6, true, `${msg} (got ${a})`);

// Finnhub sends newest-first, with the odd junk row
const eps = parseEps([
  { period: "2025-12-31", v: 2 },
  { period: "2025-09-30", v: 1 },
  { period: "2025-06-30", v: 1 },
  { period: "bad", v: 9 },
  { period: "2025-03-31", v: 1 },
  { period: "2024-12-31", v: -3 },
]);
eq(eps.map((p) => p.d), ["2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"], "parsed oldest-first, junk dropped");
eq(parseEps(undefined), [], "no series is an empty list, not a throw");
eq(parseEps([{ period: "2025-12-28", v: 1 }, { period: "2025-12-31", v: 1.1 }, { period: "2025-09-28", v: 1 }]).map((p) => p.d),
  ["2025-09-28", "2025-12-31"], "one quarter listed under two end dates is one quarter (the later)");

eq(ttmSum(eps, 4), 5, "TTM sums four consecutive quarters");
eq(ttmSum(eps, 3), 0, "a loss quarter in the window counts");
eq(ttmSum(eps, 2), null, "fewer than four quarters is no TTM");
const hole = parseEps([{ period: "2024-06-30", v: 3 }, { period: "2025-03-31", v: 1 }, { period: "2025-06-30", v: 1 }, { period: "2025-09-30", v: 1 }]);
eq(ttmSum(hole, 3), null, "a 9-month hole (or a half-year figure) is not summed as a quarter");

// weekly stamps, one close per week
const wk: string[] = [];
const px: number[] = [];
for (let t = Date.parse("2025-01-06"); t <= Date.parse("2026-06-29"); t += 7 * 864e5) {
  wk.push(new Date(t).toISOString().slice(0, 10));
  px.push(50);
}
const pe = peSeries(wk, px, eps);
const at = (d: string) => pe.find((p) => p.d >= d)!.v;
eq(at("2026-01-26"), null, "a quarter does not count before it is reported: Q3's TTM of 0 still applies");
near(at("2026-02-02"), 10, "the week whose Friday is 35+ days after the Dec quarter uses its TTM of 5: 50 / 5");
eq(at("2025-06-02"), null, "before four quarters exist, no P/E");
eq(pe.find((p) => p.d >= "2026-01-26")!.loss, true, "a TTM of 0 is marked as a loss, not just a gap");
eq(pe.find((p) => p.d >= "2025-06-02")!.loss, undefined, "no data is not a loss");
// a real report date for the newest quarter beats the 35-day guess (Dec quarter reported Jan 14)
const rep = { "2025-12-31": "2026-01-14" };
near(peSeries(wk, px, eps, [], rep).find((p) => p.d >= "2026-01-12")!.v, 10, "the week it is reported, the new quarter applies");
eq(peSeries(wk, px, eps, [], rep).find((p) => p.d >= "2026-01-05")!.v, null, "…and not the week before");
near(peSeries(wk, px, eps, [], { "2025-12-28": "2026-01-14" }).find((p) => p.d >= "2026-01-12")!.v, 10, "a fiscal quarter end a few days off still matches");
eq(peSeries(wk, px, eps, [], { "2025-12-31": "2024-01-01" }).find((p) => p.d >= "2026-01-26")!.v, null, "a report date before the quarter ended is ignored");
const rich = peSeries(wk, px.map(() => 5000), eps).find((p) => p.d >= "2026-02-09")!;
eq([rich.v, rich.high], [null, true], "1000x is drawn as 'over 200x', not a value");
eq(hasPeHistory(wk.map((d) => ({ d, v: null, high: true as const }))), true, "a stock always over 200x still has a history");
// a spin-off: price halves with no new quarter -> blank until the next report
const spin = px.map((v, i) => (wk[i] >= "2026-03-02" ? 10 : v));
const sp = peSeries(wk, spin, eps);
eq(sp.find((p) => p.d >= "2026-03-02")!.v, null, "a price break with no new quarter is not charted");
near(sp.find((p) => p.d >= "2026-02-23")!.v, 10, "…the weeks before it are");

// foreign filer: EPS in another currency (5x), Finnhub's quarterly peTTM is right
const peq = parseEps([{ period: "2025-12-31", v: 20 }, { period: "2025-09-30", v: 25 }]);
const fx = quarterTtm(eps.map((p) => ({ d: p.d, v: p.v * 5 })), peq, wk, px);
near(fx.find((q) => q.d === "2025-12-31")!.v, 2.5, "foreign: TTM implied from close / peTTM (50 / 20)");
const us = quarterTtm(eps, parseEps([{ period: "2025-12-31", v: 10.2 }]), wk, px);
eq(us.find((q) => q.d === "2025-12-31")!.v, 5, "US filer within tolerance keeps its exact summed EPS");
const bank = quarterTtm([], parseEps([{ period: "2025-12-31", v: 12.5 }]), wk, px);
near(bank[0].v, 4, "no EPS series (banks): TTM from peTTM alone");

// an unadjusted 15:1 split in the EPS series (ORLY): pre-split TTM 40.2 vs Finnhub's adjusted 2.68
const orly = [{ d: "2023-12-31", v: 9.1 }, { d: "2024-03-31", v: 9.2 }, { d: "2024-06-30", v: 10.5 }, { d: "2024-09-30", v: 11.4 }, { d: "2024-12-31", v: 0.63 }];
const adjTtm = new Map([["2024-09-30", 2.68]]);
near(adjustSplits(orly, adjTtm)[3].v, 0.76, "pre-split quarters are divided by the split factor (15, not 18)");
eq(adjustSplits(orly, adjTtm)[4].v, 0.63, "post-split quarters are untouched");
eq(adjustSplits(orly, new Map([["2024-09-30", 38]]))[3].v, 11.4, "a real earnings collapse (no split factor between the TTMs) is not a split");
eq(adjustSplits(orly, new Map())[3].v, 11.4, "no Finnhub P/E to compare against: left alone");

// weekly bars are stamped Monday, closed Friday
eq(closeAt(["2025-03-24", "2025-03-31"], [10, 7], "2025-03-31"), 10, "a Monday quarter end takes the PREVIOUS week's Friday close, not that week's");
eq(closeAt(["2025-03-24", "2025-03-31"], [10, 7], "2025-04-04"), 7, "on the Friday, that week's close counts");
eq(closeAt(["2025-01-06"], [10], "2025-03-31"), null, "no bar near the date, no close");

eq(lastYears([{ d: "2020-01-01", v: 1 }, { d: "2025-06-01", v: 2 }, { d: "2026-01-01", v: 3 }], 1).length, 2, "1Y keeps the last year");
eq(peStats([{ d: "a", v: 3 }, { d: "b", v: null }, { d: "c", v: 1 }, { d: "d", v: 2 }, { d: "e", v: 10 }]), { lo: 1, hi: 10, med: 2.5 }, "stats skip gaps");
eq(peStats([{ d: "a", v: null }]), null, "no data, no stats");
const filled = wk.map((d) => ({ d, v: 10 }));
eq(hasPeHistory(filled), true, "a year of real weeks is a history");
eq(hasPeHistory(filled.slice(0, 20)), false, "under half a year of real weeks is not");

const t1 = niceTicks(25, 243);
eq(t1.length >= 4 && t1.length <= 7, true, `25-243 gets a handful of ticks, not 24 (${t1})`);
eq(t1[0] <= 25 && t1[t1.length - 1] >= 243, true, "ticks cover the range");
eq(niceTicks(30, 30).length > 1, true, "a flat series still gets an axis");

console.log(`peHistory.check OK — ${n} assertions`);
