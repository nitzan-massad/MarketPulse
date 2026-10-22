// 5-year weekly P/E history per ticker -> public/pe/<T>.json, for the stock modal's P/E chart
// (src/components/PeHistory.tsx). The maths is src/peHistory.ts — the SAME module the app uses
// for off-universe tickers, imported directly (Node >= 22.18 strips the types) so they can't drift.
//
// Inputs, cached per ticker in ci/cache/pe/<T>.json (committed, so history is fetched ONCE):
//   closes   5Y weekly closes, split-adjusted only (P/E's basis: Finnhub's EPS is not
//            spin-adjusted). CNBC's bars (worker/bars.js — the same parser + splitOnlyCloses the
//            Worker's /bars uses), re-fetched every REFRESH_CLOSES_DAYS so a split after the first
//            fetch can't leave stale pre-split closes (it did: LGVN 10x, TRNR 7x). Twelve Data only
//            as the fallback for a ticker with no closes at all. Between fetches, every run just
//            writes this week's close from our own snapshot (src/data/stocks.json `px`).
//   eps/peq  Finnhub quarterly EPS + quarterly peTTM (60/min) — refreshed on rotation.
//   reports  quarter end -> announcement date, SEC EDGAR (ci/sec-reports.mjs) — fetched when a
//            quarter we have EPS for has no date yet; dates never change once known.
// Every run recomputes EVERY ticker's file from its cache (offline, seconds), so all charts move
// with the latest price; only the LIMIT rotation spends API calls.
//
// Index: public/pe/_asOf.json { T: { a: attemptISO, ok, err? } } — also read by the app (ok ->
// chart; missing/err -> "updating"; ok:false -> no P/E history). `err` = a fetch failed, which
// says nothing about the company: retried first, with backoff so a dead ticker can't starve the queue.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hasPeHistory, lastYears, parseEps, peSeries } from "../src/peHistory.ts";
import { cikOf, filingsSince, isResultsFiling, pickReports } from "./sec-reports.mjs";
import { BROWSER_UA, normSym } from "../worker/cnbc.js";
import { barsUrl, parseBars, splitOnlyCloses } from "../worker/bars.js";

const FH = process.env.FINNHUB_KEY || process.env.VITE_FINNHUB_KEY || "";
// a CI-only key keeps backfills off the quota visitors' price charts use; falls back to the shared one
const TD = process.env.TWELVEDATA_CI_KEY || process.env.TWELVEDATA_KEY || process.env.VITE_TWELVEDATA_KEY || "";
const LIMIT = Number(process.env.LIMIT || 60);
const STALE_DAYS = Number(process.env.STALE_DAYS || 3);
const ALL = process.env.ALL === "1";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null; // just these tickers (ci/track-requests)
const TD_GAP_MS = 8000; // 8/min
const CNBC_GAP_MS = 500; // free and unmetered, but undocumented: stay polite
const REFRESH_CLOSES_DAYS = 7;
const CLOSES_PER_RUN = Number(process.env.CLOSES_PER_RUN || 60); // 2 CNBC calls each
const FH_GAP_MS = 1100; // 60/min
const OUT = "public/pe";
const CACHE = "ci/cache/pe";
const INDEX = `${OUT}/_asOf.json`;
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
/** Monday of this week — the weekly bar stamp (CNBC's Sunday is shifted to it in worker/bars.js),
 *  so our own snapshot close slots in beside the fetched ones. */
const thisMonday = (() => {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();

class DailyLimit extends Error {}
async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    if (/for the day/i.test(body)) throw new DailyLimit("Twelve Data daily credits used up");
    throw new Error(`HTTP ${r.status}`);
  }
  return r.json();
}
let tdLast = 0, fhLast = 0, cnLast = 0;
const pace = async (lastAt, gap) => { const w = lastAt + gap - Date.now(); if (w > 0) await sleep(w); return Date.now(); };

