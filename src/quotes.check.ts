// Dependency-free self-check for quotes.ts — the rules that decide when CNBC is trusted, when
// Finnhub takes over, and how the two merge one-source-per-symbol. No test framework by design
// (mirrors alertEngine.check.ts).
//
// Why each block exists:
//   • session clock — the poll cadence and the staleness probe both key off it; an off-by-one
//     at 9:30/16:00 or a DST slip polls a closed market at 20s or a live one at 60s.
//   • batchStale — CNBC serving a frozen cache must count as a failure, but only after the
//     open has had STALE_GRACE_MIN to print a trade.
//   • nextSource — exactly 2 failed polls switch to Finnhub, exactly 1 good one switches back.
//   • mergeQuotes — a symbol priced by CNBC on one poll and Finnhub the next flip-flops across
//     the ±5% alert band and fires false alerts; never mix sources for one symbol.
//   • mergeModal — CNBC first, Finnhub per missing field; P/E <= 0 is "no earnings"; sector and
//     3-month volume are always Finnhub's (CNBC has neither).
//
// Run (from repo root):
//   npx tsc src/quotes.ts src/quotes.check.ts --outDir /tmp/qc \
//     --module commonjs --target es2020 --lib es2020,dom --strict --skipLibCheck \
//   && node /tmp/qc/quotes.check.js
import {
  batchStale,
  CLOSED_POLL_MS,
  CNBC_MAX,
  cnbcFor,
  cnbcRequest,
  extNow,
  cnbcSearchHits,
  cnbcSearchMatched,
  earlyPollOk,
  etClock,
  FAILS_TO_SWITCH,
  finnhubSymbols,
  INITIAL_SOURCE,
  mergeModal,
  mergeQuotes,
  needsFhQuote,
  quoteStale,
  nextPollMs,
  nextSource,
  normSym,
  pollMs,
  PROBE_MS,
  readQuotes,
  sameQuotes,
  sessionOf,
  STALE_GRACE_MIN,
  type CnbcMap,
  type CnbcQuote,
  type EtClock,
  type FhMetric,
  type FhProfile,
  type FhQuote,
  type SourceState,
} from "./quotes";

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

// ---- normSym (client canon — must match worker/cnbc.js; cross-checked in ci/test-cnbc-worker.mjs)
eq("normSym BRK-B", normSym("BRK-B"), "BRK.B");
eq("normSym brk_b", normSym("brk_b"), "BRK.B");
eq("normSym BRK/B", normSym("BRK/B"), "BRK.B");
eq("normSym BRK", normSym("BRK"), "BRK");
eq("normSym padded lower", normSym("  msft "), "MSFT");
eq("normSym junk", ["", "1ABC", "ABCDEFG", "^GSPC", "BRK.BCD", "A B"].map(normSym), [null, null, null, null, null, null]);

// ---- etClock: real instants -> New York wall clock ---------------------------------------
const at = (iso: string): EtClock => etClock(new Date(iso));
eq("etClock EDT 9:30 = 13:30Z", at("2026-10-22T13:30:00Z"), { ymd: "2026-10-22", mins: 570, weekend: false });
eq("etClock EST 9:30 = 14:30Z", at("2026-11-02T14:30:00Z"), { ymd: "2026-11-02", mins: 570, weekend: false });
eq("etClock midnight reads 0, not 24:00", at("2026-10-22T04:00:00Z").mins, 0);
eq("etClock ymd is New York's date, not UTC's", at("2026-10-23T01:00:00Z").ymd, "2026-10-22");
eq("etClock Saturday", at("2026-10-24T15:00:00Z").weekend, true);
eq("etClock Friday 21:00 ET (Saturday in UTC) is not weekend", at("2026-10-24T01:00:00Z").weekend, false);
eq("etClock Sunday 23:00 ET (Monday in UTC) is weekend", at("2026-10-26T03:00:00Z").weekend, true);

