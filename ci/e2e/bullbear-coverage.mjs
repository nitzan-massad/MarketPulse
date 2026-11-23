// E2E coverage check for the bulls/bears source switch (dfc2000d6): HTML /stocks/<t> -> stock-aianalyst/payload.json.
// Question: does the JSON source give a thesis for at least as many tickers as the HTML page did?
//
// OLD outcome per ticker (frozen here, from evidence of the HTML-parser era 2026-11-05..11-22):
//   LOG_FILLED  "T: 3↑ 3↓ ✓" in Refresh runs 45017341260 / 44971019021 (gh run view <id> --log)
//   FILE_FILLED public/bullbear/T.json at dfc2000d6^ with asOf 2026-11-20/21 (written by the HTML parser),
//               picked at market-cap deciles (mega-cap -> micro-cap)
//   NO_SECTION  "T: skip (no bull/bear section)" in both runs above (the 8 with no file at all + 6 that had one)
// NEW outcome: parseBullBearPayload on the live (or cached) payload -> filled | empty | throw.
// Asserts: every OLD-filled ticker is filled by the new source. Reports how many NO_SECTION ones it now fills.
//
// Run: node ci/e2e/bullbear-coverage.mjs        (CACHE_DIR=<dir> to reuse/write raw payloads; OFFLINE=1 = cache only)
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractJson, parseBullBearPayload } from "../bullbear-payload.mjs";

const CACHE = process.env.CACHE_DIR ||
  "/private/tmp/claude-501/-Users-nitzanmassad-Desktop-Nitzan/dfa54ae0-71e5-4ed3-b0b5-d9cf9c9f36b6/scratchpad/aianalyst-cache";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const SAMPLE = {
  LOG_FILLED: "ADI ADSK ALAR BLRX BZAI COSM DELL GDEV IVA SMTC ZEPP",
  FILE_FILLED: "AAPL VRTX MDLN GH FPS IRD NRXP VRCA BSEM",
  NO_SECTION: "DFNS PUSA NNNN XTND QMLS FRMI CNXU ANT KPTI KLRA MNOV ATCX ACTU AMSS",
  PROBE: "BRK.B", // odd ticker: src/data/stocks.json has no dotted tickers today; info only, not asserted
};

let lastNet = 0;
async function payload(t) {
  const file = `${CACHE}/${t}.json`;
  try { return readFileSync(file, "utf8"); } catch { /* not cached */ }
  if (process.env.OFFLINE) throw new Error("not cached (OFFLINE)");
  const wait = lastNet + 1500 - Date.now(); // polite: sequential, >=1.5s apart
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNet = Date.now();
  const res = await fetch(`https://www.tipranks.com/stocks/${encodeURIComponent(t.toLowerCase())}/stock-aianalyst/payload.json`,
    { headers: { "user-agent": UA, accept: "application/json" } });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  extractJson(body); // only cache real JSON, never a challenge page
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, body);
  return body;
}

const rows = [];
for (const [old, list] of Object.entries(SAMPLE)) {
  for (const t of list.split(" ")) {
    let now, detail;
    try {
      const bb = parseBullBearPayload(extractJson(await payload(t)), t);
      now = bb.bull.length || bb.bear.length ? "filled" : "empty";
      detail = `${bb.bull.length}↑ ${bb.bear.length}↓`;
    } catch (e) { now = "throw"; detail = e.message; }
    rows.push({ t, old, now, detail });
    console.log(`  ${t.padEnd(6)} old=${old.padEnd(11)} new=${now.padEnd(6)} ${detail}`);
  }
}

const oldFilled = rows.filter((r) => r.old.endsWith("_FILLED"));
const lost = oldFilled.filter((r) => r.now !== "filled");
const noSec = rows.filter((r) => r.old === "NO_SECTION");
const gained = noSec.filter((r) => r.now === "filled");
const probe = rows.filter((r) => r.old === "PROBE");
console.log(`\nold-filled kept: ${oldFilled.length - lost.length}/${oldFilled.length}` +
  (lost.length ? `  LOST: ${lost.map((r) => `${r.t}(${r.now}: ${r.detail})`).join(", ")}` : ""));
console.log(`old "no section" now filled: ${gained.length}/${noSec.length}  [${gained.map((r) => r.t).join(" ")}]`);
console.log(`old "no section" still empty/throw: ${noSec.filter((r) => r.now !== "filled").map((r) => `${r.t}(${r.now})`).join(" ") || "none"}`);
console.log(`probe: ${probe.map((r) => `${r.t}=${r.now}`).join(" ")}`);
console.log(`coverage in sample: old ${oldFilled.length}/${rows.length - probe.length} -> new ${rows.filter((r) => r.old !== "PROBE" && r.now === "filled").length}/${rows.length - probe.length}`);

assert.equal(lost.length, 0, `DEGRADATION: ${lost.length} ticker(s) the HTML page filled come back empty/throw from payload.json`);
console.log("PASS: no ticker lost its thesis");
