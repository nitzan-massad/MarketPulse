// Backfill/refresh public/forecasts/<T>.json from TipRanks' stock-forecast payload.json, plus the
// forecast page when the payload failed or withholds a target (getData is Cloudflare-blocked since
// 2026-11; it is no longer fetched). Strictly additive + per-ticker failure-tolerant: a bad ticker
// is skipped, never fatal, so this can't break the main refresh. Fills tickers that are MISSING a
// file or are older than STALE_DAYS, stalest first so LIMIT rotates through the whole universe
// (pass ALL=1 to force everyone). Cap with LIMIT (default 90).
//
// ponytail: "when did we last fetch this" lives in the committed _asOf.json sidecar,
// NOT in the file's mtime. Git stores no mtimes, so actions/checkout stamps every file
// with the checkout time — an mtime check makes all 300+ files look seconds old, nothing
// is ever refreshed, and only brand-new tickers get fetched. That's exactly what happened
// between 2026-07-24 and 2026-08-02. The sidecar survives checkout because git tracks it.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseForecastHtml, usablePage, withStars } from "./forecast-html.mjs";
import { carryPrevGuarded, carryStars, forecastsDegraded, prunedTried, forecastsFromPayload, hiddenAnalysts, hiddenTargetKeys, pageNeeded, payloadOk, keepPrevRating, mergeForecasts, missingOf, topUpRows } from "./forecast-merge.mjs";
import { nearEarningsNow } from "./scrape-earnings.mjs";
import { getText, makeBreaker, health } from "./tr-fetch.mjs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const LIMIT = Number(process.env.LIMIT || 90);
const STALE_DAYS = Number(process.env.STALE_DAYS || 3);
const ALL = process.env.ALL === "1";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // just these tickers (ci/track-requests)
// Overridable so a live run can be pointed at a throwaway directory to verify the merge
// against real TipRanks pages without touching the committed files. CI never sets it.
const OUT = process.env.OUT || "public/forecasts";
const ASOF = `${OUT}/_asOf.json`; // { ticker: ISO } — build-reviews-recent skips it (not an array)
// { ticker: ["analystKey|date", ...] } — hidden targets the page was already fetched for (see
// pageNeeded). Same "not an array, not a ticker name" property keeps it out of the reviews feed and the data gate.
const TRIED = `${OUT}/_pageTried.json`;

// Transport is ci/tr-fetch.mjs: plain fetch, FlareSolverr on a challenge/403, and a Cloudflare
// firewall block throws BlockedError at once (never retried). One breaker per endpoint: after 3
// blocks in a row the endpoint is skipped for the rest of the run.
// A Cloudflare page is always retried like an error (getText); `ok` adds a per-URL check (e.g. "is JSON").
// Never fold the Cloudflare test into `ok`: a challenge's inline `_cf_chl_opt={}` parses as JSON
// `{}`, which read as "no experts" and shrank MA to its page rows in the E2E fault run.
// ponytail: 2 tries per URL, not 6 x (up to 60s) — a payload failure falls back to the page and to
// last run's rows, and a page outage must not sink the step. The page goes straight to FlareSolverr.
const payloadBreaker = makeBreaker(), pageBreaker = makeBreaker();
const tripped = new Set();
const skipOpen = (name, br) => {
  if (!br.open()) return false;
  if (!tripped.has(name)) { tripped.add(name); health(`breaker open: ${name}`); console.log(`  ${name} breaker open: skipping it for the rest of the run`); }
  return true;
};

// payload.json comes back as JSON, sometimes (via FlareSolverr) wrapped in <pre> with HTML entities
function extractJson(html) {
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  for (const cand of [pre && pre[1], html].filter(Boolean)) {
    const decoded = cand
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const m = decoded.match(/\{[\s\S]*\}/);
    if (!m) continue;
    try { return JSON.parse(m[0]); } catch { /* try next */ }
  }
  throw new Error("no JSON in response");
}