// ---- sessionOf: every boundary, on a real EDT weekday ---------------------------------------
const sess = (iso: string) => sessionOf(at(iso));
eq("03:59 ET closed", sess("2026-10-22T07:59:00Z"), "closed");
eq("04:00 ET pre", sess("2026-10-22T08:00:00Z"), "pre");
eq("09:29 ET pre", sess("2026-10-22T13:29:00Z"), "pre");
eq("09:30 ET regular", sess("2026-10-22T13:30:00Z"), "regular");
eq("15:59 ET regular", sess("2026-10-22T19:59:00Z"), "regular");
eq("16:00 ET post", sess("2026-10-22T20:00:00Z"), "post");
eq("19:59 ET post", sess("2026-10-22T23:59:00Z"), "post");
eq("20:00 ET closed", sess("2026-10-23T00:00:00Z"), "closed");
eq("00:00 ET closed", sess("2026-10-22T04:00:00Z"), "closed");
eq("09:29:59 ET still pre (minute resolution)", sess("2026-10-22T13:29:59Z"), "pre");
// weekends: closed all day, including what would be the session
eq("Saturday 11:00 ET closed", sess("2026-10-24T15:00:00Z"), "closed");
eq("Sunday 05:00 ET closed (no pre-market)", sess("2026-10-25T09:00:00Z"), "closed");
eq("Monday 04:00 ET pre", sess("2026-10-26T08:00:00Z"), "pre");
// DST: 2026-03-08 spring forward, 2026-11-01 fall back
eq("EST Fri 2026-03-06 14:29Z = 09:29 pre", sess("2026-03-06T14:29:00Z"), "pre");
eq("EST Fri 2026-03-06 14:30Z = 09:30 regular", sess("2026-03-06T14:30:00Z"), "regular");
eq("EDT Mon 2026-03-09 13:29Z = 09:29 pre", sess("2026-03-09T13:29:00Z"), "pre");
eq("EDT Mon 2026-03-09 13:30Z = 09:30 regular", sess("2026-03-09T13:30:00Z"), "regular");
eq("EDT Mon 2026-03-09 20:00Z = 16:00 post", sess("2026-03-09T20:00:00Z"), "post");
eq("EST Mon 2026-11-02 13:30Z = 08:30 pre (was 09:30 a week earlier)", sess("2026-11-02T13:30:00Z"), "pre");
eq("EST Mon 2026-11-02 20:59Z = 15:59 regular", sess("2026-11-02T20:59:00Z"), "regular");
eq("EST Mon 2026-11-02 21:00Z = 16:00 post", sess("2026-11-02T21:00:00Z"), "post");
eq("EST Mon 2026-11-03 00:59Z = 19:59 post", sess("2026-11-03T00:59:00Z"), "post");
eq("EST Mon 2026-11-03 01:00Z = 20:00 closed", sess("2026-11-03T01:00:00Z"), "closed");
// synthetic clocks, exact minute edges
const clk = (mins: number, weekend = false, ymd = "2026-10-22"): EtClock => ({ ymd, mins, weekend });
eq(
  "sessionOf minute edges 239/240/569/570/959/960/1199/1200",
  [239, 240, 569, 570, 959, 960, 1199, 1200].map((m) => sessionOf(clk(m))),
  ["closed", "pre", "pre", "regular", "regular", "post", "post", "closed"],
);
eq("sessionOf weekend at 10:00 closed", sessionOf(clk(600, true)), "closed");

// ---- pollMs -----------------------------------------------------------------------------------
eq("pollMs regular 20s", pollMs("regular"), 20_000);
eq("pollMs pre 60s", pollMs("pre"), 60_000);
eq("pollMs post 60s", pollMs("post"), 60_000);
eq("pollMs closed -> null (hook falls back to its slow closed cadence)", pollMs("closed"), null);

// ---- fixtures ---------------------------------------------------------------------------------
const Q = (o: Partial<CnbcQuote> = {}): CnbcQuote => ({
  px: 100, chg: 1, pct: 1.01, pc: 99, day: "2026-10-22", o: 99.5, h: 101, l: 99, ext: null,
  name: "Co", mc: 1000, hi52: 120, lo52: 80, pe: 20, fpe: 18, eps: 5, beta: 1.1, vol10: 2e6, ...o,
});

// ---- batchStale -----------------------------------------------------------------------------------
const OPEN = 570;
eq("STALE_GRACE_MIN is 15", STALE_GRACE_MIN, 15);
const old = { AAPL: Q({ day: "2026-10-21" }), LLY: Q({ day: "2026-10-21" }) };
eq("stale: inside the grace (09:44) never stale", batchStale(old, clk(OPEN + 14)), false);
eq("stale: at 09:45 a batch with no today-dated quote is stale", batchStale(old, clk(OPEN + 15)), true);
eq("stale: mid-session all-yesterday -> stale", batchStale(old, clk(720)), true);
eq("stale: one today-dated quote clears the batch", batchStale({ ...old, X: Q() }, clk(720)), false);
eq("stale: quiet ticker with day null alongside a fresh one -> fine", batchStale({ A: Q({ day: null }), B: Q() }, clk(720)), false);
eq("stale: all day null -> stale (nothing proves freshness)", batchStale({ A: Q({ day: null }) }, clk(720)), true);
eq("stale: all-null map is not stale (nothing to judge)", batchStale({ A: null, B: null }, clk(720)), false);
eq("stale: empty map is not stale", batchStale({}, clk(720)), false);
eq("stale: never in pre-market", batchStale(old, clk(500)), false);
eq("stale: never after hours", batchStale(old, clk(1000)), false);
eq("stale: never closed / overnight", batchStale(old, clk(100)), false);
eq("stale: never on a weekend", batchStale(old, clk(720, true)), false);
eq("stale: 15:59 still judged", batchStale(old, clk(959)), true);