async function weekly(t) {
  for (let i = 0; i < 2; i++) {
    tdLast = await pace(tdLast, TD_GAP_MS);
    const j = await getJson(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(t)}&interval=1week&outputsize=262&apikey=${TD}`);
    if (j?.code === 429 && /for the day/i.test(j?.message || "")) throw new DailyLimit("Twelve Data daily credits used up");
    if (j?.code === 429) { await sleep(61000); continue; }
    if (j?.status === "error" || !Array.isArray(j?.values)) throw new Error(j?.message || "no values");
    return [...j.values].reverse().map((x) => [x.datetime.slice(0, 10), +parseFloat(x.close).toFixed(4)]);
  }
  throw new Error("rate limited twice");
}

// CNBC weekly closes (adjusted + unadjusted -> split-only), Monday-stamped, oldest first,
// without this week's bar (step 2 writes this week from our own snapshot).
async function weeklyCnbc(t) {
  const sym = normSym(t);
  if (!sym) throw new Error("not a CNBC symbol");
  const get = async (adj) => {
    cnLast = await pace(cnLast, CNBC_GAP_MS);
    const r = await fetch(barsUrl(sym, "PE", Date.now(), adj), {
      headers: { "user-agent": BROWSER_UA, accept: "application/json" }, // CNBC 403s non-browser UAs
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`CNBC HTTP ${r.status}`);
    return parseBars(await r.json(), "PE");
  };
  const adj = await get("adjusted");
  const unadj = await get("unadjusted");
  const closes = splitOnlyCloses(adj, unadj);
  return adj.t.map((d, i) => [d, closes[i]]).filter(([d]) => d < thisMonday).slice(-261);
}

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };
const rows = readJson("src/data/stocks.json", []);
const pxOf = new Map(rows.map((r) => [r.t, r.px]));
const tickers = [...new Set([...rows.map((r) => r.t), ...readJson("src/data/pinned.json", [])])];
const index = readJson(INDEX, {});
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

// ---- 1. refresh a rotating slice from the APIs -------------------------------------------
const backoff = (e) => (e?.err ? Math.min(7, 2 ** (e.n || 0)) * DAY / 7 : 0); // 1/7 day doubling, max 1 day
const dueAt = (t) => { const e = index[t]; return e ? Date.parse(e.a) + (e.err ? backoff(e) : STALE_DAYS * DAY) : 0; };
const now = Date.now();
const queue = tickers
  .filter((t) => (ONLY ? ONLY.includes(t) : ALL || dueAt(t) <= now))
  .sort((a, b) => (index[a]?.err ? 0 : 1) - (index[b]?.err ? 0 : 1) || dueAt(a) - dueAt(b))
  .slice(0, ALL ? Infinity : LIMIT);
console.log(`scrape-pe: refreshing ${queue.length} of ${tickers.length} (LIMIT=${LIMIT}, ALL=${ALL})`);

let refreshed = 0, failed = 0, tdCalls = 0, cnCalls = 0, stopTd = false, closesBudget = CLOSES_PER_RUN;
for (const t of queue) {
  if (!FH) break;
  const path = `${CACHE}/${t}.json`;
  const c = readJson(path, {});
  try {
    fhLast = await pace(fhLast, FH_GAP_MS);
    const m = await getJson(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(t)}&metric=all&token=${FH}`);
    c.eps = parseEps(m?.series?.quarterly?.eps).map((p) => [p.d, p.v]);
    c.peq = parseEps(m?.series?.quarterly?.peTTM).map((p) => [p.d, p.v]);
    const hasEarnings = c.eps.length >= 4 || c.peq.length >= 4;

    // prices: only for a company that has earnings data to divide by. CNBC every
    // REFRESH_CLOSES_DAYS (capped per run); Twelve Data only when there are no closes at all.
    const closesDue = !c.closes?.length || !c.ca || now - Date.parse(c.ca) > REFRESH_CLOSES_DAYS * DAY;
    if (hasEarnings && closesDue && closesBudget > 0) {
      closesBudget--;
      try {
        c.closes = await weeklyCnbc(t);
        c.ca = new Date().toISOString();
        cnCalls++;
      } catch (e) {
        if (c.closes?.length) console.log(`  ${t}: CNBC closes refresh failed (${e.message}) — keeping the cached ones`);
        else if (TD && !stopTd) {
          console.log(`  ${t}: CNBC closes failed (${e.message}) — Twelve Data fallback`);
          try { c.closes = await weekly(t); tdCalls++; }
          catch (e2) { if (e2 instanceof DailyLimit) { stopTd = true; console.log(`  ${e2.message} — no more price backfills this run`); } else throw e2; }
        } else console.log(`  ${t}: CNBC closes failed (${e.message}) — none this run`); // eps/peq/reports still saved, `wait` set
      }
    }

    // report dates: when a quarter in the last 5 years has none yet (they never change)
    const fiveY = new Date(now - 5.3 * 365.25 * DAY).toISOString().slice(0, 10);
    const quarters = [...new Set([...c.eps, ...c.peq].map(([d]) => d))].filter((d) => d >= fiveY && d < today);
    c.reports ??= {};
    // a quarter already looked up 120+ days after it ended and still undated (foreign filers with
    // no matching 6-K, companies outside EDGAR) keeps the 35-day guess for good: no endless re-checks
    const missing = quarters.filter(
      (q) =>
        !Object.keys(c.reports).some((k) => Math.abs(Date.parse(k) - Date.parse(q)) <= 7 * DAY) &&
        !(c.secAt && Date.parse(c.secAt) - Date.parse(q) > 120 * DAY),
    );
    const recentlyChecked = c.secAt && now - Date.parse(c.secAt) < 3 * DAY;
    if (hasEarnings && missing.length && !recentlyChecked) {
      c.cik ??= await cikOf(t);
      if (c.cik) {
        const filings = await filingsSince(c.cik, fiveY);
        Object.assign(c.reports, await pickReports(filings, missing, (row) => isResultsFiling(c.cik, row)));
      }
      c.secAt = new Date().toISOString();
    }
    writeFileSync(path, JSON.stringify(c) + "\n");
    // ok is decided in step 2, from the chart actually written — the index must never claim a
    // file that isn't there. `wait`: has earnings, but its one-time price history is still to come.
    index[t] = { a: new Date().toISOString(), ok: index[t]?.ok ?? false, ...(hasEarnings && !c.closes?.length ? { wait: true } : {}) };
    refreshed++;
  } catch (e) {
    const n = (index[t]?.err ? index[t].n || 0 : 0) + 1;
    index[t] = { a: new Date().toISOString(), ok: index[t]?.ok ?? false, err: true, n };
    failed++;
    console.log(`  ${t}: skip (${e.message})`);
  }
  writeFileSync(INDEX, JSON.stringify(Object.fromEntries(Object.entries(index).sort())) + "\n");
}

