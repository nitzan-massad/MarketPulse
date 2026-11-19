// The data-loss gate (ci/data-loss.mjs). Unit cases for every violation type and every allowed
// case, then the LIVE check: the previous snapshot (PREV_DIR, set by site.yml to $RUNNER_TEMP)
// against the working tree. Unset (pre-scrape `npm test`, local runs) -> HEAD vs itself.
// No network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lossReport, loadSnapshot, countRows } from "./data-loss.mjs";

const row = (t, o = {}) => ({ t, n: t + " Inc", sec: "Tech", px: 10, pt: 12, up: 5, con: "Buy", ss: 5, ai: 70, air: "Outperform", aipt: 15, mc: 100, desc: "d", ...o });
const base = () => ({ prevRows: [row("A"), row("B")], nextRows: [row("A"), row("B")], prevSeen: { A: { d: "2026-01-01" } }, nextSeen: { A: { d: "2026-01-01" } }, prevFc: { A: 10 }, nextFc: { A: 10 } });
const run = (o) => lossReport({ ...base(), ...o });
const many = (k, n) => Array.from({ length: 20 }, (_, i) => row("T" + i, i < n ? { [k]: null } : {}));
const manyPrev = () => Array.from({ length: 20 }, (_, i) => row("T" + i));
let cases = 0;
const ok = (name, o) => { cases++; assert.deepEqual(run(o), [], name); };
const bad = (name, o, re, count = 1) => { cases++; const r = run(o); assert.equal(r.length, count, `${name}: ${JSON.stringify(r)}`); assert.match(r[0], re, name); };

ok("identical snapshots", {});
ok("missing DROPPED -> []", { dropped: undefined });
bad("ticker vanished", { nextRows: [row("A")] }, /vanished.*B/);
ok("listed dropped ticker", { nextRows: [row("A")], dropped: ["B"] });
bad("mc 5 -> null", { prevRows: [row("A", { mc: 5 })], nextRows: [row("A", { mc: null })] }, /A\.mc/);
bad("sec -> null", { nextRows: [row("A", { sec: null }), row("B")] }, /A\.sec/);
ok("strict field null -> value", { prevRows: [row("A", { desc: null })], nextRows: [row("A")] });
ok("15 pt nulls", { prevRows: manyPrev(), nextRows: many("pt", 15) });
bad("16 pt nulls", { prevRows: manyPrev(), nextRows: many("pt", 16) }, /16 rows lost pt/);
bad("11 ss nulls", { prevRows: manyPrev(), nextRows: many("ss", 11) }, /11 rows lost ss/);
bad("6 con nulls", { prevRows: manyPrev(), nextRows: many("con", 6) }, /6 rows lost con/);
// AI trio (round 4 fix 1): an explicit null AI block now writes null instead of carrying, so a
// screener-wide `aiAnalystData: null` would wipe every in-pull trio. Replay max 0/run -> limit 10.
ok("10 ai nulls", { prevRows: manyPrev(), nextRows: many("ai", 10) });
bad("11 ai nulls", { prevRows: manyPrev(), nextRows: many("ai", 11) }, /11 rows lost ai/);
ok("10 air nulls", { prevRows: manyPrev(), nextRows: many("air", 10) });
bad("11 air nulls", { prevRows: manyPrev(), nextRows: many("air", 11) }, /11 rows lost air/);
bad("11 aipt nulls", { prevRows: manyPrev(), nextRows: many("aipt", 11) }, /11 rows lost aipt/);
bad("whole trio wiped on 20 rows", { prevRows: manyPrev(), nextRows: Array.from({ length: 20 }, (_, i) => row("T" + i, { ai: null, air: null, aipt: null })) }, /20 rows lost ai\b/, 3);
ok("ai already null before", { prevRows: manyPrev().map((r) => ({ ...r, ai: null })), nextRows: many("ai", 20) });
ok("pt already null before", { prevRows: manyPrev().map((r) => ({ ...r, pt: null })), nextRows: many("pt", 20) });
bad("seen d changed", { nextSeen: { A: { d: "2026-02-02" } } }, /seen\.A\.d changed/);
bad("seen key gone", { nextSeen: {} }, /seen\.A: key gone/);
ok("seen key gone but dropped", { nextSeen: {}, dropped: ["A"] });
bad("forecast file deleted", { nextFc: {} }, /A\.json deleted/);
ok("forecast file deleted but ticker expired", { nextFc: {}, dropped: ["A"] });
bad("forecast 10 -> 7", { nextFc: { A: 7 } }, /shrank 10 -> 7/);
ok("forecast 10 -> 9", { nextFc: { A: 9 } });
ok("forecast 4 -> 1 (below min rows)", { prevFc: { A: 4 }, nextFc: { A: 1 } });
// forecast row counting: AI-model rows and rows >365d old do not count (fixed "now", deterministic)
const NOW = Date.parse("2026-11-18");
const human = (n, d = "2026-11-01") => Array.from({ length: n }, (_, i) => ({ n: "H" + i, f: "Firm" + i, d }));
const ai = (n) => Array.from({ length: n }, (_, i) => ({ n: "AI" + i, f: "TipRanks - Model" + i, d: "2026-11-01" }));
const old = (n) => human(n, "2025-11-01");
const fc = (rows) => ({ A: countRows(rows, NOW) });
ok("10 -> 7 where 3 dropped are AI rows", { prevFc: fc([...human(7), ...ai(3)]), nextFc: fc(human(7)) });
ok("10 -> 7 where 3 dropped are >365d old", { prevFc: fc([...human(7), ...old(3)]), nextFc: fc(human(7)) });
bad("10 -> 7 recent human rows still a violation", { prevFc: fc(human(10)), nextFc: fc(human(7)) }, /shrank 10 -> 7/);
assert.equal(countRows([{ f: "tipranks - X", d: "2026-11-01" }, { f: "Y" }, { f: "Z", d: "2025-11-17" }, { f: "W", d: "2025-11-19" }], NOW), 2); // no date counts; 365d boundary
console.log(`unit cases: ${cases} passed`);

// ---- live check ----
const dir = process.env.PREV_DIR || "";
const prev = loadSnapshot(dir || undefined);
const next = loadSnapshot();
// PREV_DIR set but no previous rows (site.yml's copy failed, wrong dir): every comparison below
// would pass vacuously while the gate reads green. Fail loudly instead.
assert.ok(!dir || prev.rows.length > 0, `PREV_DIR=${dir} holds no prev-stocks.json rows — the gate would compare against nothing`);
let dropped = [];
if (process.env.DROPPED) { try { dropped = JSON.parse(readFileSync(process.env.DROPPED, "utf8")); } catch { /* none written */ } }
console.log(dir
  ? `live: comparing ${dir} snapshot (${prev.rows.length} rows, ${Object.keys(prev.fc).length} forecast files) with the working tree (${next.rows.length} rows), ${dropped.length} expired tickers`
  : `live: PREV_DIR unset, comparing HEAD with itself (${next.rows.length} rows, ${Object.keys(next.fc).length} forecast files)`);
const report = lossReport({ prevRows: prev.rows, nextRows: next.rows, prevSeen: prev.seen, nextSeen: next.seen, prevFc: prev.fc, nextFc: next.fc, dropped });
for (const l of report) console.log("  DATA LOSS: " + l);
assert.deepEqual(report, [], `the refresh lost data (${report.length} violation(s), see above)`);
console.log("live: no data lost");