// ---- nextSource -------------------------------------------------------------------------------
eq("FAILS_TO_SWITCH is 2", FAILS_TO_SWITCH, 2);
eq("PROBE_MS is 5 min", PROBE_MS, 300_000);
eq("initial source is CNBC", INITIAL_SOURCE, { source: "cnbc", fails: 0 });
const f1 = nextSource(INITIAL_SOURCE, false);
eq("1 fail stays on CNBC", f1, { source: "cnbc", fails: 1 });
const f2 = nextSource(f1, false);
eq("2 fails in a row -> Finnhub", f2, { source: "finnhub", fails: 2 });
eq("further fails stay on Finnhub", nextSource(f2, false), { source: "finnhub", fails: 3 });
eq("1 ok on Finnhub -> back to CNBC, counter reset", nextSource(f2, true), { source: "cnbc", fails: 0 });
eq("fail, ok, fail never switches", nextSource(nextSource(f1, true), false), { source: "cnbc", fails: 1 });
let alt: SourceState = INITIAL_SOURCE;
for (let i = 0; i < 10; i++) alt = nextSource(alt, i % 2 === 1);
eq("alternating fail/ok for 10 polls stays on CNBC", alt.source, "cnbc");
eq("ok on CNBC is idempotent", nextSource(INITIAL_SOURCE, true), INITIAL_SOURCE);
eq("nextSource does not mutate its input", (nextSource(INITIAL_SOURCE, false), INITIAL_SOURCE), { source: "cnbc", fails: 0 });

// ---- finnhubSymbols -----------------------------------------------------------------------------
const CN: SourceState = { source: "cnbc", fails: 0 };
const FH: SourceState = { source: "finnhub", fails: 2 };
const map: CnbcMap = { AAPL: Q(), QNCX: null, "BRK.B": null, LLY: Q({ px: 1270.75 }) };
eq(
  "finnhubSymbols on CNBC: only what CNBC answered null (+ un-normalizable)",
  finnhubSymbols(["AAPL", "QNCX", "BRK-B", "LLY", "NEWT", "^VIX"], map, CN),
  ["QNCX", "BRK-B", "^VIX"],
);
eq("finnhubSymbols on CNBC: never-asked symbols wait for CNBC's answer", finnhubSymbols(["NEW"], map, CN), []);
eq("finnhubSymbols on Finnhub: everything wanted", finnhubSymbols(["AAPL", "QNCX", "NEW"], map, FH), ["AAPL", "QNCX", "NEW"]);
eq("finnhubSymbols keeps the caller's ticker spelling", finnhubSymbols(["brk-b"], map, CN), ["brk-b"]);
eq("finnhubSymbols empty wanted", finnhubSymbols([], map, FH), []);

// ---- cnbcFor ---------------------------------------------------------------------------------------
eq("cnbcFor normalizes the app ticker", cnbcFor({ "BRK.B": Q({ px: 500 }) }, "BRK-B")?.px, 500);
eq("cnbcFor lower-case ticker", cnbcFor(map, "aapl")?.px, 100);
eq("cnbcFor null answer -> null", cnbcFor(map, "QNCX"), null);
eq("cnbcFor absent -> null", cnbcFor(map, "ZZZ"), null);
eq("cnbcFor junk -> null", cnbcFor(map, "^VIX"), null);

// ---- mergeQuotes: one source per symbol ----------------------------------------------------------
const fhP = { AAPL: 101, QNCX: 2.5, LLY: 1, GETY: 0.02, ONLYFH: 7 };
const fhD = { AAPL: 2.0, QNCX: -3.1, LLY: -99, GETY: 5 };
const m1 = mergeQuotes(["AAPL", "QNCX", "LLY", "GETY", "NONE"], { ...map, GETY: null }, CN, fhP, fhD);
eq("merge CNBC: AAPL price+pct from CNBC, not Finnhub", [m1.price.AAPL, m1.pct.AAPL], [100, 1.01]);
eq("merge CNBC: LLY 1270.75 (comma price), never Finnhub's", [m1.price.LLY, m1.pct.LLY], [1270.75, 1.01]);
eq("merge CNBC: QNCX missing at CNBC -> Finnhub price+pct", [m1.price.QNCX, m1.pct.QNCX], [2.5, -3.1]);
eq("merge CNBC: GETY null at CNBC -> Finnhub", [m1.price.GETY, m1.pct.GETY], [0.02, 5]);
eq("merge: ticker neither source has -> absent (row keeps snapshot)", ["NONE" in m1.price, "NONE" in m1.pct], [false, false]);
const m2 = mergeQuotes(["AAPL"], { AAPL: Q({ pct: null }) }, CN, fhP, fhD);
eq("merge CNBC: CNBC price with no pct does NOT borrow Finnhub's pct", [m2.price.AAPL, "AAPL" in m2.pct], [100, false]);
const m3 = mergeQuotes(["AAPL", "QNCX", "NONE"], map, FH, fhP, fhD);
eq("merge Finnhub: ignores CNBC's quote entirely", [m3.price.AAPL, m3.pct.AAPL], [101, 2.0]);
eq("merge Finnhub: no Finnhub price -> absent, not CNBC's", "NONE" in m3.price, false);
const m4 = mergeQuotes(["AAPL"], map, FH, {}, {});
// Finnhub not seeded yet (or off-hours, where it never runs): CNBC's last-known quote stands
// in, never the hours-old snapshot whose jump could fire a false ±5% alert.
eq("merge Finnhub, Finnhub empty -> CNBC's last-known quote", m4, { price: { AAPL: 100 }, pct: { AAPL: 1.01 } });
eq("merge Finnhub, Finnhub priced -> Finnhub's (price and % from ONE source)",
  mergeQuotes(["AAPL"], map, FH, { AAPL: 101 }, {}), { price: { AAPL: 101 }, pct: {} });
