// E2E: does the bulls/bears switch to stock-aianalyst/payload.json (commit dfc2000d6) still fit the
// CI budget? Measures plain-fetch latency, bytes, JSON.parse time and heap on N real tickers, then
// extrapolates to site.yml's worst case (LIMIT=200 + near-earnings) beside forecasts on one
// FlareSolverr, and checks the workflow wiring (timeouts, continue-on-error, Health gate strings).
//   node ci/e2e/bullbear-budget.mjs            (N=20 tickers, ~45s, 20 TipRanks requests)
//   N=5 node ci/e2e/bullbear-budget.mjs        CACHE_ONLY=1 -> no network (parse/heap only)
// Read-only on the repo: bodies go to the shared scratch cache, never to public/ or src/data/.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { BROWSER_UA } from "../../worker/cnbc.js";
import { extractJson, parseBullBearPayload } from "../bullbear-payload.mjs";
import { nearEarningsNow } from "../scrape-earnings.mjs";
import { FLARE_TIMEOUT_MS } from "../tr-fetch.mjs";

const CACHE = process.env.CACHE_DIR || "/private/tmp/claude-501/-Users-nitzanmassad-Desktop-Nitzan/dfa54ae0-71e5-4ed3-b0b5-d9cf9c9f36b6/scratchpad/aianalyst-cache";
const N = Math.min(Number(process.env.N || 20), 25); // owner's home IP: hard cap 25 requests
const CACHE_ONLY = process.env.CACHE_ONLY === "1";
// Large caps + micro-caps (the old HTML page had NO section for the latter: run 45017341260 "25 failed").
const TICKERS = ["AAPL", "MSFT", "NVDA", "TSLA", "KO", "DELL", "ADI", "ADSK", "GH", "SMTC",
  "ACTU", "AGMB", "ATCX", "ATLX", "CEPL", "FISN", "JMKE", "KAPA", "QMLS", "XTND", "MNOV", "KLRA"].slice(0, N);
