// E2E (local only, not in npm test): the app's Upside / Risks panel renders files from the NEW
// payload.json scraper exactly as well as the committed OLD-parser (HTML page) files.
//
//   node ci/e2e/bullbear-ui.mjs [AAPL,ONDS,TRNR,XELB]   (TRNR, XELB: micro-caps)
//   env: CACHE_DIR  raw analysis payloads, <T>.json (missing ones are fetched, >=1.5s apart, and saved)
//        OLD_REF    git ref holding the old-parser files (default HEAD)
//        PORT (4179)  SHOTS (screenshot dir, default $TMPDIR)  BUILD=0 reuse dist/
//
// 1. Runs the real ci/scrape-bullbear.mjs (ONLY=...) in a temp cwd, with fetch served from CACHE_DIR —
//    so public/ is never touched and nothing but missing cache entries hits the network.
// 2. vite preview of dist/; Playwright serves /bullbear/<T>.json as the OLD or the NEW file, opens #<T>.
// 3. Per variant: rendered bull/bear counts, titles and bodies === the file, no raw markup/entities,
//    "· updated <asOf>" label. Old vs new: count + panel-height parity; title diffs classed as
//    case-only (cosmetic) or content (the provider regenerated the thesis — data freshness, not render).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { extractJson } from "../bullbear-payload.mjs";
import { srcUrl } from "../source.mjs";
import { BROWSER_UA } from "../../worker/cnbc.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TICKERS = (process.argv[2] || "AAPL,ONDS,TRNR,XELB").split(",").map((t) => t.trim().toUpperCase());
const CACHE = process.env.CACHE_DIR || join(tmpdir(), "outlook-cache");
const OLD_REF = process.env.OLD_REF || "HEAD";
const PORT = Number(process.env.PORT || 4179);
const SHOTS = process.env.SHOTS || tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (t) => srcUrl("analysis", t);
// srcUrl("analysis", t) as a regex source with the ticker captured, for fetch mocks in child processes.
const [PAY_PRE, PAY_POST] = srcUrl("analysis", "\u0000").split("%00");
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PAYLOAD_RE = `${reEsc(PAY_PRE)}([^/?]+)${reEsc(PAY_POST)}`;
let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); };

// ---- 1. payload cache (polite) + the real scraper on it ------------------------------------------
mkdirSync(CACHE, { recursive: true });
let fetched = 0;
for (const t of TICKERS) {
  const f = join(CACHE, `${t}.json`);
  if (existsSync(f)) continue;
  if (fetched++) await sleep(1500);
  const body = await (await fetch(url(t), { headers: { "user-agent": BROWSER_UA } })).text();
  extractJson(body); // throws on a challenge page: never cache one
  writeFileSync(f, body);
}
const work = mkdtempSync(join(tmpdir(), "bb-e2e-"));
mkdirSync(join(work, "src/data"), { recursive: true });
mkdirSync(join(work, "public/bullbear"), { recursive: true });
cpSync(join(ROOT, "src/data/stocks.json"), join(work, "src/data/stocks.json"));
const shim = `const C=process.env.BB_CACHE,f=globalThis.fetch;globalThis.fetch=async(u,o)=>{const m=String(u).match(${new RegExp(PAYLOAD_RE)});if(m){const {readFileSync}=await import("node:fs");return new Response(readFileSync(C+"/"+decodeURIComponent(m[1]).toUpperCase()+".json","utf8"),{status:200});}throw new Error("e2e: no network for "+u);};`;
const scr = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(shim)}`, join(ROOT, "ci/scrape-bullbear.mjs")], {
  cwd: work, encoding: "utf8",
  env: { ...process.env, ONLY: TICKERS.join(","), FLARESOLVERR_URL: "http://localhost:1/v1", BB_CACHE: CACHE },
});
console.log(scr.stdout.trim());
const data = {};
for (const t of TICKERS) {
  const nf = join(work, "public/bullbear", `${t}.json`);
  let old = null;
  try { old = JSON.parse(execFileSync("git", ["show", `${OLD_REF}:public/bullbear/${t}.json`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { /* none committed */ }
  data[t] = { old, new: existsSync(nf) ? JSON.parse(readFileSync(nf, "utf8")) : null };
  // no file = the payload has no thesis for it; prod keeps the old file (stale), so not a render case
  if (!data[t].new) console.log(`note ${t}: new scraper found no thesis (old file ${data[t].old?.asOf ?? "none"} would be kept)`);
}

// ---- 2. build + preview ----------------------------------------------------------------------
if (process.env.BUILD !== "0" || !existsSync(join(ROOT, "dist/index.html")))
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });
const srv = spawn(join(ROOT, "node_modules/.bin/vite"), ["preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore", detached: true });
const kill = () => { try { process.kill(-srv.pid); } catch { /* gone */ } };
process.on("exit", kill);
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break; } catch { /* not up */ } await sleep(250); }

// ---- 3. render each variant -----------------------------------------------------------------
const RAW = /<\/?[a-z][^>]*>|&(#\d+|#x[0-9a-f]+|[a-z]{2,8});|\\u[0-9a-f]{4}|\\n/i;
const browser = await chromium.launch();
async function render(t, variant, file) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  // only this ticker's bullbear file is swapped; everything else is the built app as-is
  await page.route(`**/bullbear/${t}.json`, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(file) }));
  await page.goto(`http://localhost:${PORT}/#${t}`);
  // the swipe stage renders neighbour cards too: scope to the slide whose title is this ticker
  const panel = page.locator(".mkm-modal").filter({ has: page.locator("#mkm-sym").getByText(t, { exact: true }) }).locator(".mkm-bb");
  await panel.waitFor({ timeout: 20000 });
  await panel.locator(".mkm-bbpt, .mkm-bbna").first().waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Got it" }).click({ timeout: 4000 }).catch(() => {}); // first-visit swipe hint dims the modal
  await page.waitForTimeout(800); // let the animations settle before screenshots
  const out = { hdr: (await panel.locator(".mkm-bbhdr").innerText()).trim(), na: await panel.locator(".mkm-bbna").count(), errs };
  for (const side of ["bull", "bear"]) {
    await panel.locator(".mkm-bbtabs button", { hasText: side === "bull" ? "Upside" : "Risks" }).dispatchEvent("click"); // no hit-test: the open animation's scrim
    await panel.locator(`.mkm-bbtabs button.on.${side}`).waitFor();
    const pts = panel.locator(".mkm-bblist .mkm-bbpt");
    out[side] = { t: await pts.locator(".t").allInnerTexts(), b: await pts.locator(".b").allTextContents() };
    out[side + "H"] = Math.round((await panel.boundingBox()).height);
    await panel.screenshot({ path: join(SHOTS, `bb-${t}-${variant}-${side}.png`) });
  }
  await ctx.close();
  return out;
}

