// Offline e2e: runs the REAL ci/scrape-bullbear.mjs (as a child process, temp cwd) against a mocked
// network — plain tipranks.com GET and FlareSolverr POST — once per failure-mode scenario, and runs
// the PRE-switch HTML scraper (git archive dfc2000d6^) through the same scenarios to prove the
// payload.json version is no less strict. No real network, no repo writes.
//   node ci/e2e/bullbear-failures.mjs        (exit 1 on any degradation)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OLD_REV = process.env.OLD_REV || "dfc2000d6^";
const TMP = mkdtempSync(join(tmpdir(), "bb-e2e-"));

// --- mock network preload: routes by ticker from $MOCK, logs every call to $MOCK_LOG ----------
const PRELOAD = join(TMP, "mock-net.mjs");
writeFileSync(PRELOAD, `
import { appendFileSync } from "node:fs";
const M = JSON.parse(process.env.MOCK), LOG = process.env.MOCK_LOG;
const realST = globalThis.setTimeout; // retry sleeps (sleepMs) -> ~instant
globalThis.setTimeout = (f, ms, ...a) => realST(f, Math.min(ms ?? 0, 5), ...a);
const tick = (u) => (u.match(/tipranks\\.com\\/stocks\\/([^/?]+)/) || [])[1]?.toUpperCase();
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (opts.method === "POST" && url === process.env.FLARESOLVERR_URL) {
    const t = tick(JSON.parse(opts.body).url); appendFileSync(LOG, "flare " + t + "\\n");
    return new Response(JSON.stringify(M[t]?.flare ?? { status: "error", message: "no mock" }));
  }
  const t = tick(url);
  if (!t) throw new Error("unexpected real network: " + url);
  appendFileSync(LOG, "plain " + t + "\\n");
  const p = M[t]?.plain ?? { status: 500, body: "" };
  return new Response(p.body, { status: p.status });
};`);

// --- scenario bodies, per version ------------------------------------------------------------
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CHALLENGE = "<html><head><title>Just a moment...</title></head><body>cdn-cgi/challenge-platform/h/b</body></html>";
const BLOCK_PAGE = "<html><title>Attention Required!</title>Sorry, you have been blocked</html>";
const FS_BLOCKED = { status: "error", message: "Error solving the challenge. Cloudflare has blocked this request. Probably your IP is banned for this site." };
const flareOk = (response) => ({ status: "ok", solution: { status: 200, response } });
const json = (t, kp) => JSON.stringify({ models: { stocks_extra: [{ _id: "ZZZ" }, { _id: t, ...(kp && { aiAnalysis: { keyPoints: kp } }) }] } });
const KP = [{ sentiment: "bullish", title: "Moat", description: "Strong <b>moat</b> & brand." }, { sentiment: "bearish", title: "Risk", description: "Valuation \"rich\"." }];
const html = (pts) => `<html><body><section><h2>Bulls Say, Bears Say</h2><h3><span>Bulls Say</span></h3>${pts ? "<h4>Moat</h4><p>Strong moat.</p>" : ""}<h3><span>Bears Say</span></h3>${pts ? "<h4>Risk</h4><p>Rich.</p>" : ""}</section></body></html>`;
const ERR = '{"data":null,"error":"not found"}';
const BODY = {
  new: { good: (t) => json(t, KP), empty: (t) => json(t, null), reshaped: (t) => JSON.stringify({ models: { stocks: [{ _id: t, aiAnalysis: { keyPoints: KP } }] } }),
    wrapped: (t) => `<html><head></head><body><pre style="word-wrap: break-word">${esc(json(t, KP))}</pre></body></html>` },
  old: { good: () => html(true), empty: () => html(false), reshaped: () => "<html><body><h2>Something Else</h2></body></html>", wrapped: () => html(true) },
};
const SCEN = {
  good: (v, t) => ({ plain: { status: 200, body: BODY[v].good(t) } }),
  empty: (v, t) => ({ plain: { status: 200, body: BODY[v].empty(t) } }),
  error: () => ({ plain: { status: 200, body: ERR }, flare: flareOk(`<pre>${esc(ERR)}</pre>`) }),
  challenge: (v, t) => ({ plain: { status: 403, body: CHALLENGE }, flare: flareOk(BODY[v].wrapped(t)) }),
  blocked: () => ({ plain: { status: 403, body: BLOCK_PAGE }, flare: FS_BLOCKED }),
  reshaped: (v, t) => ({ plain: { status: 200, body: BODY[v].reshaped(t) } }),
  absent: () => ({ plain: { status: 200, body: JSON.stringify({ models: { stocks_extra: [{ _id: "ZZZ" }] } }) } }),
};