const m5 = mergeQuotes(["BRK-B"], { "BRK.B": Q({ px: 480, pct: 0.5 }) }, CN, {}, {});
eq("merge keys by the app ticker (BRK-B), looked up as BRK.B", m5, { price: { "BRK-B": 480 }, pct: { "BRK-B": 0.5 } });
const m6 = mergeQuotes(["ONLYFH"], {}, CN, fhP, {});
eq("merge: Finnhub price without pct -> price only", m6, { price: { ONLYFH: 7 }, pct: {} });
const m7 = mergeQuotes(new Set(["AAPL", "AAPL"]), map, CN, {}, {});
eq("merge accepts any iterable", Object.keys(m7.price), ["AAPL"]);
eq("merge: UNCH day (pct 0) is kept as 0, not dropped", mergeQuotes(["X"], { X: Q({ pct: 0 }) }, CN, {}, { X: 3 }).pct, { X: 0 });
// the switch: same inputs, one poll apart
const before = mergeQuotes(["AAPL"], map, nextSource(INITIAL_SOURCE, false), fhP, fhD).price.AAPL;
const after = mergeQuotes(["AAPL"], map, nextSource(nextSource(INITIAL_SOURCE, false), false), fhP, fhD).price.AAPL;
eq("merge: after 1 fail still CNBC, after 2 fails Finnhub", [before, after], [100, 101]);

// ---- needsFhQuote -------------------------------------------------------------------------------
eq("needsFhQuote: no CNBC quote", needsFhQuote(null), true);
eq("needsFhQuote: in-session full OHL", needsFhQuote(Q()), false);
eq("needsFhQuote: off-hours (CNBC zeroes OHL)", needsFhQuote(Q({ o: null, h: null, l: null })), true);
eq("needsFhQuote: any one of O/H/L missing", [needsFhQuote(Q({ o: null })), needsFhQuote(Q({ h: null })), needsFhQuote(Q({ l: null }))], [true, true, true]);

// ---- mergeModal --------------------------------------------------------------------------------
const FQ: FhQuote = { c: 101, dp: 2, o: 98, h: 103, l: 97, pc: 99.02 };
const FM: FhMetric = { hi52: 130, lo52: 70, pe: 25, fwdPe: 22, epsTtm: 4, beta: 1.3, avgVol3M: 3e6, avgVol10D: 2.5e6 };
const FP: FhProfile = { name: "Finnhub Co", sector: "Technology", mktCap: 2000 };

const mm1 = mergeModal(Q(), FQ, FM, FP);
eq("modal in-session: quote all CNBC", mm1.quote, { c: 100, dp: 1.01, pc: 99, o: 99.5, h: 101, l: 99, v: null });
eq("modal: metric CNBC-first, avgVol3M Finnhub", mm1.metric, {
  hi52: 120, lo52: 80, pe: 20, fwdPe: 18, epsTtm: 5, beta: 1.1, avgVol3M: 3e6, avgVol10D: 2e6,
});
eq("modal: profile name/mktCap CNBC, sector Finnhub", mm1.profile, { name: "Co", sector: "Technology", mktCap: 1000 });

