// E2E smoke test: builds the app (if stale), serves it with `vite preview` on :4303, drives it in
// headless Chromium and asserts the main flows. Plain Node + node:assert + the `playwright` library
// (no test runner). Live-price / third-party hosts are blocked, so it runs offline and deterministically.
//
//   npm run e2e                     # build if needed, serve, test, stop
//   E2E_URL=http://localhost:5173 node e2e/smoke.mjs   # test an already-running server instead
//
// Not named ci/test-*.mjs on purpose: it needs a browser, so it stays out of `npm test`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4303;
// Own build dir (gitignored via node_modules/) so a parallel `npm run build` into dist/ can't race us.
const OUT = path.join(ROOT, "node_modules/.cache/mp-e2e-dist");
const BASE = process.env.E2E_URL || `http://localhost:${PORT}`;
const ORIGIN = new URL(BASE).origin;

// ---- fixtures picked from the committed data ---------------------------------------------------
const STOCKS = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/stocks.json"), "utf8"));
const has = (dir, t) => fs.existsSync(path.join(ROOT, "public", dir, `${t}.json`));
const RICH = STOCKS.find(
  (s) => s.ss != null && s.ai != null && s.air && has("bullbear", s.t) && has("forecasts", s.t),
);
assert.ok(RICH, "no ticker in stocks.json has Pulse Score + AI + bullbear + forecasts data");
const inSet = new Set(STOCKS.map((s) => s.t));
// desc.json is only read for off-universe tickers (every ranked row carries its own desc)
const DESC = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, "public/desc.json"), "utf8")));
const OFF = DESC.find((t) => !inSet.has(t) && /^[A-Z]{1,5}$/.test(t));
assert.ok(OFF, "desc.json has no off-universe ticker to exercise its lazy fetch");
const WL = STOCKS.find((s) => s.t !== RICH.t && s.con === "StrongBuy").t; // visible under the default filter

