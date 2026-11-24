// E2E: the bulls/bears payload.json path THROUGH FLARESOLVERR (what CI hits when GitHub runner IPs
// draw a Cloudflare challenge). FlareSolverr returns the JSON inside <pre> with HTML entities.
// Checks, per ticker: extractJson+parseBullBearPayload(FlareSolverr body) deep-equals the plain-fetch
// parse; special chars (’ & < > " ') survive; then runs ci/scrape-bullbear.mjs with plain fetch to
// the provider forced to fail (so every ticker goes via FlareSolverr) and compares the files it writes.
//
// Run: node ci/e2e/bullbear-flaresolverr.mjs
//   FLARESOLVERR_URL=http://host:port/v1  use that instance; else start ghcr.io/flaresolverr/flaresolverr
//                                         (image must already be present: --pull=never) and remove it after
//   CACHE_DIR=<dir>   plain bodies at <dir>/<T>.json, FlareSolverr bodies at <dir>/flaresolverr/<T>.html;
//                     when both are cached the comparison runs offline (the scraper step still needs FlareSolverr)
//   TICKERS=AAPL,...  default AAPL,MSFT,NVDA,KO,DELL (must be in src/data/stocks.json: the scraper only takes those)
// Exit 1 on any degradation. Provider requests: <= 2 per uncached ticker + 1 per ticker for the scraper, 1.5s apart.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { extractJson, parseBullBearPayload } from "../bullbear-payload.mjs";
import { BROWSER_UA } from "../../worker/cnbc.js";
import { SRC_BASE, srcUrl } from "../source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TICKERS = (process.env.TICKERS || "AAPL,MSFT,NVDA,KO,DELL").split(",");
const CACHE = process.env.CACHE_DIR || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (t) => srcUrl("analysis", t);
let lastHit = 0;
const polite = async () => { const w = lastHit + 1500 - Date.now(); if (w > 0) await sleep(w); lastHit = Date.now(); };
const cached = (p) => (CACHE && existsSync(p) ? readFileSync(p, "utf8") : null);
const save = (p, s) => { if (CACHE) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); } };

// ---------- FlareSolverr: given, or a throwaway container ----------
let FS = process.env.FLARESOLVERR_URL || "";
let container = "";
async function startFlare() {
  try { execFileSync("docker", ["info"], { stdio: "ignore" }); } catch { return false; }
  const port = await new Promise((r) => { const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  container = `bb-e2e-flaresolverr-${process.pid}`;
  execFileSync("docker", ["run", "-d", "--rm", "--pull=never", "--name", container, "-p", `127.0.0.1:${port}:8191`,
    "ghcr.io/flaresolverr/flaresolverr:latest"], { stdio: "ignore" });
  FS = `http://127.0.0.1:${port}/v1`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(FS.replace(/\/v1$/, "/"))).ok) return true; } catch { /* booting */ } await sleep(1000); }
  throw new Error("FlareSolverr did not come up in 60s");
}
const stopFlare = () => { if (container) try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch { /* gone */ } };
async function flareGet(u) {
  await polite();
  const r = await fetch(FS, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url: u, maxTimeout: 60000 }), signal: AbortSignal.timeout(90_000) });
  const j = await r.json();
  assert.equal(j.status, "ok", `FlareSolverr: ${j.message}`);
  return j.solution.response;
}
async function plainGet(u) {
  await polite();
  const r = await fetch(u, { headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(30_000) });
  const b = await r.text();
  assert.equal(r.status, 200, `plain fetch ${r.status}`);
  return b;
}