const off = Q({ o: null, h: null, l: null });
const mm2 = mergeModal(off, FQ, FM, FP);
eq("modal off-hours: headline (c/dp/pc) CNBC, O/H/L Finnhub", mm2.quote, { c: 100, dp: 1.01, pc: 99, o: 98, h: 103, l: 97, v: null });
eq(
  "modal: CNBC prior close missing stays null — never Finnhub's pc under CNBC's price",
  mergeModal(Q({ pc: null }), FQ, FM, FP).quote.pc,
  null,
);
eq("modal: CNBC pct missing stays null under CNBC's price", mergeModal(Q({ pct: null }), FQ, FM, FP).quote.dp, null);
eq("modal no CNBC: everything Finnhub", mergeModal(null, FQ, FM, FP).quote, { c: 101, dp: 2, pc: 99.02, o: 98, h: 103, l: 97, v: null });
eq("modal no CNBC: metric = Finnhub's", mergeModal(null, FQ, FM, FP).metric, FM);
eq("modal no CNBC: profile = Finnhub's", mergeModal(null, FQ, FM, FP).profile, FP);
eq("modal no CNBC, no Finnhub quote: nulls", mergeModal(null, null, FM, FP).quote, { c: null, dp: null, pc: null, o: null, h: null, l: null, v: null });
eq("modal nothing at all: all nulls", mergeModal(null, null, null, null), {
  quote: { c: null, dp: null, pc: null, o: null, h: null, l: null, v: null },
  metric: { hi52: null, lo52: null, pe: null, fwdPe: null, epsTtm: null, beta: null, avgVol3M: null, avgVol10D: null },
  profile: { name: null, sector: null, mktCap: null },
});
eq("modal CNBC only (no Finnhub key): sector + avgVol3M null", (() => {
  const r = mergeModal(Q(), null, null, null);
  return [r.profile.sector, r.metric.avgVol3M, r.metric.pe, r.quote.c];
})(), [null, null, 20, 100]);
// P/E / forward P/E: <= 0 means "no earnings" -> Finnhub's
eq("modal pe negative (SQNS -0.26) -> Finnhub", mergeModal(Q({ pe: -0.26 }), FQ, FM, FP).metric.pe, 25);
eq("modal pe 0 -> Finnhub", mergeModal(Q({ pe: 0 }), FQ, FM, FP).metric.pe, 25);
eq("modal pe null -> Finnhub", mergeModal(Q({ pe: null }), FQ, FM, FP).metric.pe, 25);
eq("modal pe negative, no Finnhub -> null (not the negative)", mergeModal(Q({ pe: -2 }), null, null, null).metric.pe, null);
eq("modal pe tiny positive kept (P/E<1 guard is the modal's job)", mergeModal(Q({ pe: 0.5 }), FQ, FM, FP).metric.pe, 0.5);
eq("modal fpe negative -> Finnhub", mergeModal(Q({ fpe: -1.57 }), FQ, FM, FP).metric.fwdPe, 22);
eq("modal fpe 0 -> Finnhub", mergeModal(Q({ fpe: 0 }), FQ, FM, FP).metric.fwdPe, 22);
eq("modal fpe positive kept", mergeModal(Q({ fpe: 37.12 }), FQ, FM, FP).metric.fwdPe, 37.12);
eq("modal eps negative is real data, kept", mergeModal(Q({ eps: -9.65 }), FQ, FM, FP).metric.epsTtm, -9.65);
eq("modal per-field fallback: CNBC lacks hi52/beta/vol10/name/mc", (() => {
  const r = mergeModal(Q({ hi52: null, beta: null, vol10: null, name: null, mc: null }), FQ, FM, FP);
  return [r.metric.hi52, r.metric.lo52, r.metric.beta, r.metric.avgVol10D, r.profile.name, r.profile.mktCap];
})(), [130, 80, 1.3, 2.5e6, "Finnhub Co", 2000]);
eq("modal: sector is Finnhub's even when CNBC has a name", mergeModal(Q({ name: "CNBC Name" }), null, null, FP).profile, {
  name: "CNBC Name", sector: "Technology", mktCap: 1000,
});
eq("modal: beta 0 from CNBC is a value, not a gap", mergeModal(Q({ beta: 0 }), FQ, FM, FP).metric.beta, 0);

// ---- cnbcSearchHits ---------------------------------------------------------------------------------
const body = [
  { resultCount: 7 }, // metadata header
  { symbolName: "AAPL", companyName: "Apple Inc", countryCode: "US", issueType: "STOCK" },
  { symbolName: "APLE", companyName: "Apple Hospitality", countryCode: "US", issueType: "STOCK" },
  { symbolName: "AAPL", companyName: "dupe", countryCode: "US", issueType: "STOCK" },
  { symbolName: "APC-DE", companyName: "Apple (Xetra)", countryCode: "DE", issueType: "STOCK" },
  { symbolName: "BRK.B", companyName: "Berkshire B", countryCode: "US", issueType: "STOCK" },
  { symbolName: "AAPLX", companyName: "Apple fund", countryCode: "US", issueType: "FUND" },
  { symbolName: "QQQ", companyName: "Invesco QQQ", countryCode: "US", issueType: "ETF" },
  { symbolName: "MSFT", companyName: "Microsoft", countryCode: "US", issueType: "STOCK" },
  { symbolName: "NONAME", countryCode: "US", issueType: "STOCK" },
];
eq("search: US stocks/ETFs only, dotted + dupes + in-set dropped", cnbcSearchHits(body, new Set(["MSFT"])), [
  { t: "AAPL", n: "Apple Inc" },
  { t: "APLE", n: "Apple Hospitality" },
  { t: "QQQ", n: "Invesco QQQ" },
  { t: "NONAME", n: "" },
]);
eq("search: max caps the list", cnbcSearchHits(body, new Set(), 2).map((h) => h.t), ["AAPL", "APLE"]);
eq("search: default max is 5", cnbcSearchHits(body, new Set()).length, 5);
eq("search: everything already ranked -> [] (Search falls back to Finnhub)", cnbcSearchHits(body.slice(0, 3), new Set(["AAPL", "APLE"])), []);
eq("search: non-array body -> []", [cnbcSearchHits(null, new Set()), cnbcSearchHits({ results: [] }, new Set()), cnbcSearchHits("x", new Set())], [[], [], []]);
eq("search: null rows inside the array are skipped", cnbcSearchHits([null, 5, body[1]], new Set()), [{ t: "AAPL", n: "Apple Inc" }]);


