// Row mappers + keep-last-known merge (ci/keep.mjs: rowFromScreener, rowFromAiAnalyst, mergeRow).
// Contract: `undefined` = "this source can't see the field -> keep prev", `null` = explicit empty.
// No network; fixtures in ci/fixtures/ are trimmed real payloads (the fixture is the truth).
// Run: node ci/test-row-mappers.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROW_KEYS, rowFromScreener, rowFromAiAnalyst, mergeRow } from "./keep.mjs";

const fx = (f) => JSON.parse(readFileSync(new URL("./fixtures/" + f, import.meta.url), "utf8"));
const S = fx("screener-items.json");
const aapl = fx("aianalyst-aapl.json");
const nnnn = fx("aianalyst-nnnn.json");

assert.equal(ROW_KEYS.length, 17);
assert.deepEqual([...ROW_KEYS], "t,n,sec,px,chg,pt,up,con,b,h,s,ss,ai,air,aipt,mc,desc".split(","));

// AAPL screener item, in pull: best-analyst basis, exactly what the old inline code produced.
{
  const r = rowFromScreener(S.aapl, { inPull: true });
  assert.deepEqual(r, {
    t: "AAPL", n: "Apple Inc", sec: "Technology", px: 351.91, chg: -0.25,
    pt: 339.98, up: -3.4, con: "Buy", b: 11, h: 6, s: 5, ss: 7,
    ai: 75, air: "Outperform", aipt: 381, mc: 5114020,
    desc: S.aapl.tradingInformationData.description,
  });
}
// D1: off-pull = all-analyst counts, but pt/up still the best target.
{
  const r = rowFromScreener(S.aapl, { inPull: false });
  assert.deepEqual([r.b, r.h, r.s, r.con], [15, 8, 6, "Buy"]);
  assert.equal(r.pt, 339.98);
  assert.equal(r.up, -3.4);
}
// No coverage, in pull: explicit empty, as today.
{
  const r = rowFromScreener(S.nocov, { inPull: true });
  assert.deepEqual([r.con, r.b, r.h, r.s, r.pt, r.up], [null, 0, 0, 0, null, null]);
  const o = rowFromScreener(S.nocov, { inPull: false });
  assert.deepEqual([o.con, o.b, o.h, o.s, o.pt, o.up], ["Neutral", 0, 0, 0, null, null]); // getData parity (D1): no coverage off-pull = Neutral 0/0/0
}
// Only best is null: in pull = no fallback (as today); off pull = all-analyst counts + target.
{
  const a = rowFromScreener(S.bestnull, { inPull: true });
  assert.deepEqual([a.con, a.b, a.pt], [null, 0, null]);
  const r = rowFromScreener(S.bestnull, { inPull: false });
  assert.deepEqual([r.con, r.b, r.h, r.s], ["Buy", 1, 0, 0]);
  assert.equal(r.pt, 88);
  assert.equal(r.up, 83.6);
}
// Missing aiAnalystData: the trio is "unknown" and survives a merge.
{
  const r = rowFromScreener(S.noai, { inPull: true });
  assert.equal(r.ai, undefined);
  assert.equal(r.air, undefined);
  assert.equal(r.aipt, undefined);
  const m = mergeRow({ ai: 70, air: "Neutral", aipt: 5 }, r);
  assert.deepEqual([m.ai, m.air, m.aipt], [70, "Neutral", 5]);
  assert.equal(m.n, "Samsung Electronics Co. Ltd."); // fresh fields still land
}
// "General" sector is unknown, not a value.
{
  assert.equal(rowFromScreener(S.general, { inPull: true }).sec, undefined);
  assert.equal(mergeRow({ sec: "Technology" }, rowFromScreener(S.general, { inPull: true })).sec, "Technology");
}
// Explicit-null Smart Score is an answer and survives the merge.
{
  const r = rowFromScreener(S.ssnull, { inPull: true });
  assert.equal(r.ss, null);
  assert.equal(mergeRow({ ss: 7 }, r).ss, null);
}
// Missing parents -> undefined everywhere they feed (off-pull; in-pull consensus/target: see B4).
{
  const r = rowFromScreener({}, { inPull: false });
  for (const k of ROW_KEYS) assert.equal(r[k], undefined, k);
  const m = mergeRow({ t: "X", px: 9, con: "Buy", ss: 3 }, r);
  assert.deepEqual([m.t, m.px, m.con, m.ss], ["X", 9, "Buy", 3]);
  const ip = rowFromScreener({}, { inPull: true });
  for (const k of ROW_KEYS.filter((k) => !["con", "b", "h", "s", "pt", "up"].includes(k))) assert.equal(ip[k], undefined, k);
}