const stocks = JSON.parse(readFileSync("src/data/stocks.json", "utf8"));
const staleBefore = Date.now() - STALE_DAYS * 864e5;
const asOf = existsSync(ASOF) ? JSON.parse(readFileSync(ASOF, "utf8")) : {};
const tried = existsSync(TRIED) ? JSON.parse(readFileSync(TRIED, "utf8")) : {};
const age = (t) => Date.parse(asOf[t]) || 0; // never fetched -> 0 -> front of the queue
// Companies within 2 days of an earnings report are refreshed EVERY run, on top of LIMIT —
// that is when new analyst reviews land. The rest rotate stalest-first as before.
const near = ONLY ? new Set() : nearEarningsNow();
const hot = stocks.map((s) => s.t).filter((t) => near.has(t));
const targets = [...hot, ...stocks
  .map((s) => s.t)
  .filter((t) => !near.has(t) && (ONLY ? ONLY.includes(t) : ALL || age(t) < staleBefore))
  .sort((a, b) => age(a) - age(b)) // stalest (incl. never-fetched = 0) first
  .slice(0, LIMIT)];

// Clamped: 0/NaN/negative would start no worker and "succeed" having fetched nothing.
const PARALLEL = Math.max(1, Math.floor(Number(process.env.PARALLEL)) || 1);
mkdirSync(OUT, { recursive: true });
console.log(`forecasts backfill: ${targets.length} ticker(s), ${hot.length} near earnings (LIMIT=${LIMIT}, ALL=${ALL}, PARALLEL=${PARALLEL})`);
const now = new Date().toISOString();
let written = 0, empty = 0, fail = 0, viaPage = 0, pages = 0, pageFails = 0, payloadFails = 0, carried = 0, widened = 0, unfetched = 0;
// ponytail: a fixed pool of PARALLEL workers over one shared FlareSolverr; each request is a
// headless Chrome, so the ceiling is runner CPU, not TipRanks: 3 on the 4-vCPU runner
// (90 tickers: P1 973s, P3 655s, P10 1378s). More needs more cores or more FlareSolverr instances.
const queue = [...targets];
// ponytail: _asOf is flushed every 20 stamps and on SIGTERM/SIGINT, atomically (tmp + rename), so a
// step timeout or cancel keeps the rotation progress it made instead of re-picking the same
// tickers next run; files already written are committed either way. Ceiling: up to 19 stamps lost
// on a hard SIGKILL — those tickers are simply refetched next run.
let stamped = 0;
const saveAsOf = () => {
  writeFileSync(`${ASOF}.tmp`, JSON.stringify(asOf, null, 1)); renameSync(`${ASOF}.tmp`, ASOF);
  writeFileSync(`${TRIED}.tmp`, JSON.stringify(tried)); renameSync(`${TRIED}.tmp`, TRIED);
};
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { saveAsOf(); console.log(`${sig}: _asOf saved (${stamped} stamped)`); process.exit(143); });
async function scrape(t) {
  try {
    let prev = null;
    try { prev = JSON.parse(readFileSync(`${OUT}/${t}.json`, "utf8")); } catch { /* first fetch */ }
    const slug = encodeURIComponent(t.toLowerCase());
    // 1. payload.json names every rating in the consensus window, with the analyst's stars (rank).
    let fj = null, src = null;
    if (!skipOpen("payload.json", payloadBreaker)) {
      try {
        const breaker = payloadBreaker;
        const okPayload = (h) => { try { return forecastsFromPayload(extractJson(h), t) !== null; } catch { return false; } };
        fj = extractJson(await getText(`https://www.tipranks.com/stocks/${slug}/stock-forecast/payload.json`, { flareUrl: FS_URL, tries: 2, plain: true, ok: okPayload, breaker }));
        src = forecastsFromPayload(fj, t);
      } catch { src = null; }
    }
    // 0 rows over a non-empty file counts as a failure too (a reshape must not shrink the file)
    const ok = payloadOk(src, prev);
    if (!ok) payloadFails++;
    // 2. stars: the payload's, else the analyst's from last run
    let fc = carryStars(ok ? src : [], prev);
    // 3. the page only when the payload failed, or once per target the payload withholds
    const hidden = ok ? hiddenTargetKeys(fj, t, prev ?? []) : [];
    const needPage = pageNeeded({ srcOk: ok, hidden, tried: tried[t] });
    // prune: the map can't grow forever — but only on a payload that parsed; a failed one says
    // nothing about which hidden targets remain, and pruning then would re-fetch the page for them
    tried[t] = prunedTried(tried[t], hidden, ok);
    let source = ok ? "payload" : "page";
    let fresh = ok; // something this run actually fetched
    if (needPage && !skipOpen("forecast page", pageBreaker)) {
      pages++;
      try {
        // usablePage(h, 1): an error/empty page must not parse to [] and pass as "no analysts"
        const page = parseForecastHtml(await getText(`https://www.tipranks.com/stocks/${slug}/forecast`, { flareUrl: FS_URL, tries: 2, plain: false, ok: (h) => usablePage(h, 1), breaker: pageBreaker }));
        const before = fc.length;
        if (ok) {
          // payload rows win (FX-stable targets; the page's would re-ring the bell); the page only adds
          fc = mergeForecasts(fc, topUpRows(withStars(page), missingOf(fc, page)));
        } else {
          fc = withStars(page);
        }
        fresh = true;
        tried[t] = hidden;
        if (fc.length > before) { viaPage++; if (ok) source = "payload+page"; }
      } catch (e) {
        pageFails++;
        console.log(`  ${t}: page failed (${e.message})${ok ? ", payload rows kept" : ", last run's rows kept"}`);
      }
    }
    if (!tried[t].length) delete tried[t];
    fc = carryStars(fc, prev); // page-only rows: the analyst's star from last run
    // 4. last run's rows: a stored rating keeps its firm/target; analysts this run lacks stay while
    // recent (all of them when the payload failed, so a fetch failure never shrinks the file)
    // keepNewerPrev: a source regression must not swap an analyst's older row back in; then the newest
    // rating per analyst replaces the older one. Widens to all:true if the file would shrink past the gate.
    fc = keepPrevRating(fc, prev);
    // hold: an analyst whose newer payload rating hides its target keeps his stored row at any age (R2)
    const g = carryPrevGuarded(fc, prev, { ok, hold: ok ? hiddenAnalysts(fj, t, prev ?? []) : [] });
    fc = g.rows;
    const back = g.carried;
    carried += back;
    if (g.widened) { widened++; console.log(`  ${t}: 92-day carry would shrink the file past the data gate, carried every prev analyst`); }
    if (!fresh) unfetched++; // payload AND page failed (or the page was skipped): last run's rows only
    if (fc.length) {
      writeFileSync(`${OUT}/${t}.json`, JSON.stringify(fc)); written++;
      console.log(`  ${t}: ${fc.length} ✓ (${source})${back ? ` (+${back} carried)` : ""}`);
    }
    else { empty++; console.log(`  ${t}: none`); }
    // ponytail: stamp on empty too, so a ticker TipRanks genuinely has no experts for
    // rotates out instead of hogging a LIMIT slot every run. It still gets retried each
    // STALE_DAYS. A ticker whose sources BOTH failed is NOT stamped — retried next run.
    if (fresh) asOf[t] = now;
    if (++stamped % 20 === 0) saveAsOf();
  } catch (e) {
    fail++;
    console.log(`  ${t}: skip (${e.message})`);
  }
}
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (queue.length) await scrape(queue.shift());
}));
saveAsOf();
// tripwire: payload.json failing a lot = TipRanks moved or blocked it; every ticker is on the slow page path
if (payloadFails) console.log(`${payloadFails > 10 ? "::warning::" : ""}forecasts: payload.json failed for ${payloadFails} ticker(s)`);
if (pageFails) console.log(`${pageFails > 10 ? "::warning::" : ""}forecasts: ${pageFails} forecast page(s) failed`);
// thrown + both-sources-failed: either way the ticker got nothing new this run
const degraded = forecastsDegraded({ thrown: fail, unfetched, targets: targets.length });
if (degraded) health(degraded);
console.log(`done: ${written} written (${pages} page fetches, ${viaPage} gained rows from the page, ${pageFails} failed), ${carried} carried forward, ${empty} empty, ${fail} failed, ${unfetched} unfetched (payload+page), ${payloadFails} payload failures, ${widened} widened carries`);