// ---- poll loop decisions (the hook delegates every one of these) -------------------------------
// nextPollMs: while Finnhub carries, CNBC is only re-probed every PROBE_MS — never at the 20s
// cadence (that would hammer a CNBC that is down) and never the 30-min closed cadence.
const onFh: SourceState = { source: "finnhub", fails: 2 };
eq("nextPollMs: finnhub -> PROBE_MS in every session",
  (["regular", "pre", "post", "closed"] as const).map((x) => nextPollMs(onFh, x)), [PROBE_MS, PROBE_MS, PROBE_MS, PROBE_MS]);
eq("nextPollMs: cnbc regular 20s / pre+post 60s / closed CLOSED_POLL_MS",
  (["regular", "pre", "post", "closed"] as const).map((x) => nextPollMs(INITIAL_SOURCE, x)), [20_000, 60_000, 60_000, CLOSED_POLL_MS]);
eq("nextPollMs: one failure (still cnbc) keeps the fast cadence", nextPollMs({ source: "cnbc", fails: 1 }, "regular"), 20_000);
eq("CLOSED_POLL_MS is 30 min", CLOSED_POLL_MS, 30 * 60_000);

// cnbcRequest: what one poll asks CNBC for.
eq("CNBC_MAX is 300 (the Worker's per-request cap)", CNBC_MAX, 300);
eq("cnbcRequest: normalizes, dedupes, keeps order (watchlist first), sentinel last", cnbcRequest(["aapl", "BRK-B", "AAPL", "brk_b", "MSFT"]), ["AAPL", "BRK.B", "MSFT", "SPY"]);
eq("cnbcRequest: junk dropped", cnbcRequest(["", "1ABC", "TOO.LONG.X", "OK"]), ["OK", "SPY"]);
eq("cnbcRequest: nothing wanted -> nothing asked (no sentinel-only poll)", cnbcRequest([]), []);
eq("cnbcRequest: a watched SPY is not asked twice", cnbcRequest(["SPY", "AAPL"]), ["SPY", "AAPL"]);
const many = Array.from({ length: 450 }, (_, i) => `T${i}`);
eq("cnbcRequest: capped at CNBC_MAX, sentinel inside the cap", [cnbcRequest(many).length, cnbcRequest(many)[299]], [300, "SPY"]);
eq("cnbcRequest: the cap keeps the FIRST symbols (watchlist wins)", cnbcRequest(many).slice(0, 2), ["T0", "T1"]);
eq("cnbcRequest: dupes don't eat the cap", cnbcRequest([...Array(400).fill("AAPL"), "MSFT"]), ["AAPL", "MSFT", "SPY"]);

// readQuotes: which responses count as a FAILED poll (null) vs data.
const fresh = { AAPL: Q({ day: "2026-10-22" }), QNCX: null };
eq("readQuotes: good body -> its quotes (null entries kept: they route to Finnhub)", readQuotes({ asOf: 1, quotes: fresh }, clk(720)), fresh);
eq("readQuotes: stale batch mid-session -> null (counts as a failure)", readQuotes({ quotes: old }, clk(720)), null);
eq("readQuotes: same stale batch inside the grace -> data", readQuotes({ quotes: old }, clk(OPEN + 5)), old);
eq("readQuotes: same stale batch off-hours -> data", readQuotes({ quotes: old }, clk(17 * 60)), old);
eq("readQuotes: error/garbled bodies -> null",
  [readQuotes(null, clk(720)), readQuotes({ error: "upstream" }, clk(720)), readQuotes({ quotes: null }, clk(720)),
   readQuotes({ quotes: [] }, clk(720)), readQuotes({ quotes: "x" }, clk(720)), readQuotes("x", clk(720))],
  [null, null, null, null, null, null]);


// ---- review round 1 -------------------------------------------------------------------------------
// nextSource keeps identity when nothing changes, so a healthy poll doesn't re-render the app.
eq("nextSource: healthy ok returns the SAME object", nextSource(INITIAL_SOURCE, true) === INITIAL_SOURCE, true);
const oneFail: SourceState = { source: "cnbc", fails: 1 };
eq("nextSource: ok after a fail returns a reset copy", [nextSource(oneFail, true) === oneFail, nextSource(oneFail, true)], [false, { source: "cnbc", fails: 0 }]);