// --- versions: NEW = this checkout's ci/, OLD = git archive of the pre-switch tree ------------
const ROOTS = { new: REPO };
try {
  ROOTS.old = join(TMP, "old"); mkdirSync(ROOTS.old);
  execFileSync("sh", ["-c", `git -C "${REPO}" archive "${OLD_REV}" ci worker | tar -x -C "${ROOTS.old}"`]);
} catch (e) { delete ROOTS.old; console.log(`(old version unavailable: ${e.message.split("\n")[0]}; NEW only)`); }

let n = 0;
function run(v, plan, env = {}) { // plan: [[ticker, scenario], ...]
  const cwd = join(TMP, `run-${v}-${++n}`), rt = join(cwd, "rt");
  mkdirSync(join(cwd, "src/data"), { recursive: true }); mkdirSync(rt);
  writeFileSync(join(cwd, "src/data/stocks.json"), JSON.stringify(plan.map(([t]) => ({ t }))));
  const MOCK = JSON.stringify(Object.fromEntries(plan.map(([t, s]) => [t, SCEN[s](v, t)])));
  const r = spawnSync(process.execPath, ["--import", PRELOAD, join(ROOTS[v], "ci/scrape-bullbear.mjs")], {
    cwd, encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH, MOCK, MOCK_LOG: join(cwd, "calls"), RUNNER_TEMP: rt, FLARESOLVERR_URL: "http://mock-flare/v1", ...env },
  });
  const out = r.stdout + r.stderr, dir = join(cwd, "public/bullbear");
  const done = out.match(/done: (\d+) written, (\d+) empty, (\d+) failed, (\d+) skipped/);
  assert.ok(done, `${v}: no summary line\n${out}`);
  const [ok, empty, fail, skipped] = done.slice(1).map(Number);
  const calls = existsSync(join(cwd, "calls")) ? readFileSync(join(cwd, "calls"), "utf8").trim().split("\n") : [];
  return { code: r.status, out, ok, empty, fail, skipped, calls,
    files: existsSync(dir) ? readdirSync(dir).sort() : [],
    file: (t) => JSON.parse(readFileSync(join(dir, `${t}.json`), "utf8")),
    health: existsSync(join(rt, "health")) ? readFileSync(join(rt, "health"), "utf8") : "" };
}