const fails = [];
const check = (name, fn) => { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fails.push(name); console.log(`  FAIL ${name}: ${e.message.split("\n")[0]}`); } };
const SPECIAL = /[’‘“”&<>"']/g;
const specials = (bb) => [...JSON.stringify([...bb.bull, ...bb.bear].flatMap((x) => [x.t, x.b])).slice(1, -1)
  .replace(/\\"/g, '"').matchAll(SPECIAL)].map((m) => m[0]);

try {
  const need = TICKERS.some((t) => !cached(join(CACHE, "flaresolverr", `${t}.html`)));
  if (!FS && !(await startFlare())) {
    console.log("SKIP: docker not running and FLARESOLVERR_URL not set — FlareSolverr path not exercised");
    process.exit(need ? 2 : 0);
  }
  console.log(`FlareSolverr: ${FS}${container ? ` (container ${container})` : ""}`);

  // ---------- 1. FlareSolverr body vs plain body, same ticker, same moment ----------
  const plainParse = {};
  const seen = new Set(), ents = new Set(), nbspTickers = [];
  for (const t of TICKERS) {
    console.log(`${t}:`);
    const fp = join(CACHE, "flaresolverr", `${t}.html`), pp = join(CACHE, `${t}.json`);
    let fbody = cached(fp), pbody = fbody && cached(pp);
    if (!fbody || !pbody) { // fetch the pair back to back so both see the same thesis
      fbody = await flareGet(url(t)); save(fp, fbody);
      pbody = await plainGet(url(t)); save(pp, pbody);
    }
    let fjson, bbF, bbP;
    check("FlareSolverr body is the <pre>-wrapped, entity-encoded form", () => {
      assert.throws(() => JSON.parse(fbody), "body parsed as raw JSON — the <pre> path was not exercised");
      assert.match(fbody, /<pre[^>]*>/i);
      assert.match(fbody, /&(amp|lt|gt|quot|#39);/, "no HTML entity at all in the body");
    });
    for (const e of fbody.match(/&[#a-z0-9]+;/gi) || []) ents.add(e);
    // the whole payload is the real entity test (& < > ’ " nbsp all occur in it)
    // stocks_extra (thesis + riskFactors, where nbsp lives) only: the rest drifts between the two fetches
    check("extractJson(FlareSolverr) deep-equals JSON.parse(plain), models.stocks_extra", () => {
      fjson = extractJson(fbody);
      assert.deepEqual(fjson.models.stocks_extra, JSON.parse(pbody).models.stocks_extra);
    });
    if (/&nbsp;/.test(fbody)) nbspTickers.push(t);
    check("parseBullBearPayload(FlareSolverr) deep-equals plain parse, non-empty", () => {
      bbF = parseBullBearPayload(fjson ?? extractJson(fbody), t);
      bbP = plainParse[t] = parseBullBearPayload(JSON.parse(pbody), t);
      assert.ok(bbP.bull.length && bbP.bear.length, `plain parse ${bbP.bull.length}↑ ${bbP.bear.length}↓`);
      assert.deepEqual(bbF, bbP);
    });
    check("no entity left undecoded in bulls/bears text", () => {
      for (const x of [...(bbF?.bull || []), ...(bbF?.bear || [])]) assert.doesNotMatch(x.t + x.b, /&(#\d+|#x[0-9a-f]+|[a-z]+);/i, x.t);
    });
    if (bbP) for (const c of specials(bbP)) seen.add(c);
    console.log(`  ${bbP?.bull.length ?? "?"}↑ ${bbP?.bear.length ?? "?"}↓, special chars in thesis: ${[...new Set(bbP ? specials(bbP) : [])].join(" ") || "none"}`);
  }
  // the deep-equal above is only as strong as the characters it saw: insist the risky ones occurred
  check(`entity coverage: ’ in a thesis, &amp; &lt; &gt; in the payloads (seen ${[...ents].join(" ")})`, () => {
    assert.ok(seen.has("’"), "no ’ in any thesis — pick other TICKERS");
    for (const e of ["&amp;", "&lt;", "&gt;"]) assert.ok(ents.has(e), `${e} never occurred — the deep-equal did not exercise it`);
  });
  // U+00A0 comes back from FlareSolverr as &nbsp; and extractJson does not decode it (the removed
  // ci/bullbear-html.mjs did). Real payloads carry it (riskFactors), so a thesis can too:
  console.log(`  (&nbsp; present in FlareSolverr bodies of: ${nbspTickers.join(",") || "none"})`);
  check("extractJson decodes &nbsp; -> U+00A0 (old HTML parser decoded it; a thesis with one would ship a literal '&nbsp;')", () => {
    const kp = { sentiment: "bullish", title: "Q3\u00a0beat & <guide> “raised”", description: "Apple’s \"Dec\u00a031\" 'deal'" };
    const raw = JSON.stringify({ models: { stocks_extra: [{ _id: "ZZZ", aiAnalysis: { keyPoints: [kp] } }] } });
    const wrapped = `<html><body><pre>${raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\u00a0/g, "&nbsp;")}</pre></body></html>`;
    assert.deepEqual(parseBullBearPayload(extractJson(wrapped), "ZZZ"), parseBullBearPayload(JSON.parse(raw), "ZZZ"));
  });

  // ---------- 2. the real scraper, plain fetch forced to fail -> every ticker via FlareSolverr ----------
  console.log(`scrape-bullbear.mjs, ONLY=${TICKERS.join(",")}, plain fetch to the provider rejected:`);
  const work = mkdtempSync(join(tmpdir(), "bb-e2e-"));
  try {
    mkdirSync(join(work, "src/data"), { recursive: true });
    cpSync(join(ROOT, "src/data/stocks.json"), join(work, "src/data/stocks.json"));
    const pre = join(work, "no-plain.mjs");
    writeFileSync(pre, `const f = globalThis.fetch; globalThis.__plainBlocked = 0;
globalThis.fetch = (u, o) => String(u?.url ?? u).startsWith(${JSON.stringify(SRC_BASE)}) ? (globalThis.__plainBlocked++, Promise.reject(new TypeError("e2e: plain fetch blocked"))) : f(u, o);
process.on("exit", () => console.log("PLAIN_BLOCKED=" + globalThis.__plainBlocked));`);
    const run = spawnSync(process.execPath, ["--import", `file://${pre}`, join(ROOT, "ci/scrape-bullbear.mjs")], {
      cwd: work, encoding: "utf8", timeout: 15 * 60_000,
      env: { ...process.env, ONLY: TICKERS.join(","), FLARESOLVERR_URL: FS, RUNNER_TEMP: "" },
    });
    console.log((run.stdout + run.stderr).trim().split("\n").map((l) => `  | ${l}`).join("\n"));
    check("scraper exit 0", () => assert.equal(run.status, 0));
    check(`plain fetch was attempted and blocked for every ticker`, () =>
      assert.equal(Number(/PLAIN_BLOCKED=(\d+)/.exec(run.stdout)?.[1]), TICKERS.length));
    check(`scraper reports ${TICKERS.length} written, 0 failed`, () =>
      assert.match(run.stdout, new RegExp(`done: ${TICKERS.length} written, 0 empty, 0 failed, 0 skipped`)));
    for (const t of TICKERS) check(`${t}: written file == plain parse (+asOf)`, () => {
      const f = JSON.parse(readFileSync(join(work, "public/bullbear", `${t}.json`), "utf8"));
      assert.match(f.asOf, /^\d{4}-\d\d-\d\d$/);
      const { asOf, ...bb } = f;
      // a cached plain body may predate this fetch; the thesis is regenerated rarely, so equality is expected
      assert.deepEqual(bb, plainParse[t]);
    });
  } finally { rmSync(work, { recursive: true, force: true }); }
} finally { stopFlare(); }

console.log(fails.length ? `\nRESULT: FAIL — ${fails.length} check(s): ${fails.join("; ")}` : `\nRESULT: PASS — ${TICKERS.length} tickers via FlareSolverr, no degradation`);
process.exit(fails.length ? 1 : 0);