// aianalyst AAPL: counts from analystRatings.all, target from best.
{
  const r = rowFromAiAnalyst(aapl, "AAPL");
  assert.deepEqual([r.con, r.b, r.h, r.s], ["Buy", 15, 8, 6]);
  assert.equal(r.pt, 339.98);
  assert.equal(r.up, -3.4);
  assert.equal(r.ss, 7);
  assert.equal(r.mc, 5114027);
  assert.equal(r.n, "Apple Inc");
  assert.equal(r.sec, "Technology");
  assert.equal(r.px, 351.91);
  assert.equal(r.chg, -0.25);
  assert.equal(r.ai, 75);
  assert.equal(r.air, "Outperform");
  assert.equal(typeof r.aipt, "number");
}
// aianalyst NNNN: no analyst coverage, no AI report.
{
  const r = rowFromAiAnalyst(nnnn, "NNNN");
  assert.ok(r.n);
  assert.equal(r.px, 3.65);
  assert.equal(r.con, "Neutral"); // getData parity (D1): no all-analyst coverage = Neutral 0/0/0
  assert.equal(r.b + r.h + r.s, 0);
  assert.equal(r.pt, null);
  assert.equal(r.ai, undefined);
  assert.equal(r.sec, undefined); // "General" is not a trusted sector
  assert.equal(r.ss, 4);
}
// Wrong ticker -> null -> merge keeps prev.
{
  assert.equal(rowFromAiAnalyst(aapl, "MSFT"), null);
  assert.equal(rowFromAiAnalyst({}, "AAPL"), null);
  assert.equal(mergeRow({ px: 1 }, null).px, 1);
  assert.equal(mergeRow(undefined, null), undefined);
}
// mergeRow: NaN counts as unknown; full shape, never undefined.
{
  const m = mergeRow({ px: 5 }, { px: NaN, pt: undefined, ss: null });
  assert.equal(m.px, 5);
  assert.equal(m.pt, null);
  assert.equal(m.ss, null);
  const full = mergeRow(undefined, rowFromScreener(S.noai, { inPull: true }));
  for (const k of ROW_KEYS) {
    assert.ok(k in full, "key " + k);
    assert.notEqual(full[k], undefined, k);
  }
}
// I2a — the data-loss gate's STRICT fields (n, px, mc, desc, sec) never come out of a mapper as
// null: an empty/null/"" there is "can't see it" (undefined -> carry), or every run with one such
// row would trip the gate and freeze the deploy.
{
  const STRICT = ["n", "px", "mc", "desc", "sec"];
  const prev = { t: "X", n: "X Corp", px: 9, mc: 100, desc: "d", sec: "Technology" };
  const blankItem = (v) => ({ tradingInformationData: { ticker: "X", companyName: v, lastClose: v, marketCap: v, description: v, sector: v === "" ? { name: "" } : v } });
  for (const v of [null, ""]) {
    for (const inPull of [true, false]) {
      const r = rowFromScreener(blankItem(v), { inPull });
      for (const k of STRICT) assert.equal(r[k], undefined, `screener ${k}=${JSON.stringify(v)} inPull=${inPull}`);
      const m = mergeRow(prev, r);
      for (const k of STRICT) assert.equal(m[k], prev[k], `screener merge keeps ${k}`);
    }
  }
  const blankAi = (v) => ({ models: { stocks: [{ _id: "X", company: { companyName: v, name: v, description: v, sector: v }, prices: { daily: { priceUSD: v, gain: 0.01 } }, marketCap: { daily: { marketCap: v } } }] } });
  for (const v of [null, ""]) {
    const r = rowFromAiAnalyst(blankAi(v), "X");
    for (const k of STRICT) assert.equal(r[k], undefined, `aianalyst ${k}=${JSON.stringify(v)}`);
    const m = mergeRow(prev, r);
    for (const k of STRICT) assert.equal(m[k], prev[k], `aianalyst merge keeps ${k}`);
  }
  // a real value still lands
  const real = rowFromScreener({ tradingInformationData: { ticker: "X", companyName: "New", lastClose: 2, marketCap: 3e6, description: "nd", sector: { name: "Energy" } } }, { inPull: true });
  assert.deepEqual([real.n, real.px, real.mc, real.desc, real.sec], ["New", 2, 3, "nd", "Energy"]);
}
// B3 — explicit null vs absent, field by field (CLAUDE.md: an explicit TipRanks null is data; only
// an ABSENT key carries the previous value).
{
  const prev = { t: "X", ss: 7, con: "Buy", b: 3, h: 1, s: 0, pt: 20, up: 10 };
  const ai = (s) => ({ models: { stocks: [{ _id: "X", company: { companyName: "X Corp" }, prices: { daily: { priceUSD: 5, gain: 0.01 } }, ...s }] } });
  // smartScore
  const ssNull = rowFromAiAnalyst(ai({ smartScore: null }), "X");
  console.log("B3 aianalyst smartScore:null -> ss =", ssNull.ss, "| merged over ss 7 ->", mergeRow(prev, ssNull).ss);
  assert.equal(ssNull.ss, null, "smartScore: null = no Smart Score -> ss null, not carry");
  assert.equal(mergeRow(prev, ssNull).ss, null, "and it beats the stale prev.ss");
  assert.equal(rowFromAiAnalyst(ai({ smartScore: { value: null } }), "X").ss, null, "value: null -> null");
  assert.equal(rowFromAiAnalyst(ai({}), "X").ss, undefined, "smartScore absent -> carry");
  assert.equal(rowFromAiAnalyst(ai({ smartScore: { update: "2026-11-15" } }), "X").ss, undefined, "value key absent (reshaped) -> carry");
  assert.equal(rowFromAiAnalyst(ai({ smartScore: { value: 9 } }), "X").ss, 9);
  // analystRatings
  const arNull = rowFromAiAnalyst(ai({ analystRatings: null }), "X");
  assert.deepEqual([arNull.con, arNull.b, arNull.h, arNull.s, arNull.pt, arNull.up], ["Neutral", 0, 0, 0, null, null], "analystRatings: null = no coverage (D1 getData parity), not carry");
  const arAbsent = rowFromAiAnalyst(ai({}), "X");
  assert.deepEqual([arAbsent.con, arAbsent.b, arAbsent.pt, arAbsent.up], [undefined, undefined, undefined, undefined], "analystRatings absent -> carry");
  const allAbsent = rowFromAiAnalyst(ai({ analystRatings: { best: { priceTarget: { value: 30, upside: 0.5 } } } }), "X");
  assert.deepEqual([allAbsent.con, allAbsent.b, allAbsent.h, allAbsent.s], [undefined, undefined, undefined, undefined], "all absent (reshaped) -> counts carry, not 'no coverage'");
  assert.deepEqual([allAbsent.pt, allAbsent.up], [30, 50], "the best target still lands");
  const bothAbsent = rowFromAiAnalyst(ai({ analystRatings: {} }), "X");
  assert.deepEqual([bothAbsent.con, bothAbsent.pt, bothAbsent.up], [undefined, undefined, undefined], "best and all absent -> carry");
  // chg
  assert.equal(rowFromAiAnalyst(ai({ prices: { daily: { priceUSD: 5, gain: null } } }), "X").chg, null, "gain: null -> null");
  assert.equal(rowFromAiAnalyst(ai({ prices: { daily: { priceUSD: 5 } } }), "X").chg, undefined, "gain absent -> carry");
  // a null-filled peer stub is not a row (else smartScore/analystRatings null would wipe ss/consensus)
  assert.equal(rowFromAiAnalyst({ models: { stocks: [{ _id: "X", company: null, analystRatings: null, smartScore: null, prices: null, report: null, marketCap: null }] } }, "X"), null, "stub only -> no row -> prev kept");

  // screener: tipRanksSmartScoreData
  const sc = (e) => ({ tradingInformationData: { ticker: "X" }, tipRanksEssentialData: e });
  for (const inPull of [true, false]) {
    const r = rowFromScreener(sc({ tipRanksSmartScoreData: null }), { inPull });
    console.log(`B3 screener tipRanksSmartScoreData:null inPull=${inPull} -> ss =`, r.ss);
    assert.equal(r.ss, null, "tipRanksSmartScoreData: null = no Smart Score (old in-pull wrote null)");
    assert.equal(rowFromScreener(sc({}), { inPull }).ss, undefined, "absent -> carry");
    assert.equal(rowFromScreener(sc({ tipRanksSmartScoreData: {} }), { inPull }).ss, undefined, "score key absent (reshaped) -> carry");
    assert.equal(rowFromScreener(sc({ tipRanksSmartScoreData: { tipRanksSmartScore: null } }), { inPull }).ss, null);
    // chg
    assert.equal(rowFromScreener({ tradingInformationData: { ticker: "X", priceChangePct: null } }, { inPull }).chg, null);
    assert.equal(rowFromScreener({ tradingInformationData: { ticker: "X" } }, { inPull }).chg, undefined);
  }
}
// B4 — in-pull basis is best-analysts only, no fallback (D1). The old in-pull mapper (c242d0cc4
// ci/refresh-data-ci.mjs: `bc = e.bestAnalystsConsensusData || {}`, `bpt = e.bestPriceTargetData || {}`,
// row built fresh, no prev merge) wrote con null, b/h/s 0, pt/up null whether the best objects were
// null OR absent. Carrying prev there mixed in an off-pull row's all-analyst counts.
{
  const prev = { t: "X", con: "StrongBuy", b: 30, h: 2, s: 0, pt: 99, up: 40 }; // all-analyst basis from an off-pull run
  const item = (e) => ({ tradingInformationData: { ticker: "X" }, ...(e === "omit" ? {} : { tipRanksEssentialData: e }) });
  const all = { analystsConsensusData: { analystConsensus: { name: "Buy" }, distribution: { buy: 9, hold: 1, sell: 0 } }, priceTargetData: { convertedPriceTarget: 50, upside: 0.2 } };
  for (const [label, e] of [["best keys absent", { ...all }], ["best keys null", { ...all, bestAnalystsConsensusData: null, bestPriceTargetData: null }], ["essential data absent", "omit"], ["essential data null", null]]) {
    const m = mergeRow(prev, rowFromScreener(item(e), { inPull: true }));
    console.log(`B4 in-pull, ${label} ->`, JSON.stringify([m.con, m.b, m.h, m.s, m.pt, m.up]));
    assert.deepEqual([m.con, m.b, m.h, m.s, m.pt, m.up], [null, 0, 0, 0, null, null], `in-pull ${label}: old empty basis, never prev's all-analyst counts`);
  }
  // off-pull keeps carry-on-absent (D1 all-analyst basis, best->all fallback)
  const off = mergeRow(prev, rowFromScreener(item({}), { inPull: false }));
  assert.deepEqual([off.con, off.b, off.pt], ["StrongBuy", 30, 99], "off-pull, keys absent -> carry");
}
// R1 (e2e) — VRCA: TipRanks sends the best-target OBJECT with a null value. Off-pull / aianalyst rows
// fall back to the all-analyst target (D1 "best falling back to all"); in-pull rows never fall back.
{
  const e = { analystsConsensusData: { analystConsensus: { name: "Buy" }, distribution: { buy: 3, hold: 0, sell: 0 } },
    bestPriceTargetData: { convertedPriceTarget: null, upside: null }, priceTargetData: { convertedPriceTarget: 13.67, upside: 2.8418 } };
  const item = { tradingInformationData: { ticker: "VRCA", lastClose: 3.56 }, tipRanksEssentialData: e };
  const off = rowFromScreener(item, { inPull: false });
  console.log("R1 VRCA off-pull pt/up ->", off.pt, off.up);
  assert.deepEqual([off.pt, off.up], [13.67, 284.2], "off-pull: empty best target -> all-analyst target");
  const inp = rowFromScreener(item, { inPull: true });
  assert.deepEqual([inp.pt, inp.up], [null, null], "in-pull: no fallback (D1)");
  // both empty -> explicit null (data), not carry
  const both = rowFromScreener({ ...item, tipRanksEssentialData: { ...e, priceTargetData: { convertedPriceTarget: null, upside: null } } }, { inPull: false });
  assert.deepEqual([both.pt, both.up], [null, null]);
  // best has a value -> best wins over all
  const bw = rowFromScreener({ ...item, tipRanksEssentialData: { ...e, bestPriceTargetData: { convertedPriceTarget: 20, upside: 4.618 } } }, { inPull: false });
  assert.deepEqual([bw.pt, bw.up], [20, 461.8]);
  // aianalyst payload: analystRatings.best.priceTarget { value: null } -> all's target
  const ap = (ar) => rowFromAiAnalyst({ models: { stocks: [{ _id: "VRCA", company: { name: "Vera" }, analystRatings: ar }] } }, "VRCA");
  const a1 = ap({ best: { priceTarget: { value: null, upside: null } }, all: { enumId: 5, buy: 3, hold: 0, sell: 0, priceTarget: { value: 13.67, upside: 2.8418 } } });
  console.log("R1 VRCA aianalyst pt/up ->", a1.pt, a1.up);
  assert.deepEqual([a1.pt, a1.up], [13.67, 284.2], "aianalyst: empty best target -> all-analyst target");
  const a2 = ap({ best: { priceTarget: null }, all: { enumId: 5, buy: 3, hold: 0, sell: 0, priceTarget: { value: 13.67, upside: 2.8418 } } });
  assert.deepEqual([a2.pt, a2.up], [13.67, 284.2], "aianalyst: best.priceTarget null -> all");
  const a3 = ap({ best: { priceTarget: { value: 20, upside: 4.618 } }, all: { enumId: 5, priceTarget: { value: 13.67, upside: 2.8418 } } });
  assert.deepEqual([a3.pt, a3.up], [20, 461.8], "aianalyst: best wins when it has a value");
}
// R4 (e2e) — ACH: the aianalyst payload omitted priceTarget.upside while pt and px were known; the old
// getData mapper computed up = rnd((pt - px) / px * 100, 1) with px already rndPx'd (c242d0cc4 keep.mjs).
{
  const ap = (pt, daily) => rowFromAiAnalyst({ models: { stocks: [{ _id: "ACH", company: { name: "Aluminum Corp" },
    analystRatings: { best: { priceTarget: pt }, all: { enumId: 5, buy: 1, hold: 0, sell: 0 } }, prices: { daily } }] } }, "ACH");
  const r = ap({ value: 0.25 }, { priceUSD: 0.13 });
  console.log("R4 ACH upside omitted -> pt/px/up", r.pt, r.px, r.up);
  assert.deepEqual([r.pt, r.px, r.up], [0.25, 0.13, 92.3], "upside omitted, pt+px known -> computed like getData");
  assert.equal(ap({ value: 0.25, upside: 0.9 }, { priceUSD: 0.13 }).up, 90, "payload upside present -> payload's");
  assert.equal(ap({ value: 0.25, upside: null }, { priceUSD: 0.13 }).up, null, "explicit null upside = data");
}
// Round 2 fix 1 (review): no target -> no upside. pt is written (null) on these shapes, so up must be
// null too — undefined carried prev's upside next to a "—" target.
{
  const prev = { t: "X", pt: 20, up: 300, px: 5 };
  const ap = (ar, daily = { priceUSD: 5 }) => rowFromAiAnalyst({ models: { stocks: [{ _id: "X", company: { name: "X Co" }, analystRatings: ar, prices: { daily } }] } }, "X");
  for (const [label, ar] of [
    ["best value null, all has no priceTarget", { best: { priceTarget: { value: null } }, all: { enumId: 5, buy: 1, hold: 0, sell: 0 } }],
    ["best priceTarget null, all value null", { best: { priceTarget: null }, all: { enumId: 5, buy: 1, hold: 0, sell: 0, priceTarget: { value: null } } }],
    ["best value key absent", { best: { priceTarget: {} }, all: { enumId: 5, buy: 1, hold: 0, sell: 0 } }],
    ["best priceTarget a scalar (reshaped)", { best: { priceTarget: 7 }, all: { enumId: 5, buy: 1, hold: 0, sell: 0 } }],
  ]) {
    const m = mergeRow(prev, ap(ar));
    console.log(`fix1 ${label} -> pt/up`, m.pt, m.up);
    assert.deepEqual([m.pt, m.up], [null, null], `${label}: target '—' never sits next to prev's upside`);
  }
  // pt known, px unknown in this payload: up null (old getData: px null -> up null), never prev's
  // upside beside a new target. px itself still carries (STRICT field).
  for (const daily of [{}, null]) { // null, not undefined: undefined would hit ap()'s default px
    const m = mergeRow(prev, ap({ best: { priceTarget: { value: 30 } }, all: { enumId: 5, buy: 1, hold: 0, sell: 0 } }, daily));
    console.log("fix1 pt known, px unknown -> pt/px/up", m.pt, m.px, m.up);
    assert.deepEqual([m.pt, m.px, m.up], [30, 5, null]);
  }
  // both target keys absent: still carry pt AND up together
  const c = mergeRow(prev, ap({}));
  assert.deepEqual([c.pt, c.up], [20, 300], "best and all keys both absent -> pt and up both carry");
}
console.log("row-mappers OK");