// --- scenarios: [name, plan, env, check(result, version)] -------------------------------------
const one = (s, t = "AAA") => [[t, s]];
const CASES = [
  ["a good payload -> written", one("good"), { ONLY: "AAA" }, (r, v) => {
    assert.deepEqual([r.ok, r.fail, r.files], [1, 0, ["AAA.json"]]);
    const f = r.file("AAA"); assert.equal(f.bull.length, 1); assert.equal(f.bear.length, 1); assert.match(f.asOf, /^\d{4}-\d\d-\d\d$/);
    if (v === "new") assert.deepEqual(r.calls, ["plain AAA"], "plain fetch should suffice, no FlareSolverr");
  }],
  ["b no keyPoints -> empty, no file", one("empty"), { ONLY: "AAA" }, (r) => assert.deepEqual([r.ok, r.empty, r.fail, r.files], [0, 1, 0, []])],
  ['c {"data":null,"error"} -> failed, never empty', one("error"), { ONLY: "AAA" }, (r) => assert.deepEqual([r.ok, r.empty, r.fail, r.files], [0, 0, 1, []])],
  ["d challenge on plain, <pre> via FlareSolverr -> written", one("challenge"), { ONLY: "AAA" }, (r) => {
    assert.deepEqual([r.ok, r.fail, r.files], [1, 0, ["AAA.json"]]); assert.deepEqual(r.calls, ["plain AAA", "flare AAA"]);
    assert.equal(r.file("AAA").bull[0].t, "Moat");
  }],
  ["e FlareSolverr blocked x3 -> breaker, rest skipped, health", ["B1", "B2", "B3", "B4", "B5"].map((t) => [t, "blocked"]), { ONLY: "B1,B2,B3,B4,B5" }, (r, v) => {
    assert.deepEqual([r.ok, r.fail, r.skipped, r.files], [0, 3, 2, []]);
    assert.equal(r.calls.filter((c) => c.startsWith("flare")).length, 3, "block must fail fast: 1 FlareSolverr call per ticker");
    assert.ok(!r.calls.some((c) => / B[45]$/.test(c)), "skipped tickers must not be fetched");
    assert.equal(r.health.trim(), `breaker open: bullbear ${v === "new" ? "payload" : "page"}`);
  }],
  ["f full run, 10 tickers, 0 written -> ::warning:: + exit 1", Array.from({ length: 10 }, (_, i) => [`F${i}`, "error"]), {}, (r) => {
    assert.equal(r.fail, 10); assert.equal(r.code, 1); assert.match(r.out, /::warning::bullbear: 0 of 10 written/);
  }],
  ["f ONLY run, 0 written -> exit 0, no warning", Array.from({ length: 10 }, (_, i) => [`F${i}`, "error"]), { ONLY: Array.from({ length: 10 }, (_, i) => `F${i}`).join(",") }, (r) => {
    assert.equal(r.fail, 10); assert.equal(r.code, 0); assert.doesNotMatch(r.out, /::warning::/);
  }],
  ["g reshaped (no stocks_extra / no section) -> failed", one("reshaped"), { ONLY: "AAA" }, (r) => assert.deepEqual([r.ok, r.empty, r.fail, r.files], [0, 0, 1, []])],
  ["mixed full run: one good keeps exit 0, outcomes isolated", [["M1", "good"], ["M2", "error"], ["M3", "empty"], ["M4", "challenge"], ["M5", "reshaped"], ...Array.from({ length: 6 }, (_, i) => [`N${i}`, "error"])], {}, (r) => {
    assert.deepEqual([r.ok, r.empty, r.fail, r.skipped, r.code, r.files], [2, 1, 8, 0, 0, ["M1.json", "M4.json"]]);
  }],
];

let pass = 0, failN = 0;
const t0 = Date.now();
for (const [name, plan, env, check] of CASES) {
  const res = {};
  for (const v of Object.keys(ROOTS)) {
    try { res[v] = run(v, plan, env); check(res[v], v); console.log(`  PASS [${v}] ${name}  (${res[v].ok}w/${res[v].empty}e/${res[v].fail}f/${res[v].skipped}s exit ${res[v].code})`); pass++; }
    catch (e) { console.log(`  FAIL [${v}] ${name}: ${e.message.split("\n").slice(0, 4).join(" | ")}`); failN++; }
  }
  if (res.new && res.old) { // no regression in strictness: same outcome counts + exit code as the HTML scraper
    const k = (r) => `${r.ok}/${r.empty}/${r.fail}/${r.skipped}/exit${r.code}`;
    if (k(res.new) === k(res.old)) pass++; else { failN++; console.log(`  DEGRADED ${name}: new ${k(res.new)} vs old ${k(res.old)}`); }
  }
}
// Behaviour note (not a failure): payload.json carrying stocks_extra but NOT this ticker -> "empty"
// (old HTML: no section -> "failed"). Reported so the looser classification is visible.
const note = run("new", [["ABS", "absent"]], { ONLY: "ABS" });
console.log(`  NOTE [new] stocks_extra without this ticker -> ${note.empty ? "empty (old HTML: no section -> failed)" : note.fail ? "failed" : "written?!"}`);
rmSync(TMP, { recursive: true, force: true });
console.log(`\nbullbear failure modes: ${pass} passed, ${failN} failed (${Object.keys(ROOTS).join("+")} versions, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(failN ? 1 : 0);