for (const t of TICKERS) {
  const r = {};
  for (const v of ["old", "new"]) {
    const f = data[t][v];
    if (!f) { console.log(`skip ${t} ${v}: no file`); continue; }
    const g = (r[v] = await render(t, v, f));
    const tag = `${t} ${v}`;
    check(g.na === 0, `${tag}: panel shows points (not "not available")`);
    check(g.errs.length === 0, `${tag}: no page errors ${g.errs.join(" | ")}`);
    check(g.hdr.includes(`· updated ${f.asOf}`), `${tag}: asOf label "${f.asOf}"`);
    for (const s of ["bull", "bear"]) {
      check(g[s].t.length === f[s].length, `${tag}: ${s} count ${g[s].t.length}/${f[s].length}`);
      check(g[s].t.every((x, i) => x.trim() === f[s][i].t) && g[s].b.every((x, i) => x.trim() === f[s][i].b), `${tag}: ${s} titles+bodies render verbatim`);
      const bad = [...g[s].t, ...g[s].b].filter((x) => !x.trim() || RAW.test(x));
      check(bad.length === 0, `${tag}: ${s} no empty/raw-markup text${bad.length ? " -> " + JSON.stringify(bad[0]).slice(0, 120) : ""}`);
    }
  }
  if (r.old && r.new) {
    for (const s of ["bull", "bear"]) {
      check(r.new[s].t.length === r.old[s].t.length, `${t} parity: ${s} count old ${r.old[s].t.length} = new ${r.new[s].t.length}`);
      const ot = r.old[s].t, nt = r.new[s].t;
      const same = nt.filter((x, i) => x === ot[i]).length;
      const caseOnly = nt.filter((x, i) => x !== ot[i] && x.toLowerCase() === ot[i]?.toLowerCase()).length;
      console.log(`info ${t} ${s} titles: ${same} identical, ${caseOnly} case-only (cosmetic), ${nt.length - same - caseOnly} different content; panel height old ${r.old[s + "H"]}px new ${r.new[s + "H"]}px`);
      for (let i = 0; i < Math.max(ot.length, nt.length); i++) if (ot[i] !== nt[i]) console.log(`       ${JSON.stringify(ot[i])} -> ${JSON.stringify(nt[i])}`);
    }
  }
}
await browser.close();
kill();
console.log(`\n${failed ? `FAIL: ${failed} check(s)` : "PASS"} — screenshots: ${SHOTS}/bb-<T>-<old|new>-<bull|bear>.png`);
process.exit(failed ? 1 : 0);
