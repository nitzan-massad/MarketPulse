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
  assert.deepEqual([o.con, o.b, o.h, o.s, o.pt, o.up], [null, 0, 0, 0, null, null]);
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
// Missing parents -> undefined everywhere they feed.
{
  const r = rowFromScreener({}, { inPull: true });
  for (const k of ROW_KEYS) assert.equal(r[k], undefined, k);
  const m = mergeRow({ t: "X", px: 9, con: "Buy", ss: 3 }, r);
  assert.deepEqual([m.t, m.px, m.con, m.ss], ["X", 9, "Buy", 3]);
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
  assert.equal(r.con, null);
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
console.log("row-mappers OK");
