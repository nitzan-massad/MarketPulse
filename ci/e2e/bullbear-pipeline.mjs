// E2E: the bulls/bears scrape as site.yml runs it, end to end, in a throwaway git worktree.
//   worktree of HEAD -> snapshot prev data (site.yml "Snapshot previous data") -> run the REAL
//   `LIMIT=20 node ci/scrape-bullbear.mjs` (FlareSolverr at a dead port: plain fetch only) ->
//   restore the inputs it only reads -> THE DATA GATE (`npm test` with PREV_DIR) -> asserts -> cleanup.
//
// Run:  node ci/e2e/bullbear-pipeline.mjs          (from the repo root; never writes the main checkout)
// Env:  CACHE_DIR  raw payload.json bodies per ticker (<T>.json): read before the network, written after.
//                  A full cache re-runs offline. Default: $TMPDIR/aianalyst-cache.
//       SCRATCH    where the worktree goes (default $TMPDIR). KEEP=1 leaves it for inspection.
//
// Two inputs are narrowed in the worktree, restored before the gate:
//   - public/earnings.json -> [] : near-earnings tickers ride ON TOP of LIMIT (~100 today), which
//     would blow the request budget.
//   - src/data/stocks.json   -> only tickers the OLD HTML parser refreshed on its last good run
//     (bullbear asOf within 2 days of the newest), cached payloads first (sort is stable), with
//     STALE_DAYS=0 so they are eligible. That makes ">= 18/20 written" like-for-like. Without it,
//     stalest-first picks the ~16 files frozen since 2026-11-03: tickers the HTML source also
//     stopped yielding a thesis for (payload: entry present, keyPoints []), i.e. not a regression.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const N = 20, MIN_OK = 18, MAX_REQ = 40, GAP_MS = 1500;
const CACHE = path.resolve(process.env.CACHE_DIR || path.join(tmpdir(), "aianalyst-cache"));
const WT = path.join(process.env.SCRATCH || tmpdir(), `wt-bullbear-pipeline-${process.pid}`);
const PREV = `${WT}-prev`, PRELOAD = `${WT}-preload.mjs`, COUNT = `${WT}-requests`;
const git = (...a) => execFileSync("git", ["-C", WT, ...a], { encoding: "utf8" });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// fetch shim loaded into the scraper: serve payload.json from CACHE_DIR, else a paced real fetch
// whose 200 body is cached. Every real request bumps COUNT so the budget is asserted, not assumed.
const preload = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const real = globalThis.fetch, CACHE = ${JSON.stringify(CACHE)}, COUNT = ${JSON.stringify(COUNT)};
let last = 0;
globalThis.fetch = async (url, opts) => {
  const m = String(url).match(/tipranks\\.com\\/stocks\\/([^/]+)\\/stock-aianalyst\\/payload\\.json/);
  if (!m) throw new Error("e2e: unexpected network call " + url); // FlareSolverr is dead on purpose
  const f = CACHE + "/" + decodeURIComponent(m[1]).toUpperCase() + ".json";
  if (existsSync(f)) return new Response(readFileSync(f, "utf8"), { status: 200 });
  const wait = last + ${GAP_MS} - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now(); appendFileSync(COUNT, m[1] + "\\n");
  const r = await real(url, opts), body = await r.text();
  if (r.status === 200) { mkdirSync(CACHE, { recursive: true }); writeFileSync(f, body); }
  return new Response(body, { status: r.status, headers: r.headers });
};`;

let failed = false;
try {
  // ---- worktree (deps symlinked per entry so run-tests' node_modules/.tmp stays private to it)
  execFileSync("git", ["-C", ROOT, "worktree", "add", "--detach", WT, "HEAD"], { stdio: "ignore" });
  mkdirSync(`${WT}/node_modules`);
  for (const e of readdirSync(`${ROOT}/node_modules`)) if (e !== ".tmp") symlinkSync(`${ROOT}/node_modules/${e}`, `${WT}/node_modules/${e}`);
  writeFileSync(PRELOAD, preload);

  // ---- snapshot exactly as site.yml does, before anything is rewritten
  mkdirSync(PREV);
  execFileSync("cp", [`${WT}/src/data/stocks.json`, `${PREV}/prev-stocks.json`]);
  execFileSync("cp", [`${WT}/src/data/seen.json`, `${PREV}/prev-seen.json`]);
  execFileSync("cp", ["-r", `${WT}/public/forecasts`, `${PREV}/prev-forecasts`]);

  // ---- narrow the read-only inputs (see header), run the real scraper, restore
  const stocks = readJson(`${WT}/src/data/stocks.json`);
  const asOf = (t) => { try { return Date.parse(readJson(`${WT}/public/bullbear/${t}.json`).asOf) || 0; } catch { return 0; } };
  const newest = Math.max(...stocks.map((s) => asOf(s.t)));
  const cached = (t) => existsSync(`${CACHE}/${t}.json`);
  const fresh = stocks.filter((s) => asOf(s.t) >= newest - 2 * 864e5).sort((a, b) => cached(b.t) - cached(a.t));
  console.log(`like-for-like set: ${fresh.length}/${stocks.length} tickers refreshed by the old parser since ${new Date(newest - 2 * 864e5).toISOString().slice(0, 10)}`);
  writeFileSync(`${WT}/src/data/stocks.json`, JSON.stringify(fresh));
  writeFileSync(`${WT}/public/earnings.json`, "[]");
  const run = spawnSync(process.execPath, ["--import", PRELOAD, "ci/scrape-bullbear.mjs"], {
    cwd: WT, encoding: "utf8", timeout: 15 * 60_000,
    env: { ...process.env, LIMIT: String(N), STALE_DAYS: "0", FLARESOLVERR_URL: "http://127.0.0.1:9/v1", RUNNER_TEMP: "" },
  });
  git("checkout", "--", "src/data/stocks.json", "public/earnings.json");
  process.stdout.write(run.stdout + run.stderr);
  const requests = existsSync(COUNT) ? readFileSync(COUNT, "utf8").trim().split("\n").filter(Boolean).length : 0;

  // ---- THE DATA GATE, as site.yml runs it
  const gate = spawnSync("npm", ["test"], { cwd: WT, encoding: "utf8", timeout: 5 * 60_000,
    env: { ...process.env, PREV_DIR: PREV, DROPPED: `${PREV}/dropped.json`, ACCEPT_DATA_LOSS: "", RUNNER_TEMP: "" } });

  // ---- asserts
  const done = run.stdout.match(/done: (\d+) written, (\d+) empty, (\d+) failed, (\d+) skipped/);
  const written = [...run.stdout.matchAll(/^ {2}(\S+): \d+↑ \d+↓ ✓$/gm)].map((m) => m[1]).sort();
  const changed = git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean)
    .map((l) => [l.slice(0, 2).trim(), l.slice(3)]);
  let ptsPrev = 0, ptsNow = 0; const lostSide = [];
  for (const t of written) {
    const was = JSON.parse(git("show", `HEAD:public/bullbear/${t}.json`)), now = readJson(`${WT}/public/bullbear/${t}.json`);
    for (const s of ["bull", "bear"]) {
      ptsPrev += was[s].length; ptsNow += now[s].length;
      if (was[s].length && !now[s].length) lostSide.push(`${t}.${s}`);
    }
  }
  const checks = [
    ["scraper exit 0", run.status === 0, `status=${run.status}${run.error ? " " + run.error.message : ""}`],
    [`attempted ${N} tickers`, done && +done[1] + +done[2] + +done[3] + +done[4] === N, done?.[0]],
    [`>= ${MIN_OK}/${N} written`, written.length >= MIN_OK, `${written.length} written`],
    [`<= ${MAX_REQ} TipRanks requests`, requests <= MAX_REQ, `${requests} network, ${N - requests} from cache`],
    ["DATA GATE (npm test) passes", gate.status === 0, gate.status === 0 ? (gate.stdout.match(/^.*\d+ passed.*$/m)?.[0] ?? "ok") : gate.stdout.slice(-3000) + gate.stderr],
    ["diff = exactly the refreshed public/bullbear files (modified, none added/deleted)",
      JSON.stringify(changed) === JSON.stringify(written.map((t) => ["M", `public/bullbear/${t}.json`])),
      changed.filter(([s, p]) => s !== "M" || !written.includes(p.replace(/^public\/bullbear\/|\.json$/g, ""))).map((c) => c.join(" ")).join(", ") || `${changed.length} files`],
    ["no refreshed file lost a whole bull/bear side", lostSide.length === 0, lostSide.join(", ") || `points ${ptsPrev} -> ${ptsNow}`],
  ];
  console.log("\n==== bullbear pipeline e2e ====");
  for (const [name, ok, info] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  (${info})`);
  const bad = checks.filter((c) => !c[1]);
  assert.equal(bad.length, 0, `${bad.length} check(s) failed: ${bad.map((c) => c[0]).join("; ")}`);
  console.log(`RESULT: PASS — ${written.length}/${N} written, ${requests} requests, data gate green, diff limited to ${changed.length} bullbear files`);
} catch (e) {
  failed = true;
  console.error(`RESULT: FAIL — ${e.message}`);
} finally {
  if (process.env.KEEP !== "1") {
    spawnSync("git", ["-C", ROOT, "worktree", "remove", "--force", WT]);
    for (const p of [PREV, PRELOAD, COUNT]) rmSync(p, { recursive: true, force: true });
  } else console.log(`kept: ${WT}`);
}
process.exit(failed ? 1 : 0);
