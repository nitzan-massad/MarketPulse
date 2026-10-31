// Refresh public/earnings.json — each company's NEXT earnings report, for the stock modal's
// "Earnings Thu · after close · in 25 days" line. Shape: { asOf, e: { T: [date, hour] }, recent:
// { T: date } } with date "YYYY-MM-DD" and hour "bmo" (before open) | "amc" (after close) | ""
// (not announced). `recent` holds reports from the last NEAR days, for nearEarnings() below.
//
// Source: Finnhub /calendar/earnings?from&to (free key). With no symbol it returns every company
// reporting in the window, but caps the answer at 1500 rows — so the next HORIZON days are asked
// a week at a time, and any window that comes back full is split in half and asked again.
// ~18 calls a run, paced under the free tier's 60/min. Every listed company is kept (not just the
// ranked set) because the modal opens for any ticker search finds.
//
// The bulk answer is NOT complete on the free plan: it listed 16 companies for 2026-10-14 and
// left out TSMC, which the per-symbol call dates that same day. So every RANKED ticker the bulk
// pass missed is asked on its own (~50 calls, ~1 min); the rest of the market keeps bulk coverage.
//
// ponytail: the file is lazy-fetched once per page load (~150KB raw, ~40KB gzipped). If it grows,
// split it per first letter rather than trimming companies the search can reach.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const KEY = process.env.FINNHUB_KEY || process.env.VITE_FINNHUB_KEY || "";
const OUT = "public/earnings.json";
const HORIZON = 120; // days ahead
const STEP = 7; // days per request
const CAP = 1500; // Finnhub's row cap per answer
const MIN_COMPANIES = 500; // a good run lists thousands; far fewer means a bad key or a reshaped payload
const DAY = 864e5;
const NEAR = 2; // days either side of a report that the forecast/bullbear scrapers refresh every run

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fold calendar rows into `into` ({ T: [date, hour] }), keeping each company's earliest date ≥ today. */
export function mergeNext(rows, today, into = {}) {
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = typeof r?.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
    const d = typeof r?.date === "string" ? r.date : "";
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < today) continue;
    const hour = r.hour === "bmo" || r.hour === "amc" ? r.hour : "";
    const cur = into[t];
    if (!cur || d < cur[0] || (d === cur[0] && !cur[1] && hour)) into[t] = [d, hour];
  }
  return into;
}

/** Fold calendar rows into `into` ({ T: date }): each company's latest report in [from, today). */
export function mergeRecent(rows, from, today, into = {}) {
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = typeof r?.symbol === "string" ? r.symbol.trim().toUpperCase() : "";
    const d = typeof r?.date === "string" ? r.date : "";
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < from || d >= today) continue;
    if (!into[t] || d > into[t]) into[t] = d;
  }
  return into;
}

/**
 * Tickers reporting within `days` of `today` either way, from an earnings.json object: the next
 * report from `e`, the just-passed one from `recent` (`e` has already moved on to next quarter).
 */
export function nearEarnings(file, today, days = NEAR) {
  const lo = iso(Date.parse(today) - days * DAY), hi = iso(Date.parse(today) + days * DAY);
  const out = new Set();
  for (const [t, v] of Object.entries(file?.e || {})) if (Array.isArray(v) && v[0] >= today && v[0] <= hi) out.add(t);
  for (const [t, d] of Object.entries(file?.recent || {})) if (typeof d === "string" && d >= lo && d < today) out.add(t);
  return out;
}

/** Read public/earnings.json and return nearEarnings for today; an unreadable file means none. */
export function nearEarningsNow(path = OUT) {
  try {
    return nearEarnings(JSON.parse(readFileSync(path, "utf8")), iso(Date.now()));
  } catch {
    return new Set();
  }
}

/** [from, to] day windows covering `days` days from `start`, `step` days each (inclusive ends). */
export function windows(start, days, step) {
  const out = [];
  const t0 = Date.parse(start);
  for (let i = 0; i < days; i += step) out.push([iso(t0 + i * DAY), iso(t0 + Math.min(i + step, days) * DAY - DAY)]);
  return out;
}

/** Split [from, to] into two halves, or null for a single day (it cannot be split further). */
export function halve(from, to) {
  const a = Date.parse(from), b = Date.parse(to);
  if (a >= b) return null;
  const mid = a + Math.floor((b - a) / DAY / 2) * DAY;
  return [[from, iso(mid)], [iso(mid + DAY), to]];
}

async function getSymbol(t, from, to) {
  await sleep(1100);
  const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(t)}&from=${from}&to=${to}&token=${KEY}`);
  if (!r.ok) throw new Error(`Finnhub ${t}: HTTP ${r.status}`);
  const rows = (await r.json())?.earningsCalendar;
  // a foreign company comes back under its HOME listing ("2330.TW" for TSM, "ARGX.BR" for ARGX);
  // it is the same report, so file it under the ticker we asked about
  return Array.isArray(rows) ? rows.map((row) => ({ ...row, symbol: t })) : [];
}

async function getWindow(from, to) {
  await sleep(1100);
  const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${KEY}`);
  if (!r.ok) throw new Error(`Finnhub ${from}..${to}: HTTP ${r.status}`);
  const rows = (await r.json())?.earningsCalendar;
  if (!Array.isArray(rows)) throw new Error(`Finnhub ${from}..${to}: no earningsCalendar array`);
  if (rows.length < CAP) return rows;
  const h = halve(from, to);
  if (!h) {
    console.log(`earnings: ${from} alone hits the ${CAP}-row cap — some companies that day are missing`);
    return rows;
  }
  return [...(await getWindow(...h[0])), ...(await getWindow(...h[1]))];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!KEY) throw new Error("FINNHUB_KEY is not set");
  const today = iso(Date.now());
  const e = {};
  let calls = 0;
  for (const [from, to] of windows(today, HORIZON, STEP)) {
    mergeNext(await getWindow(from, to), today, e);
    calls++;
  }
  // the last NEAR days too, so a just-reported company stays hot after `e` moves to next quarter.
  // ponytail: bulk only — a ranked ticker the bulk answer misses drops out a day or two early.
  const since = iso(Date.now() - NEAR * DAY);
  const recent = mergeRecent(await getWindow(since, iso(Date.now() - DAY)), since, today);
  calls++;
  const bulk = Object.keys(e).length;
  // ranked tickers the bulk pass missed: ask each on its own (a failure skips that one ticker)
  const ranked = JSON.parse(readFileSync("src/data/stocks.json", "utf8")).map((s) => s.t);
  const until = iso(Date.now() + (HORIZON - 1) * DAY);
  let found = 0;
  for (const t of ranked.filter((t) => !e[t])) {
    try {
      const had = !!e[t];
      mergeNext(await getSymbol(t, today, until), today, e);
      if (!had && e[t]) found++;
    } catch (err) {
      console.log(`earnings: ${err.message}`);
    }
    calls++;
  }
  const n = Object.keys(e).length;
  console.log(`earnings: bulk ${bulk} companies; per-symbol pass added ${found} ranked ones`);
  // Never replace a good file with a near-empty one; yesterday's dates are still mostly right.
  if (n < MIN_COMPANIES) throw new Error(`earnings: only ${n} companies — keeping ${OUT} as it is`);
  const sorted = Object.fromEntries(Object.keys(e).sort().map((t) => [t, e[t]]));
  const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const next = JSON.stringify({ asOf: today, e: sorted, recent }) + "\n";
  if (prev !== next) writeFileSync(OUT, next);
  console.log(`earnings.json: ${n} companies reporting by ${iso(Date.now() + HORIZON * DAY)} (${calls} windows)`);
}
