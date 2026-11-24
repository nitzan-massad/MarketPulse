// Backfill/refresh public/bullbear/<T>.json from the provider's per-ticker analysis payload
// (the AI Upside / Risks thesis; parser in ci/bullbear-payload.mjs), plain fetch first,
// FlareSolverr on a challenge — same transport the forecast scrape uses. Fills tickers MISSING a file or older than STALE_DAYS, stalest
// first so LIMIT rotates through the whole universe (pass ALL=1 to force everyone).
// Strictly additive + per-ticker failure-tolerant: a bad ticker is skipped, never fatal.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { nearEarningsNow } from "./scrape-earnings.mjs";
import { extractJson, parseBullBearPayload } from "./bullbear-payload.mjs";
import { getText, makeBreaker, health } from "./src-fetch.mjs";
import { srcUrl } from "./source.mjs";

const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
const LIMIT = Number(process.env.LIMIT || 90);
const STALE_DAYS = Number(process.env.STALE_DAYS || 3);
const ALL = process.env.ALL === "1";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // just these tickers (ci/track-requests)
const OUT = "public/bullbear";

// Transport is ci/src-fetch.mjs: a Cloudflare firewall block fails at once; the breaker skips the
// rest of the run after 3 in a row (no file written, so the tickers keep their place in the queue).
// The lite run (ONLY) has a user waiting: 3 tries, not 6 x (up to 60s) per URL.
const pageBreaker = makeBreaker();
const parses = (h) => { try { extractJson(h); return true; } catch { return false; } };
const flareGet = (url, tries = ONLY ? 3 : 6) => getText(url, { flareUrl: FS_URL, tries, ok: parses, breaker: pageBreaker });

// the payload carries no content date, so stamp when WE refreshed it
const ASOF = new Date().toISOString().slice(0, 10);

const stocks = JSON.parse(readFileSync("src/data/stocks.json", "utf8"));
const staleBefore = Date.now() - STALE_DAYS * 864e5;
// ponytail: age comes from the asOf WE stamp into each file, never from mtime — git stores
// no mtimes, so actions/checkout makes every file look seconds old and nothing is ever
// refreshed (same bug that froze public/forecasts). Read once into a map; `age` is called
// O(n log n) times by the sort. Missing file / pre-asOf file -> 0 -> front of the queue.
const ages = new Map(stocks.map((s) => {
  let d = "";
  try { d = JSON.parse(readFileSync(`${OUT}/${s.t}.json`, "utf8")).asOf || ""; } catch { /* missing or unstamped */ }
  return [s.t, Date.parse(d) || 0];
}));
const age = (t) => ages.get(t) ?? 0;
// Companies within 2 days of an earnings report are refreshed EVERY run, on top of LIMIT —
// that is when new analyst reviews land. The rest rotate stalest-first as before.
const near = ONLY ? new Set() : nearEarningsNow();
const hot = stocks.map((s) => s.t).filter((t) => near.has(t));
const targets = [...hot, ...stocks
  .map((s) => s.t)
  .filter((t) => !near.has(t) && (ONLY ? ONLY.includes(t) : ALL || age(t) < staleBefore))
  .sort((a, b) => age(a) - age(b)) // stalest (incl. never-fetched = 0) first
  .slice(0, LIMIT)];

mkdirSync(OUT, { recursive: true });
console.log(`bullbear backfill: ${targets.length} ticker(s), ${hot.length} near earnings (LIMIT=${LIMIT}, ALL=${ALL})`);
let ok = 0, empty = 0, fail = 0;
let skipped = 0;
for (const t of targets) {
  if (pageBreaker.open()) {
    if (!skipped) { health("breaker open: bullbear payload"); console.log("  bullbear payload breaker open: skipping the rest of the run"); }
    skipped++; continue;
  }
  try {
    const url = srcUrl("analysis", t);
    const bb = parseBullBearPayload(extractJson(await flareGet(url)), t);
    if (bb.bull.length || bb.bear.length) {
      writeFileSync(`${OUT}/${t}.json`, JSON.stringify({ ...bb, asOf: ASOF }));
      ok++;
      console.log(`  ${t}: ${bb.bull.length}↑ ${bb.bear.length}↓ ✓`);
    } else {
      // Ticker has no AI thesis (common for micro-caps).
      // ponytail: either way nothing is written, so the ticker stays at age 0 and is retried
      // every run. Cheap while that set is small; if `failed` grows on healthy runs, stamp an
      // asOf for no-thesis tickers (or keep a skip list) so they rotate out of the budget.
      empty++;
      console.log(`  ${t}: none`);
    }
  } catch (e) {
    fail++;
    console.log(`  ${t}: skip (${e.message})`);
  }
}
console.log(`done: ${ok} written, ${empty} empty, ${fail} failed, ${skipped} skipped (breaker open)`);
// Tripwire: a big run that wrote NOTHING means the source moved again (the old stock-analysis
// payload died exactly this way, silently, as "N empty"). Warn loudly; the step is continue-on-error so it never blocks
// the deploy. Off for ONLY runs: track-requests.yml fails the lite run on any non-zero exit.
if (!ONLY && ok === 0 && targets.length >= 10) {
  console.log(`::warning::bullbear: 0 of ${targets.length} written — upstream payload or source likely changed (see ci/bullbear-payload.mjs)`);
  process.exitCode = 1;
}
