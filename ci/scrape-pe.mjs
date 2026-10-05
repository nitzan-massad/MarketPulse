// Precompute 5-year weekly P/E history per ticker into public/pe/<T>.json, so the stock
// modal's "P/E history" chart reads a static file instead of spending the site's shared
// browser-side API quota (Twelve Data free tier: 8 calls/min, 800/day, for ALL visitors).
//
// Per ticker: Finnhub /stock/metric (quarterly EPS + quarterly peTTM, the anchor for foreign
// filers and banks) and Twelve Data 5Y weekly closes. The maths is src/peHistory.ts — the SAME module
// the app falls back to for off-universe tickers, imported directly (Node >= 22.18 strips
// the types), so the two can never drift.
//
// Rotation: missing first, then oldest ATTEMPT stamp (`a` in _asOf.json) — never file mtime,
// which actions/checkout restamps (see CLAUDE.md). LIMIT per run keeps one run inside Twelve
// Data's per-minute cap; ALL=1 does everyone (the local backfill).
// Per-ticker failure-tolerant: a bad ticker is stamped and skipped, never fatal.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hasPeHistory, lastYears, parseEps, peSeries } from "../src/peHistory.ts";

const FH = process.env.FINNHUB_KEY || process.env.VITE_FINNHUB_KEY || "";
const TD = process.env.TWELVEDATA_KEY || process.env.VITE_TWELVEDATA_KEY || "";
const LIMIT = Number(process.env.LIMIT || 40);
const STALE_DAYS = Number(process.env.STALE_DAYS || 7);
const ALL = process.env.ALL === "1";
const TD_GAP_MS = Number(process.env.TD_GAP_MS || 8000); // 8/min free tier -> one call per ~7.5s
const FH_GAP_MS = 1100; // Finnhub free tier is 60/min; no-EPS tickers skip Twelve Data and would burst past it
const OUT = "public/pe";
const INDEX = `${OUT}/_asOf.json`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!FH || !TD) {
  console.log("scrape-pe: FINNHUB_KEY / TWELVEDATA_KEY not set — skipping");
  process.exit(0);
}

class DailyLimit extends Error {}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) {
    // Twelve Data's DAILY cap (800 credits, shared with every visitor's browser) answers 429
    // with "for the day". Nothing more will succeed today, so stop instead of stamping the
    // rest of the queue as failures.
    const body = await r.text().catch(() => "");
    if (/for the day/i.test(body)) throw new DailyLimit("Twelve Data daily credits used up");
    throw new Error(`HTTP ${r.status}`);
  }
  return r.json();
}

/** Twelve Data with one patient retry on its per-minute limit (code 429 in the body). */
async function weekly(t) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(t)}&interval=1week&outputsize=262&apikey=${TD}`;
  for (let i = 0; i < 2; i++) {
    const j = await getJson(url);
    if (j?.code === 429 && /for the day/i.test(j?.message || "")) throw new DailyLimit("Twelve Data daily credits used up");
    if (j?.code === 429) {
      await sleep(61000);
      continue;
    }
    if (j?.status === "error" || !Array.isArray(j?.values)) throw new Error(j?.message || "no values");
    const v = [...j.values].reverse(); // TD is newest-first
    return { stamps: v.map((x) => x.datetime), closes: v.map((x) => parseFloat(x.close)) };
  }
  throw new Error("rate limited twice");
}

const tickers = [
  ...new Set([
    ...JSON.parse(readFileSync("src/data/stocks.json", "utf8")).map((r) => r.t),
    ...(() => { try { return JSON.parse(readFileSync("src/data/pinned.json", "utf8")); } catch { return []; } })(),
  ]),
];
let index = {};
try { index = JSON.parse(readFileSync(INDEX, "utf8")); } catch { /* first run */ }

const staleMs = STALE_DAYS * 864e5;
const now = Date.now();
// a failed fetch (err) goes first: it says nothing about the company, so it must not wait a week
const due = (t) => (index[t]?.err ? 0 : Date.parse(index[t]?.a || "") || 0);
const queue = tickers
  .filter((t) => ALL || !index[t] || index[t].err || now - Date.parse(index[t].a) > staleMs)
  .sort((a, b) => due(a) - due(b))
  .slice(0, ALL ? Infinity : LIMIT);

mkdirSync(OUT, { recursive: true });
console.log(`scrape-pe: ${queue.length} of ${tickers.length} ticker(s) (LIMIT=${LIMIT}, ALL=${ALL})`);
let wrote = 0, none = 0, failed = 0;
for (const t of queue) {
  const started = Date.now();
  const stamp = new Date().toISOString();
  try {
    const m = await getJson(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(t)}&metric=all&token=${FH}`);
    const eps = parseEps(m?.series?.quarterly?.eps);
    const peq = parseEps(m?.series?.quarterly?.peTTM);
    if (eps.length < 4 && peq.length < 4) {
      index[t] = { a: stamp, ok: false };
      none++;
      console.log(`  ${t}: no EPS history`);
    } else {
      const s = await weekly(t);
      const pts = lastYears(peSeries(s.stamps, s.closes, eps, peq), 5);
      if (!hasPeHistory(pts)) {
        index[t] = { a: stamp, ok: false };
        none++;
        console.log(`  ${t}: no positive-earnings weeks`);
      } else {
        writeFileSync(
          `${OUT}/${t}.json`,
          JSON.stringify({ asOf: stamp.slice(0, 10), pts: pts.map((p) => (p.loss ? [p.d, null, 1] : [p.d, p.v == null ? null : +p.v.toFixed(2)])) }) + "\n",
        );
        index[t] = { a: stamp, ok: true };
        wrote++;
        const last = pts.filter((p) => p.v != null).at(-1);
        console.log(`  ${t}: ${pts.length} weeks, now ${last.v.toFixed(1)}x`);
      }
      // pace Twelve Data only when we actually called it
      const wait = TD_GAP_MS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  } catch (e) {
    if (e instanceof DailyLimit) {
      console.log(`  ${t}: ${e.message} — stopping; the rest stay queued for the next run`);
      break;
    }
    // attempt, not success. `err` keeps a fetch failure apart from "no earnings" (HAL and HWM
    // were once shown with no chart because a rate-limited call read as "no history").
    index[t] = { a: stamp, ok: index[t]?.ok ?? false, err: true };
    failed++;
    console.log(`  ${t}: skip (${e.message})`);
  }
  const gap = FH_GAP_MS - (Date.now() - started);
  if (gap > 0) await sleep(gap);
  // write the index as we go, so a killed run keeps its progress
  writeFileSync(INDEX, JSON.stringify(Object.fromEntries(Object.entries(index).sort())) + "\n");
}
console.log(`done: ${wrote} written, ${none} without P/E history, ${failed} failed`);