// ---- build + serve -----------------------------------------------------------------------------
function newestMtime(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = 0;
  for (const e of fs.readdirSync(p)) m = Math.max(m, newestMtime(path.join(p, e)));
  return m;
}
function buildIfNeeded() {
  const idx = path.join(OUT, "index.html");
  const srcM = Math.max(...["src", "public", "index.html", "vite.config.ts", "package.json"].map((f) => newestMtime(path.join(ROOT, f))));
  if (fs.existsSync(idx) && fs.statSync(idx).mtimeMs > srcM) return console.log("build: up to date");
  console.log("build: vite build ->", path.relative(ROOT, OUT));
  const r = spawnSync("npx", ["vite", "build", "--outDir", OUT, "--emptyOutDir", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error("vite build failed");
}
async function waitUp(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not come up`);
}

let server = null;
if (!process.env.E2E_URL) {
  buildIfNeeded();
  server = spawn("npx", ["vite", "preview", "--outDir", OUT, "--port", String(PORT), "--strictPort", "--host", "localhost"], {
    cwd: ROOT, stdio: "ignore", detached: true,
  });
  process.on("exit", () => stopServer());
  await waitUp(BASE);
}
function stopServer() {
  if (server && server.exitCode == null) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
  }
}

// ---- tiny runner -------------------------------------------------------------------------------
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok   ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`  FAIL ${name}\n       ${String(e.message || e).split("\n").join("\n       ")}`);
  }
}

// ---- browser -----------------------------------------------------------------------------------
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
// DEV_AUTH (localhost): signed in as the fake dev user, watchlist in localStorage
await context.addInitScript(() => {
  if (!sessionStorage.getItem("e2e_init")) {
    sessionStorage.setItem("e2e_init", "1");
    localStorage.clear();
    localStorage.setItem("mp_dev_signedin", "1");
  }
});

// Live prices + every other third-party host are blocked. The named live hosts are listed so the
// intent is explicit; everything off-origin is aborted the same way.
const LIVE = /workers\.dev|cnbc\.com|finnhub\.io|twelvedata\.com|financialmodelingprep\.com/;
const blocked = { live: 0, other: 0 };
await context.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN) || u.startsWith("data:") || u.startsWith("blob:")) return route.continue();
  if (LIVE.test(u)) blocked.live++;
  else blocked.other++;
  return route.abort("blockedbyclient");
});
await context.routeWebSocket(/.*/, (ws) => ws.close()); // Finnhub relay WS etc.

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const loc = m.location()?.url || "";
  // Fallout of our own blocking (failed off-origin loads / CORS) is expected, not an app error.
  if (loc && !loc.startsWith(ORIGIN)) return;
  if (/ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(m.text())) return;
  // The PROD build starts Firebase Analytics, whose SDK console.errors its blocked config fetch.
  // Every off-origin request is aborted above, so a fetch TypeError can only be that fallout.
  if (/^TypeError: Failed to fetch/.test(m.text())) return;
  consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
const badResponses = [];
const okFetches = new Map(); // pathname -> status, same-origin only
page.on("response", (r) => {
  const u = r.url();
  if (!u.startsWith(ORIGIN)) return;
  const p = new URL(u).pathname;
  okFetches.set(p, r.status());
  if (r.status() >= 400) badResponses.push(`${r.status()} ${p}`);
});
const waitFetch = (p) => {
  const w = page.waitForResponse((r) => new URL(r.url()).pathname === p, { timeout: 10000 });
  w.catch(() => {}); // a step that fails first must not leave an unhandled rejection behind
  return w;
};

const bodyRows = () => page.locator("tbody#body tr.row-open");
const firstTickers = async (n = 5) => (await page.locator("tbody#body tr.row-open .sym").allTextContents()).slice(0, n);
const nav = (label) => page.locator("nav.nav-bottom button.nav-tab", { hasText: label }).click();
async function openFilters() {
  const d = page.locator("details.filters");
  if (!(await d.evaluate((el) => el.open))) await d.locator("summary .filters-title").click();
}
async function closeModal() {
  const modal = page.locator(".mkm-modal");
  for (let i = 0; i < 3 && (await modal.count()); i++) {
    await page.keyboard.press("Escape");
    await modal.first().waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
  }
  assert.equal(await modal.count(), 0, "stock modal did not close on Escape");
}

let exitCode = 1;
try {
  console.log(`e2e smoke @ ${BASE}  (rich=${RICH.t}, off-universe=${OFF}, watch=${WL})`);
  await page.goto(BASE + "/", { waitUntil: "load" });

  await step("page loads, header + table render", async () => {
    await page.locator("h1#title").waitFor();
    await bodyRows().first().waitFor({ timeout: 15000 });
    assert.match(await page.title(), /Market Pulse/);
  });

  await step("lazy chunks prefetch on idle, before any modal opens", async () => {
    await page.waitForResponse((r) => /\/assets\/StockModal-[\w-]+\.js$/.test(r.url()), { timeout: 10000 });
    await page.waitForResponse((r) => /\/assets\/SignInModal-[\w-]+\.js$/.test(r.url()), { timeout: 10000 }).catch(() => {});
    assert.equal(await page.locator(".mkm-modal").count(), 0, "a modal was open; prefetch not proven");
  });

  await step("table pool ~= stocks.json row count", async () => {
    const poolN = Number(await page.locator("#poolN").textContent());
    assert.ok(Math.abs(poolN - STOCKS.length) <= 5, `poolN ${poolN} vs stocks.json ${STOCKS.length}`);
    // default view is filtered to Strong Buy; rows rendered == the "matches" counter
    const cnt = Number(await page.locator("#cnt").textContent());
    assert.equal(await bodyRows().count(), cnt);
    const strong = STOCKS.filter((s) => s.con === "StrongBuy").length;
    assert.ok(Math.abs(cnt - strong) <= 5, `Strong Buy rows ${cnt} vs stocks.json ${strong}`);
  });

  await step("clearing the rating filter shows ~all stocks.json rows", async () => {
    await openFilters();
    await page.locator("#consensus").click();
    await page.locator(".ms-menu .ms-clear").click();
    await page.keyboard.press("Escape");
    const n = await bodyRows().count();
    assert.ok(Math.abs(n - STOCKS.length) <= 5, `rendered ${n} vs stocks.json ${STOCKS.length}`);
  });

  await step("sort by a column changes row order", async () => {
    const before = await firstTickers();
    await page.locator('th[data-k="mc"]').click();
    await page.locator('th[data-k="mc"].sorted').waitFor();
    const after = await firstTickers();
    assert.notDeepEqual(after, before, "top rows unchanged after sorting by market cap");
    const top = STOCKS.filter((s) => s.mc != null).sort((a, b) => b.mc - a.mc)[0].t;
    assert.equal(after[0], top, "largest market cap should lead a desc mc sort");
    await page.locator('th[data-k="mc"]').click(); // toggle -> ascending
    assert.notEqual((await firstTickers())[0], top, "second click did not flip the sort");
  });

  await step("min-cap filter reduces rows, reset restores", async () => {
    const all = await bodyRows().count();
    await page.locator('#cap button[data-c="10000"]').click();
    const big = await bodyRows().count();
    const expected = STOCKS.filter((s) => (s.mc ?? 0) >= 10000).length;
    assert.ok(big < all, `cap filter did not reduce rows (${big} vs ${all})`);
    assert.ok(Math.abs(big - expected) <= 5, `$10B rows ${big} vs data ${expected}`);
    await page.locator("button.filter-reset").click();
    // reset goes back to the view default (Strong Buy)
    assert.equal(await bodyRows().count(), Number(await page.locator("#cnt").textContent()));
  });

  await step("AI Outlook view tab renders and re-sorts", async () => {
    await page.locator('.tab[data-v="ai"]', { hasText: "AI Outlook" }).click();
    await page.locator('th[data-k="ai"].sorted').waitFor();
    assert.ok((await bodyRows().count()) > 0);
    await page.locator('.tab[data-v="analyst"]').click();
  });

  await step("search finds a ticker and opens its modal", async () => {
    await page.locator("button.search-ico").click();
    await page.locator('input[aria-label="Search ticker or company"]').fill(RICH.t);
    const hit = page.locator(".search-res", { has: page.locator(".search-tk", { hasText: new RegExp(`^${RICH.t}$`) }) }).first();
    await hit.waitFor();
    const fc = waitFetch(`/forecasts/${RICH.t}.json`);
    const bb = waitFetch(`/bullbear/${RICH.t}.json`);
    await hit.click();
    await page.locator(".mkm-modal #mkm-sym", { hasText: RICH.t }).first().waitFor();
    assert.equal((await fc).status(), 200, "forecasts fetch");
    assert.equal((await bb).status(), 200, "bullbear fetch");
  });

  await step("StockModal shows Pulse Score, AI rating and Upside/Risks", async () => {
    const m = page.locator(".mkm-modal").first();
    const cell = (k) => m.locator(".mkm-cell", { has: page.locator(".k", { hasText: new RegExp(`^${k}$`) }) }).first();
    assert.match(await cell("Pulse Score").locator(".v").innerText(), new RegExp(`^${RICH.ss}\\s*/10`));
    assert.match(await cell("AI Score").locator(".v").innerText(), new RegExp(`^${RICH.ai}\\s*/100`));
    assert.equal((await cell("AI Rating").locator(".v").innerText()).trim(), RICH.air);
    const bb = m.locator(".mkm-bb");
    assert.match(await bb.locator(".mkm-bbhdr").textContent(), /Upside, Risks/); // innerText is CSS-uppercased
    await bb.locator(".mkm-bbtabs button", { hasText: "Upside" }).waitFor();
    assert.ok((await bb.locator(".mkm-bbpt").count()) > 0, "no Upside points listed");
    await bb.locator(".mkm-bbtabs button", { hasText: "Risks" }).click();
    assert.ok((await bb.locator(".mkm-bbpt .t.bear").count()) > 0, "no Risks points listed");
  });

  await step("off-universe ticker lazy-loads desc.json", async () => {
    await closeModal();
    await page.locator("button.search-ico").click();
    await page.locator('input[aria-label="Search ticker or company"]').fill(OFF);
    const desc = waitFetch("/desc.json");
    await page.locator(".search-res.off", { has: page.locator(".search-tk", { hasText: OFF }) }).first().click();
    await page.locator(".mkm-modal #mkm-sym", { hasText: OFF }).first().waitFor();
    assert.equal((await desc).status(), 200, "desc.json fetch");
    await closeModal();
  });

  await step("Best of the Best renders", async () => {
    await closeModal();
    await nav("Best");
    await page.locator(".bob-title", { hasText: "Best" }).waitFor();
    const cards = await page.locator(".bob-grid .bob-tk").count();
    const empties = await page.locator(".bob-empty").count();
    assert.ok(cards + empties >= 2, "neither cards nor empty states in Best");
    assert.match(await page.locator(".bob-dek").innerText(), /Pulse Score 10 · AI Outlook/);
  });

  await step("New Arrivals renders and fetches reviews-recent.json", async () => {
    await closeModal();
    const rv = okFetches.has("/reviews-recent.json") ? null : waitFetch("/reviews-recent.json");
    await nav("New");
    await page.locator(".bob-title", { hasText: "Arrivals" }).waitFor();
    if (rv) await rv;
    assert.equal(okFetches.get("/reviews-recent.json"), 200, "reviews-recent.json fetch");
    assert.ok((await page.locator(".na-table tbody tr").count()) + (await page.locator(".bob-empty").count()) > 0);
  });

  await step("watchlist: add from table, shows in Watchlist, remove", async () => {
    await closeModal();
    await nav("Watchlist");
    await page.locator(".bob-title", { hasText: "list" }).waitFor();
    assert.match(await page.locator(".wl-sync").innerText(), /Synced as/, "DEV_AUTH user not signed in");
    await page.locator(".bob-empty", { hasText: "No tracked stocks" }).waitFor();

    await nav("Stocks");
    await page.locator(`button.wl-star[aria-label="Add ${WL} to watchlist"]`).click();
    await page.locator(`button.wl-star.on[aria-label="Remove ${WL} from watchlist"]`).waitFor();
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("mp_watchlist"))), [WL]);

    await nav("Watchlist");
    await page.locator(".wl-table tbody tr", { hasText: WL }).waitFor();
    assert.equal(await page.locator(".wl-table tbody tr").count(), 1);
    assert.match(await page.locator(".bob-eyebrow").textContent(), /Tracking · 1/);

    await page.locator(".wl-table tbody tr", { hasText: WL }).locator(`button[aria-label="Remove ${WL} from watchlist"]`).click();
    await page.locator(".bob-empty", { hasText: "No tracked stocks" }).waitFor();
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("mp_watchlist"))), []);
  });

  await step("after a deploy deletes the chunk, a modal still opens with no reload", async () => {
    await closeModal();
    await nav("Stocks");
    let navs = 0;
    const onNav = (f) => f === page.mainFrame() && navs++;
    page.on("framenavigated", onNav);
    // the deploy: every hashed StockModal chunk now 404s, as on Firebase after a release
    const gone = (route) => route.fulfill({ status: 404, body: "" });
    await page.route(/\/assets\/StockModal-[\w-]+\.js$/, gone);
    try {
      await bodyRows().first().click();
      await page.locator(".mkm-modal #mkm-sym").first().waitFor({ timeout: 5000 });
      assert.equal(navs, 0, "page reloaded on open");
    } finally {
      await page.unroute(/\/assets\/StockModal-[\w-]+\.js$/, gone);
      page.off("framenavigated", onNav);
    }
    await closeModal();
  });

  // Fresh pages for the reload paths, so their navigations/errors don't touch the main page.
  async function freshPage() {
    const p = await context.newPage();
    const navs = [];
    p.on("framenavigated", (f) => f === p.mainFrame() && navs.push(f.url()));
    await p.goto(BASE + "/", { waitUntil: "load" });
    await p.locator("tbody#body tr.row-open").first().waitFor({ timeout: 15000 });
    return { p, navs };
  }
  const hide = (p) =>
    p.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });

  await step("version.json is served and matches the build", async () => {
    const { p } = await freshPage();
    try {
      const r = await p.request.get(BASE + "/version.json");
      assert.equal(r.status(), 200);
      const { id } = await r.json();
      assert.match(id, /^\d{13}$/);
      const js = await p.evaluate(() => [...document.scripts].map((s) => s.src).find((u) => /\/assets\/index-/.test(u)));
      assert.ok((await (await p.request.get(js)).text()).includes(JSON.stringify(id)), "build id not baked into the entry chunk");
    } finally { await p.close(); }
  });

  await step("same version: hiding the tab does not reload", async () => {
    const { p, navs } = await freshPage();
    try {
      const v = p.waitForResponse((r) => r.url().endsWith("/version.json"));
      await hide(p);
      await v;
      await p.waitForTimeout(1000);
      assert.equal(navs.length, 1, `reloaded: ${navs.length - 1}x`);
    } finally { await p.close(); }
  });

  await step("new deploy + tab hidden -> reloads once, keeping the open stock", async () => {
    const { p, navs } = await freshPage();
    try {
      await p.goto(BASE + "/#" + RICH.t, { waitUntil: "load" });
      await p.locator(".mkm-modal #mkm-sym", { hasText: RICH.t }).first().waitFor({ timeout: 15000 });
      await p.route("**/version.json", (r) => r.fulfill({ json: { id: "9999999999999" } }));
      const n0 = navs.length;
      const reload = p.waitForEvent("load", { timeout: 10000 });
      await hide(p);
      await reload;
      assert.equal(navs.length, n0 + 1, "expected exactly one reload");
      await p.locator(".mkm-modal #mkm-sym", { hasText: RICH.t }).first().waitFor({ timeout: 15000 });
    } finally { await p.close(); }
  });

  await step("prefetch hits a deleted chunk (online) -> reloads once, then modal opens", async () => {
    const p = await context.newPage();
    const navs = [];
    p.on("framenavigated", (f) => f === p.mainFrame() && navs.push(f.url()));
    let hits = 0;
    await p.route(/\/assets\/StockModal-[\w-]+\.js$/, (r) => (hits++ === 0 ? r.fulfill({ status: 404, body: "" }) : r.continue()));
    try {
      await p.goto(BASE + "/", { waitUntil: "load" });
      await p.waitForEvent("load", { timeout: 10000 }); // the one recovery reload
      await p.locator("tbody#body tr.row-open").first().waitFor({ timeout: 15000 });
      await p.waitForTimeout(5000);
      assert.equal(navs.length, 2, `navigations: ${navs.length}`);
      await p.locator("tbody#body tr.row-open").first().click();
      await p.locator(".mkm-modal #mkm-sym").first().waitFor({ timeout: 5000 });
    } finally { await p.close(); }
  });

  await step("chunk keeps failing -> no reload loop", async () => {
    const p = await context.newPage();
    const navs = [];
    p.on("framenavigated", (f) => f === p.mainFrame() && navs.push(f.url()));
    await p.route(/\/assets\/StockModal-[\w-]+\.js$/, (r) => r.fulfill({ status: 404, body: "" }));
    try {
      await p.goto(BASE + "/", { waitUntil: "load" });
      await p.waitForTimeout(12000);
      assert.equal(navs.length, 2, `expected 1 load + 1 reload, got ${navs.length}`);
    } finally { await p.close(); }
  });

  await step("offline prefetch failure -> no reload", async () => {
    const p = await context.newPage();
    const navs = [];
    p.on("framenavigated", (f) => f === p.mainFrame() && navs.push(f.url()));
    try {
      await p.goto(BASE + "/", { waitUntil: "load" });
      await context.setOffline(true);
      await p.waitForTimeout(6000);
      assert.equal(navs.length, 1, `reloaded while offline: ${navs.length - 1}x`);
    } finally {
      await context.setOffline(false);
      await p.close();
    }
  });

  // ---- haptics: each chosen button vibrates with its pattern (Android path), the LIVE badge
  // and a signed-out press do not, and with no vibrate API (iPhone) a hidden switch is toggled.
  // Patterns mirror src/haptics.ts PATTERNS.
  const H = { light: 10, medium: 20, success: [12, 60, 12], warning: [30, 50, 30] };
  const NOTIF = { id: "e2e-n1", type: "price", ticker: WL, dir: "up", since: 6, at: Date.now(), read: false };
  async function hapticsPage({ ios = false, seedNotif = false } = {}) {
    const p = await context.newPage();
    await p.addInitScript(({ ios, seedNotif, notif }) => {
      window.__vib = [];
      if (ios) delete Navigator.prototype.vibrate;
      else navigator.vibrate = (pat) => (window.__vib.push(pat), true);
      if (seedNotif) localStorage.setItem("mp_notifs", JSON.stringify([notif]));
    }, { ios, seedNotif, notif: NOTIF });
    p.on("pageerror", (e) => consoleErrors.push(`pageerror (haptics): ${e.message}`));
    await p.goto(BASE + "/", { waitUntil: "load" });
    await p.locator("tbody#body tr.row-open").first().waitFor({ timeout: 15000 });
    return p;
  }
  const vib = (p) => p.evaluate(() => { const v = window.__vib; window.__vib = []; return v; });
  const star = (p, t, on) => p.locator(`tbody#body button.wl-star[aria-label="${on ? `Remove ${t} from` : `Add ${t} to`} watchlist"]`);

  await step("haptics: table star add = success, remove = medium", async () => {
    const p = await hapticsPage();
    try {
      await star(p, WL, false).click();
      await star(p, WL, true).waitFor();
      assert.deepEqual(await vib(p), [H.success]);
      await star(p, WL, true).click();
      await star(p, WL, false).waitFor();
      assert.deepEqual(await vib(p), [H.medium]);
    } finally { await p.close(); }
  });

  await step("haptics: thumb set = success, clear = light", async () => {
    const p = await hapticsPage();
    try {
      const up = p.locator("tbody#body tr.row-open").first().locator("button.tmk-b.up");
      await up.click();
      await p.waitForFunction(() => document.querySelector("tbody#body tr.row-open button.tmk-b.up")?.getAttribute("aria-pressed") === "true");
      assert.deepEqual(await vib(p), [H.success]);
      await up.click();
      await p.waitForFunction(() => document.querySelector("tbody#body tr.row-open button.tmk-b.up")?.getAttribute("aria-pressed") === "false");
      assert.deepEqual(await vib(p), [H.light]);
    } finally { await p.close(); }
  });

  await step("haptics: Reset filters = medium; LIVE badge = none", async () => {
    const p = await hapticsPage();
    try {
      const d = p.locator("details.filters");
      if (!(await d.evaluate((el) => el.open))) await d.locator("summary .filters-title").click();
      await p.locator('#cap button[data-c="10000"]').click();
      assert.deepEqual(await vib(p), [], "a plain filter press must not vibrate");
      await p.locator("button.filter-reset").click();
      assert.deepEqual(await vib(p), [H.medium]);
      await p.locator("button.livebadge").click();
      await p.locator("button.livebadge").click();
      assert.deepEqual(await vib(p), [], "LIVE badge was excluded");
    } finally { await p.close(); }
  });

  await step("haptics: watchlist drag = light pick-up + medium drop; remove star = medium", async () => {
    const p = await hapticsPage();
    try {
      const rows = p.locator("tbody#body tr.row-open");
      const t1 = (await rows.nth(0).locator(".sym").textContent()).trim();
      const t2 = (await rows.nth(1).locator(".sym").textContent()).trim();
      await star(p, t1, false).click();
      await star(p, t2, false).click();
      await vib(p);
      await p.locator("nav.nav-bottom button.nav-tab", { hasText: "Watchlist" }).click();
      const wrows = p.locator(".wl-table tbody tr");
      await wrows.nth(1).waitFor();
      const before = await p.evaluate(() => localStorage.getItem("mp_watchlist"));
      const g = await wrows.nth(0).locator("button.wl-grip").boundingBox();
      const r2 = await wrows.nth(1).boundingBox();
      await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await p.mouse.down();
      await p.mouse.move(g.x + g.width / 2, r2.y + r2.height - 2, { steps: 8 });
      await p.mouse.up();
      await p.waitForFunction((b) => localStorage.getItem("mp_watchlist") !== b, before, { timeout: 3000 });
      assert.deepEqual(await vib(p), [H.light, H.medium]);
      // a grab that goes nowhere: pick-up only, no drop buzz
      await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await p.mouse.down();
      await p.mouse.up();
      assert.deepEqual(await vib(p), [H.light]);
      await wrows.nth(0).locator("button.wl-star").click();
      assert.deepEqual(await vib(p), [H.medium]);
    } finally { await p.close(); }
  });

  await step("haptics: Share = success; Get analyst data = success", async () => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    const p = await hapticsPage();
    try {
      await p.evaluate((t) => { location.hash = t; }, RICH.t);
      await p.locator(".mkm-modal #mkm-sym").first().waitFor({ timeout: 10000 });
      await vib(p);
      await p.locator(".mkm-modal button.mp-share").first().click();
      await p.waitForTimeout(300);
      assert.deepEqual(await vib(p), [H.success]);
      // "Get analyst data" needs a live price for the off-universe stock (offline it reads
      // "No data"), so this page alone answers the Worker's /quotes for it.
      await p.route(/\/quotes\?symbols=/, (r) =>
        r.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ quotes: { [OFF]: { px: 5, chg: 0.1, pct: 2, pc: 4.9, day: null, o: null, h: null, l: null, ext: null, name: OFF, mc: null, hi52: null, lo52: null, pe: null, fpe: null } } }),
        }),
      );
      await p.evaluate((t) => { location.hash = t; }, OFF);
      await p.locator(".mkm-modal button.mkm-trackreq").first().waitFor({ timeout: 10000 });
      await vib(p);
      await p.locator(".mkm-modal button.mkm-trackreq").first().click();
      assert.deepEqual(await vib(p), [H.success]);
    } finally { await p.close(); }
  });

  await step("haptics: Clear all notifications = warning", async () => {
    const p = await hapticsPage({ seedNotif: true });
    try {
      await p.locator("button.nb-bell").click();
      await p.locator("button.nb-clear").click();
      assert.deepEqual(await vib(p), [H.warning]);
    } finally { await p.close(); }
  });

  await step("haptics: sign out = medium, signed-out star = none, sign in = success", async () => {
    const p = await hapticsPage();
    try {
      await p.locator("button.acctchip").click();
      await p.locator("button.si-out").click();
      assert.deepEqual(await vib(p), [H.medium]);
      await star(p, WL, false).click(); // signed out: opens sign-in instead of starring
      await p.locator("button.si-prov").first().waitFor();
      assert.deepEqual(await vib(p), [], "signed-out star must not vibrate");
      await p.locator("button.si-prov").first().click();
      await p.locator("button.acctchip").waitFor();
      assert.deepEqual(await vib(p), [H.success]);
    } finally { await p.close(); }
  });

  await step("haptics: no vibrate API (iPhone) toggles one hidden switch per press", async () => {
    const p = await hapticsPage({ ios: true });
    try {
      assert.equal(await p.evaluate(() => typeof navigator.vibrate), "undefined");
      await star(p, WL, false).click();
      await star(p, WL, true).waitFor();
      const sw = p.locator('label[aria-hidden="true"] > input[type="checkbox"][switch]');
      assert.equal(await sw.count(), 1, "hidden switch not attached");
      assert.equal(await sw.isVisible(), false, "switch must stay hidden");
      assert.equal(await sw.isChecked(), true, "first press should toggle it on");
      await star(p, WL, true).click();
      await star(p, WL, false).waitFor();
      assert.equal(await sw.count(), 1, "switch must be reused, not re-created");
      assert.equal(await sw.isChecked(), false, "second press should toggle it off");
    } finally { await p.close(); }
  });

  await step("no console errors", async () => {
    assert.deepEqual(consoleErrors, []);
  });

  await step("no same-origin 4xx/5xx", async () => {
    assert.deepEqual(badResponses, []);
  });

  await step("live-price hosts were blocked (test stayed offline)", async () => {
    assert.ok(blocked.live > 0, "expected the app to try a live host at least once");
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed  (blocked: ${blocked.live} live, ${blocked.other} other)`);
  exitCode = failed ? 1 : 0;
} catch (e) {
  console.error("e2e aborted:", e);
} finally {
  await browser.close().catch(() => {});
  stopServer();
}
process.exit(exitCode);