// sameQuotes: skip the state update when a poll changed nothing.
const qa = { AAPL: Q(), QNCX: null };
eq("sameQuotes: identical -> true", sameQuotes(qa, { AAPL: Q(), QNCX: null }), true);
eq("sameQuotes: a moved price -> false", sameQuotes(qa, { AAPL: Q({ px: 101 }) }), false);
eq("sameQuotes: a symbol prev never had -> false", sameQuotes(qa, { MSFT: Q() }), false);
eq("sameQuotes: null -> quote -> false", sameQuotes(qa, { QNCX: Q() }), false);
eq("sameQuotes: subset of prev -> true (prev keeps the rest)", sameQuotes(qa, { AAPL: Q() }), true);

// extNow: yesterday's after-hours must not read as current next morning.
const ms = (iso: string) => Date.parse(iso);
const pre = { type: "pre" as const, px: 343.48, chg: -0.51, pct: -0.15, t: ms("2026-10-22T08:17:34.689-0400") };
const postY = { type: "post" as const, px: 1.5, chg: 0.06, pct: 4.2, t: ms("2026-10-21") };
const postT = { type: "post" as const, px: 346, chg: 0.3, pct: 0.09, t: ms("2026-10-22T17:05:00.000-0400") };
eq("extNow: today's pre-market during pre-market -> shown", extNow(pre, clk(8 * 60 + 20)), pre);
eq("extNow: today's pre-market in the regular session -> hidden", extNow(pre, clk(600)), null);
eq("extNow: today's pre-market after hours -> hidden", extNow(pre, clk(17 * 60)), null);
eq("extNow: yesterday's after-hours next pre-market -> hidden", extNow(postY, clk(8 * 60)), null);
eq("extNow: today's after-hours during after-hours -> shown", extNow(postT, clk(17 * 60 + 10)), postT);
eq("extNow: today's after-hours once closed -> hidden", extNow(postT, clk(21 * 60)), null);
eq("extNow: no timestamp / no ext -> hidden", [extNow({ ...pre, t: null }, clk(8 * 60 + 20)), extNow(null, clk(500))], [null, null]);

// ---- review round 2 -------------------------------------------------------------------------------
// CNBC tags US REITs CSRT and closed-end funds CF; dropping them lost "realty" -> O/KIM/DLR,
// which main's Finnhub search found.
const reit = [
  { TotalMatchAvailable: "4" },
  { symbolName: "O", companyName: "Realty Income Corp", countryCode: "US", issueType: "CSRT" },
  { symbolName: "TWN", companyName: "Taiwan Fund", countryCode: "US", issueType: "CF" },
  { symbolName: "BFOCX", companyName: "Berkshire Focus Fund", countryCode: "US", issueType: "FUND" },
  { symbolName: "O-DE", companyName: "Realty Income DE", countryCode: "DE", issueType: "CSRT" },
];
eq("search: REITs (CSRT) and closed-end funds (CF) kept; mutual funds + foreign dropped",
  cnbcSearchHits(reit, new Set()), [{ t: "O", n: "Realty Income Corp" }, { t: "TWN", n: "Taiwan Fund" }]);

// ---- review round 3 -------------------------------------------------------------------------------
// CNBC answering null for a symbol it priced before must not drop it to the snapshot.
const lastMap = { AAPL: Q({ px: 100, pct: 1.01 }) };
eq("merge CNBC: now null, no Finnhub -> last non-null CNBC quote stands in",
  mergeQuotes(["AAPL"], { AAPL: null }, CN, {}, {}, lastMap), { price: { AAPL: 100 }, pct: { AAPL: 1.01 } });
eq("merge CNBC: now null, Finnhub priced -> Finnhub (not the stale last)",
  mergeQuotes(["AAPL"], { AAPL: null }, CN, { AAPL: 102 }, { AAPL: 3 }, lastMap), { price: { AAPL: 102 }, pct: { AAPL: 3 } });
eq("merge CNBC: a current quote always beats last",
  mergeQuotes(["AAPL"], { AAPL: Q({ px: 105, pct: 2 }) }, CN, {}, {}, lastMap), { price: { AAPL: 105 }, pct: { AAPL: 2 } });
eq("merge Finnhub: nothing current anywhere -> last stands in",
  mergeQuotes(["AAPL"], {}, FH, {}, {}, lastMap), { price: { AAPL: 100 }, pct: { AAPL: 1.01 } });
eq("merge: never priced by anyone -> absent (snapshot)", mergeQuotes(["ZZZ"], { ZZZ: null }, CN, {}, {}, lastMap), { price: {}, pct: {} });