// ---- 2. recompute EVERY ticker from its cache, with this week's close from our snapshot ------
// (ONLY: just those — the lite run uploads nothing else, so the rest would be thrown away)
let wrote = 0;
for (const t of ONLY ?? tickers) {
  const path = `${CACHE}/${t}.json`;
  if (!existsSync(path)) continue;
  const c = readJson(path, {});
  const e = index[t] || {};
  if (!c.closes?.length) {
    if (!e.wait && !e.err) index[t] = { ...e, ok: false };
    continue;
  }
  const px = Number(pxOf.get(t));
  if (px > 0) {
    const lastBar = c.closes[c.closes.length - 1];
    if (lastBar[0] === thisMonday) lastBar[1] = px;
    else if (lastBar[0] < thisMonday) c.closes.push([thisMonday, px]);
    c.closes = c.closes.slice(-262);
    writeFileSync(path, JSON.stringify(c) + "\n");
  }
  const toPts = (a) => (a || []).map(([d, v]) => ({ d, v }));
  const pts = lastYears(peSeries(c.closes.map(([d]) => d), c.closes.map(([, v]) => v), toPts(c.eps), toPts(c.peq), c.reports || {}), 5);
  const { wait, ...rest } = e; // eslint-disable-line no-unused-vars
  if (!hasPeHistory(pts)) {
    if (!e.err) index[t] = { ...rest, a: e.a || new Date().toISOString(), ok: false };
    if (existsSync(`${OUT}/${t}.json`)) unlinkSync(`${OUT}/${t}.json`); // a chart it no longer has (LFMD)
    continue;
  }
  // per-file gate before writing, so one bad series is skipped instead of failing the DATA GATE
  const bad = pts.some((p, i) => (i && p.d <= pts[i - 1].d) || (p.v != null && !(p.v > 0)));
  if (bad) { console.log(`  ${t}: bad series, not written`); continue; }
  writeFileSync(
    `${OUT}/${t}.json`,
    JSON.stringify({ asOf: today, pts: pts.map((p) => (p.loss ? [p.d, null, 1] : p.high ? [p.d, null, 2] : [p.d, p.v == null ? null : +p.v.toFixed(2)])) }) + "\n",
  );
  index[t] = { ...rest, a: e.a || new Date().toISOString(), ok: true };
  wrote++;
}
writeFileSync(INDEX, JSON.stringify(Object.fromEntries(Object.entries(index).sort())) + "\n");
console.log(`done: ${refreshed} refreshed (${cnCalls} CNBC closes, ${tdCalls} Twelve Data fallbacks), ${failed} failed, ${wrote} charts written`);
