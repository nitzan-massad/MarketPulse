// Backfill/refresh public/forecasts/<T>.json from the provider's per-ticker forecast payload (the old endpoint is
// Cloudflare-blocked since 2026-11; the HTML /forecast page fallback since 2026-11-22 — neither is
// fetched any more; a failed payload carries last run's rows). Strictly additive + per-ticker failure-tolerant: a bad ticker
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
import { carryPrevGuarded, carryStars, forecastsDegraded, forecastsFromPayload, hiddenAnalysts, payloadOk, keepPrevRating } from "./forecast-merge.mjs";
import { nearEarningsNow } from "./scrape-earnings.mjs";
import { getText, makeBreaker, health } from "./src-fetch.mjs";
import { srcUrl } from "./source.mjs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const LIMIT = Number(process.env.LIMIT || 90);
const STALE_DAYS = Number(process.env.STALE_DAYS || 3);
const ALL = process.env.ALL === "1";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // just these tickers (ci/track-requests)
// Overridable so a live run can be pointed at a throwaway directory to verify the merge
// against real upstream pages without touching the committed files. CI never sets it.
const OUT = process.env.OUT || "public/forecasts";
const ASOF = `${OUT}/_asOf.json`; // { ticker: ISO } — build-reviews-recent skips it (not an array)

// Transport is ci/src-fetch.mjs: plain fetch, FlareSolverr on a challenge/403, and a Cloudflare
// firewall block throws BlockedError at once (never retried). One breaker per endpoint: after 3
// blocks in a row the endpoint is skipped for the rest of the run.
// A Cloudflare page is always retried like an error (getText); `ok` adds a per-URL check (e.g. "is JSON").
// Never fold the Cloudflare test into `ok`: a challenge's inline `_cf_chl_opt={}` parses as JSON
// `{}`, which read as "no experts" and shrank MA to its page rows in the E2E fault run.
// ponytail: 2 tries per URL, not 6 x (up to 60s) — a payload failure falls back to last run's rows.
// The HTML /forecast page fallback was dropped 2026-11-22: Cloudflare hard-blocks runner IPs on it,
// and the targets it was fetched for are null in the provider's own data too (it gained rows for ~1 ticker
// per 8 runs). ci/forecast-html.mjs + the page helpers in forecast-merge.mjs stay, unused, for a revival.
const payloadBreaker = makeBreaker();
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
let written = 0, empty = 0, fail = 0, payloadFails = 0, carried = 0, widened = 0, unfetched = 0;
// ponytail: a fixed pool of PARALLEL workers over one shared FlareSolverr; each request is a
// headless Chrome, so the ceiling is runner CPU, not upstream: 3 on the 4-vCPU runner
// (90 tickers: P1 973s, P3 655s, P10 1378s). More needs more cores or more FlareSolverr instances.
const queue = [...targets];
// ponytail: _asOf is flushed every 20 stamps and on SIGTERM/SIGINT, atomically (tmp + rename), so a
// step timeout or cancel keeps the rotation progress it made instead of re-picking the same
// tickers next run; files already written are committed either way. Ceiling: up to 19 stamps lost
// on a hard SIGKILL — those tickers are simply refetched next run.
let stamped = 0;
const saveAsOf = () => { writeFileSync(`${ASOF}.tmp`, JSON.stringify(asOf, null, 1)); renameSync(`${ASOF}.tmp`, ASOF); };
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { saveAsOf(); console.log(`${sig}: _asOf saved (${stamped} stamped)`); process.exit(143); });
async function scrape(t) {
  try {
    let prev = null;
    try { prev = JSON.parse(readFileSync(`${OUT}/${t}.json`, "utf8")); } catch { /* first fetch */ }
    // 1. payload.json names every rating in the consensus window, with the analyst's stars (rank).
    let fj = null, src = null;
    if (!skipOpen("payload.json", payloadBreaker)) {
      try {
        const breaker = payloadBreaker;
        const okPayload = (h) => { try { return forecastsFromPayload(extractJson(h), t) !== null; } catch { return false; } };
        fj = extractJson(await getText(srcUrl("forecast", t), { flareUrl: FS_URL, tries: 2, plain: true, ok: okPayload, breaker }));
        src = forecastsFromPayload(fj, t);
      } catch { src = null; }
    }
    // 0 rows over a non-empty file counts as a failure too (a reshape must not shrink the file)
    const ok = payloadOk(src, prev);
    if (!ok) payloadFails++;
    // 2. stars: the payload's, else the analyst's from last run
    let fc = carryStars(ok ? src : [], prev);
    const source = ok ? "payload" : "carried";
    const fresh = ok; // something this run actually fetched
    // 3. last run's rows: a stored rating keeps its firm/target; analysts this run lacks stay while
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
    if (!fresh) unfetched++; // payload failed: last run's rows only
    if (fc.length) {
      writeFileSync(`${OUT}/${t}.json`, JSON.stringify(fc)); written++;
      console.log(`  ${t}: ${fc.length} ✓ (${source})${back ? ` (+${back} carried)` : ""}`);
    }
    else { empty++; console.log(`  ${t}: none`); }
    // ponytail: stamp on empty too, so a ticker the provider genuinely has no experts for
    // rotates out instead of hogging a LIMIT slot every run. It still gets retried each
    // STALE_DAYS. A ticker whose payload failed is NOT stamped — retried next run.
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
// tripwire: payload.json failing a lot = the provider moved or blocked it; those tickers serve last run's rows
if (payloadFails) console.log(`${payloadFails > 10 ? "::warning::" : ""}forecasts: payload.json failed for ${payloadFails} ticker(s)`);
// thrown + both-sources-failed: either way the ticker got nothing new this run
const degraded = forecastsDegraded({ thrown: fail, unfetched, targets: targets.length });
if (degraded) health(degraded);
console.log(`done: ${written} written, ${carried} carried forward, ${empty} empty, ${fail} failed, ${unfetched} unfetched, ${payloadFails} payload failures, ${widened} widened carries`);