// ---- review round 5 -------------------------------------------------------------------------------
// Finnhub search runs only when CNBC matched NOTHING usable — not when every match is ranked.
const allRanked = [{ TotalMatchAvailable: "1" }, { symbolName: "AAPL", companyName: "Apple Inc", countryCode: "US", issueType: "STOCK" }];
eq("matched: every match already ranked -> hits [] but matched 1 (no Finnhub call)",
  [cnbcSearchHits(allRanked, new Set(["AAPL"])), cnbcSearchMatched(allRanked)], [[], 1]);
eq("matched: only foreign / mutual-fund rows -> 0 (ask Finnhub)",
  cnbcSearchMatched([{ x: 1 }, { symbolName: "BRYN-DE", countryCode: "DE", issueType: "STOCK" }, { symbolName: "BFOCX", countryCode: "US", issueType: "FUND" }]), 0);
eq("matched: non-array / empty -> 0", [cnbcSearchMatched(null), cnbcSearchMatched([]), cnbcSearchMatched({})], [0, 0, 0]);
eq("matched counts dotted US class shares too (CNBC did match)", cnbcSearchMatched([{ symbolName: "BRK.B", countryCode: "US", issueType: "STOCK" }]), 1);

// ---- review round 6 -------------------------------------------------------------------------------
// One CNBC failure + a scroll must not count as two strikes.
eq("earlyPollOk: healthy CNBC -> yes", earlyPollOk(INITIAL_SOURCE), true);
eq("earlyPollOk: one failure -> no (the Worker would answer 502 from memory)", earlyPollOk({ source: "cnbc", fails: 1 }), false);
eq("earlyPollOk: on Finnhub -> no (keep to the PROBE_MS re-probe)", earlyPollOk({ source: "finnhub", fails: 2 }), false);
eq("earlyPollOk: one fail then one ok -> yes again", earlyPollOk(nextSource({ source: "cnbc", fails: 1 }, true)), true);

// ---- review round 8 -------------------------------------------------------------------------------
// A small batch of quiet names must not read as a frozen CNBC: the sentinel decides.
const quiet = { ABEO: Q({ day: "2026-10-21" }), ATCX: Q({ day: "2026-10-21" }) };
eq("stale: 2 quiet tickers at 12:00 + fresh SPY -> NOT stale",
  batchStale({ ...quiet, SPY: Q({ day: "2026-10-22" }) }, clk(720)), false);
eq("stale: fresh tickers + frozen SPY -> stale (the sentinel decides)",
  batchStale({ AAPL: Q({ day: "2026-10-22" }), SPY: Q({ day: "2026-10-21" }) }, clk(720)), true);
eq("stale: SPY null (CNBC lacks it) -> batch fallback", [batchStale({ ...quiet, SPY: null }, clk(720)), batchStale({ AAPL: Q(), SPY: null }, clk(720))], [true, false]);

// ---- review round 11 ------------------------------------------------------------------------------
// The modal applies the same staleness rule to its single quote.
const yq = Q({ day: "2026-10-21", px: 90, pct: -1, pc: 91, o: 89, h: 92, l: 88, pe: 22, name: "Yday" });
eq("quoteStale: yesterday's quote at 12:00 -> stale", quoteStale(yq, clk(720)), true);
eq("quoteStale: inside the grace / off-hours / today's -> not stale",
  [quoteStale(yq, clk(OPEN + 5)), quoteStale(yq, clk(17 * 60)), quoteStale(Q(), clk(720)), quoteStale(null, clk(720))], [false, false, false, false]);
const fqLive: FhQuote = { c: 101, dp: 2, o: 99, h: 102, l: 98, pc: 99 };
const ms1 = mergeModal(yq, fqLive, null, null, true);
eq("mergeModal stale: price/%/prior close/O-H-L from Finnhub", ms1.quote, { c: 101, dp: 2, pc: 99, o: 99, h: 102, l: 98, v: null });
eq("mergeModal stale: CNBC fundamentals still stand", [ms1.metric.pe, ms1.profile.name], [22, "Yday"]);
eq("mergeModal stale, Finnhub down: nothing live rather than yesterday's as current",
  mergeModal(yq, null, null, null, true).quote, { c: null, dp: null, pc: null, o: null, h: null, l: null, v: null });
eq("mergeModal not stale: CNBC head as before", mergeModal(yq, fqLive, null, null).quote.c, 90);

// ---- day volume (CNBC quote) --------------------------------------------------------------------
eq("modal volume: CNBC's session volume", mergeModal(Q({ vol: 2.5e6 }), null, null, null).quote.v, 2.5e6);
eq("modal volume: stale CNBC quote -> null (never yesterday's as today's)", mergeModal(Q({ vol: 2.5e6, day: "2026-10-21" }), FQ, null, null, true).quote.v, null);
eq("modal volume: no CNBC -> null (Finnhub's /quote has none)", mergeModal(null, FQ, null, null).quote.v, null);

if (failed) throw new Error(`${failed} quotes check(s) failed`);
console.log("\nall quotes checks passed");