// Old baseline, run 45017341260 (2026-11-22, last healthy HTML run): backfill step 11:28:47 -> 11:31:55
// = 188s, bullbear's 35 targets finished inside it -> <= 5.37 s/ticker. site.yml documented LIMIT 200 as ~4-7 min.
const OLD = { stepSec: 188, targets: 35, written: 10 };
const OLD_S_PER_TICKER = OLD.stepSec / OLD.targets;
const STEP_MIN = 150, MARGIN = 0.5; // must finish in half the backfill step's timeout-minutes
const FLARE_OVERHEAD_S = 10; // assumed Chrome render cost per ticker if plain fetch gets challenged on CI
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`  PASS ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); } };

// ---- 1. workflow fit (static) ----
console.log("workflow:");
const site = readFileSync(".github/workflows/site.yml", "utf8");
const track = readFileSync(".github/workflows/track-requests.yml", "utf8");
const step = site.slice(site.indexOf("- name: Backfill forecasts + bulls/bears"), site.indexOf("- name: Build recent-reviews feed"));
const stepTmo = Number(step.match(/timeout-minutes:\s*(\d+)/)?.[1]);
check("backfill step: continue-on-error + timeout-minutes 150", () => {
  assert.match(step, /continue-on-error:\s*true/);
  assert.equal(stepTmo, STEP_MIN);
});
check("bullbear runs LIMIT=200 beside forecasts LIMIT=300 PARALLEL=2", () => {
  assert.match(step, /LIMIT=200 node ci\/scrape-bullbear\.mjs .*&/);
  assert.match(step, /LIMIT=300 PARALLEL=2 node ci\/scrape-forecasts\.mjs &/);
});
check("Health gate trips on ANY $RUNNER_TEMP/health line (no per-string grep)", () =>
  assert.match(site, /if \[ -s "\$RUNNER_TEMP\/health" \]/));
check("nothing in code/workflows keys on the old 'bullbear page' health string", () => {
  const hits = execSync("git grep -n 'bullbear page' -- . ':!docs' || true", { encoding: "utf8" }).trim();
  assert.equal(hits, "", hits);
});
check("track-requests lite run: bullbear step continue-on-error, job timeout 10", () => {
  assert.match(track, /node ci\/scrape-bullbear\.mjs &/);
  assert.match(track, /timeout-minutes:\s*10/);
});
if (/bullbear:.*SSR tipranks\.com\/stocks\/<t> page/.test(site)) console.log("  NOTE site.yml comment still says bullbear reads the SSR /stocks/<t> page (stale doc)");

// ---- 2. measure ----
console.log(`\nmeasure (${CACHE_ONLY ? "cache only" : `${TICKERS.length} fresh plain fetches, 1.5s apart`}):`);
mkdirSync(CACHE, { recursive: true });
const rows = [];
for (const [i, t] of TICKERS.entries()) {
  let body, ms = NaN, status = "cache";
  if (CACHE_ONLY) { if (!existsSync(`${CACHE}/${t}.json`)) continue; body = readFileSync(`${CACHE}/${t}.json`, "utf8"); }
  else {
    if (i) await sleep(1500);
    const t0 = performance.now();
    try {
      const r = await fetch(`https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-aianalyst/payload.json`,
        { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(30_000) });
      body = await r.text(); status = r.status;
    } catch (e) { body = ""; status = e.name; }
    ms = performance.now() - t0;
    if (status === 200) writeFileSync(`${CACHE}/${t}.json`, body);
  }
  global.gc?.();
  const h0 = process.memoryUsage().heapUsed, p0 = performance.now();
  let json = null; try { json = extractJson(body); } catch { /* challenge / error body */ }
  const parseMs = performance.now() - p0, heapMB = (process.memoryUsage().heapUsed - h0) / 2 ** 20;
  let bb = null; try { bb = json && parseBullBearPayload(json, t); } catch { /* reshape */ }
  rows.push({ t, status, ms, bytes: Buffer.byteLength(body), parseMs, heapMB, n: bb ? `${bb.bull.length}/${bb.bear.length}` : "ERR" });
  console.log(`  ${t.padEnd(5)} ${String(status).padEnd(5)} ${(ms / 1000).toFixed(2).padStart(6)}s ${(rows.at(-1).bytes / 1e6).toFixed(2)}MB parse ${parseMs.toFixed(0)}ms heap+${heapMB.toFixed(0)}MB bull/bear ${rows.at(-1).n}`);
}
const ok = rows.filter((r) => r.n !== "ERR");
const lat = rows.map((r) => r.ms / 1000).filter(Number.isFinite), bytes = rows.map((r) => r.bytes), parse = rows.map((r) => r.parseMs);
const rss = process.memoryUsage().rss / 2 ** 20;

// ---- 3. FlareSolverr-shaped bodies (Chrome renders JSON as <pre>), if another run cached some ----
const fdir = `${CACHE}/flaresolverr`;
const flare = existsSync(fdir) ? readdirSync(fdir).filter((f) => f.endsWith(".html")) : [];
const flareRows = flare.map((f) => {
  const html = readFileSync(`${fdir}/${f}`, "utf8"), p0 = performance.now();
  const bb = parseBullBearPayload(extractJson(html), f.replace(/\.html$/, ""));
  return { f, bytes: html.length, ms: performance.now() - p0, n: bb.bull.length + bb.bear.length };
});

// ---- 4. extrapolate + assert ----
const near = nearEarningsNow(); // same filter as scrape-bullbear: only universe tickers are "hot"
const hot = JSON.parse(readFileSync("src/data/stocks.json", "utf8")).filter((s) => near.has(s.t)).length, worst = 200 + hot;
const p50 = lat.length ? q(lat, 0.5) : NaN, p90 = lat.length ? q(lat, 0.9) : NaN;
const parseP90 = q(parse, 0.9) / 1000;
const plainMin = (worst * (p90 + parseP90)) / 60, flareMin = (worst * (p90 + parseP90 + FLARE_OVERHEAD_S)) / 60;
const typMin = (OLD.targets * (p50 + q(parse, 0.5) / 1000)) / 60;
const meanMB = bytes.reduce((a, b) => a + b, 0) / bytes.length / 1e6;
console.log(`\nsummary:
  latency p50 ${p50.toFixed(2)}s p90 ${p90.toFixed(2)}s | body mean ${meanMB.toFixed(2)}MB max ${(Math.max(...bytes) / 1e6).toFixed(2)}MB | parse p90 ${(parseP90 * 1000).toFixed(0)}ms | heap/parse max ${Math.max(...rows.map((r) => r.heapMB)).toFixed(0)}MB | rss ${rss.toFixed(0)}MB
  parsed ${ok.length}/${rows.length}; FlareSolverr-shaped bodies parsed ${flareRows.filter((r) => r.n).length}/${flareRows.length} (max ${(Math.max(0, ...flareRows.map((r) => r.bytes)) / 1e6).toFixed(2)}MB, ${Math.max(0, ...flareRows.map((r) => r.ms)).toFixed(0)}ms)
  typical run (${OLD.targets} targets): new ~${typMin.toFixed(1)} min  vs old <= ${(OLD.stepSec / 60).toFixed(1)} min (${OLD_S_PER_TICKER.toFixed(2)} s/ticker bound)
  worst run (${worst} = LIMIT 200 + ${hot} near earnings): plain ${plainMin.toFixed(1)} min, all-FlareSolverr ~${flareMin.toFixed(1)} min | budget ${STEP_MIN * MARGIN} of ${STEP_MIN} min
  worst run download ~${((worst * meanMB)).toFixed(0)}MB; FLARE_TIMEOUT_MS ${FLARE_TIMEOUT_MS / 1000}s vs FlareSolverr maxTimeout 60s`);
console.log("\nbudget:");
if (!CACHE_ONLY) {
  check(`>= 90% of fresh fetches parse (${ok.length}/${rows.length})`, () => assert.ok(ok.length >= 0.9 * rows.length));
  check(`per-ticker p50 ${p50.toFixed(2)}s <= old bound ${OLD_S_PER_TICKER.toFixed(2)}s`, () => assert.ok(p50 <= OLD_S_PER_TICKER));
  check(`worst run (plain) ${plainMin.toFixed(1)} min <= ${STEP_MIN * MARGIN} min`, () => assert.ok(plainMin <= STEP_MIN * MARGIN));
  check(`worst run (all FlareSolverr) ${flareMin.toFixed(1)} min <= ${STEP_MIN} min`, () => assert.ok(flareMin <= STEP_MIN));
}
check(`JSON.parse p90 ${(parseP90 * 1000).toFixed(0)}ms < 500ms`, () => assert.ok(parseP90 < 0.5));
check(`heap per parse < 256MB, rss ${rss.toFixed(0)}MB < 1024MB`, () => assert.ok(Math.max(...rows.map((r) => r.heapMB)) < 256 && rss < 1024));
check("FlareSolverr <pre> bodies extract + parse", () => assert.ok(flareRows.every((r) => r.n >= 0)));
console.log(failures ? `\nRESULT: DEGRADED (${failures} check(s) failed)` : "\nRESULT: OK, no budget degradation");
process.exitCode = failures ? 1 : 0;
