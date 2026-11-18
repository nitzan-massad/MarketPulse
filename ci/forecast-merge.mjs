// Merging the two forecast sources. Pure and import-safe — no network, no writes — so
// ci/test-forecast-merge.mjs can exercise it directly instead of mirroring it (which is what
// ci/test-forecast-gate.mjs had to do for the old inline gate).
//
// WHY THIS EXISTS. TipRanks' `getData` API paywall-anonymizes a teaser window of rows: they
// keep `firm`, `date`, `ratingId` and `stars` but null `name` and every price-target field, so
// toForecasts() drops them on `!e.name`. The window covers the FRESHEST ratings, so this is a
// recency problem on every ticker, not a micro-cap problem. The SSR page renders names and
// targets in full.
//
// Until now the page was a FALLBACK, fetched only when the JSON path yielded nothing at all
// (`!fc.length`). BIOA is the shape of the bug that leaves: 9 real broker ratings exist, 2
// survived the teaser, so the fallback never fired and 7 stayed invisible next to a label
// reading "n=9".
//
// Measured over all 418 tickers (Phase 0 of PLAN-ssr-merge.md, 2026-08-22):
//   rows 3976 -> 5669 (+42.6%)      85% of tickers gain rows
//   83% get FRESHER data            median +16 days, worst +349 (ANVS, stuck on 2025-09-03)
//   0 tickers lose rows   0 malformed rows   0 target conflicts where both sources have it

/**
 * Identity of a rating across the two sources. Analyst + date: both sources name the analyst
 * for every row that survives to here, and one analyst does not issue two ratings on a stock
 * on the same day.
 *
 * Not firm|date — two analysts at one firm on one date collide there (that collision is
 * accepted for the STAR join in forecast-html.mjs `withStars`, where the cost is a wrong star
 * count; here it would drop a whole rating).
 */
// TipRanks pads some names with invisible bidi/zero-width marks ("Daniel Zhu\u200f"), which
// String#trim() keeps — so the same analyst keyed two ways and missed the star/dedupe joins.
// ZWNJ/ZWJ (U+200C/D) are left alone: they are real spelling in Persian/Indic names.
// Keep in step with src/reviewAlerts.ts MARKS.
export const cleanName = (s) => (typeof s === "string" ? s.replace(/[\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\u061c\ufeff]/g, "").trim() : "");
export const analystKey = (f) => cleanName(f.n).toLowerCase();
// TipRanks names every unranked analyst "Unknown Analyst", so for them the firm is the identity —
// two of them on one date (different firms) are two ratings, not a duplicate.
const UNKNOWN = "unknown analyst";
const firmKey = (f) => cleanName(f.f).toLowerCase();
export const mergeKey = (f) => `${analystKey(f)}|${f.d || ""}${analystKey(f) === UNKNOWN ? `|${firmKey(f)}` : ""}`;

/**
 * Union of the SSR rows and the JSON rows, newest first.
 *
 * Precedence, per PLAN-ssr-merge.md:
 *   pt, opt, n, f, d, r  -> SSR. It is the rendered truth, and the JSON copy of these is
 *                           nulled for exactly the anonymized rows this path exists to recover.
 *   st (stars)           -> JSON. SSR does not render them. `withStars` already joins most of
 *                           them on firm|date before we get here; this backfills on the
 *                           stronger name|date key for any it missed.
 *
 * ADDITIVE PER ANALYST, and that is load-bearing: a truncated FlareSolverr read parses to a valid
 * PREFIX, so under union it can only shrink the GAIN, never lose a row. That property is why
 * PLAN-ssr-merge.md's row-count guardrail was dropped rather than fixed — see the note in
 * ci/README.md. Verified across 418 tickers: 0 lost a row.
 */
export function mergeForecasts(ssr, json) {
  const jsonRows = Array.isArray(json) ? json : [];
  const ssrRows = Array.isArray(ssr) ? ssr : [];

  const starFor = new Map();
  const starByName = new Map(); // stars belong to the analyst, not the rating
  for (const f of jsonRows) if (f?.n && f.st != null) { starFor.set(mergeKey(f), f.st); starByName.set(analystKey(f), f.st); }
  // ...in both directions: a page top-up row (json side) takes its analyst's star from the payload row
  for (const f of ssrRows) if (f?.n && f.st != null && !starByName.has(analystKey(f))) starByName.set(analystKey(f), f.st);

  const out = [];
  const seen = new Set();
  for (const f of ssrRows) {
    if (!f?.n) continue; // a nameless SSR row is a parse artefact, not a rating
    const k = mergeKey(f);
    if (seen.has(k)) continue; // the page renders an analyst's avatar and name; dedupe anyway
    seen.add(k);
    const st = f.st ?? starFor.get(k) ?? starByName.get(analystKey(f));
    out.push(st != null && f.st == null ? { ...f, st } : f);
  }
  for (const f of jsonRows) {
    // An anonymized JSON row never joins on its own: no name to key on and no target to show.
    // Its only contribution is `st`, already harvested above and by withStars.
    if (!f?.n) continue;
    const k = mergeKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    const st = f.st ?? starByName.get(analystKey(f));
    out.push(st != null && f.st == null ? { ...f, st } : f);
  }
  out.sort((a, b) => (b.d || "").localeCompare(a.d || ""));
  // Same analyst on two dates stays two rows HERE; the scraper keeps only the newest
  // (latestPerAnalyst) right before it writes, after carry-forward.
  return out;
}

const POSITION = { buy: "Buy", hold: "Hold", sell: "Sell" };

/**
 * Every rating in TipRanks' consensus window, NAMED, from /stocks/<t>/stock-forecast/payload.json
 * (`models.ratings[]` joined to `models.experts[]` on expert.uid/id = _id or uid). Unlike getData it does not
 * anonymize the freshest ~10 brokers, and unlike the SSR page it is not cut at ~15 rows — on
 * 2026-11-07 MA had 46 ratings here, including Clear Street (anonymized in getData, below row 15 on
 * the page) and Deutsche Bank's "Unknown Analyst" row (getData files those under
 * `notRankedExperts[]`, which toForecasts never read). Returns null when the payload is not this
 * shape, so the caller falls back to the page.
 *
 * Dropped: TipRanks' own AI models (firm "TipRanks - OpenAI" etc. — toForecasts drops them via
 * `aiModel`), ratings without a target (a Forecast needs one), a rating whose expert is missing.
 * `priceTarget` is the USD-converted value, the same one getData calls convertedPriceTarget.
 *
 * FIRM: the payload's firm sits on the expert PROFILE (where the analyst works now), not on the
 * rating. AMD 2026-11-04 David O'Connor read "Exane BNP Paribas" here but "Piper Sandler" in getData
 * and on the page; DVN/OVV/BMRN had the same skew. getData keeps a per-rating firm on every expert,
 * anonymized ones included, keyed by `eUid` = the payload's `expert.uid` — pass `data` and that
 * firm wins. Experts getData does not list keep the profile firm (no better source).
 */
export function forecastsFromPayload(fj, ticker, data) {
  const m = fj?.models;
  if (!Array.isArray(m?.ratings) || !Array.isArray(m?.experts)) return null;
  // Indexed by BOTH ids: the live record is `_id: "analyst|<n>"` with the sha in `uid`, and a rating
  // names it by `expert.uid` (sha) — an `_id`-only index dropped AAPL's Jack Zhou (2026-11-18).
  const experts = new Map();
  for (const e of m.experts) for (const id of [e?._id, e?.uid]) if (id != null && !experts.has(id)) experts.set(id, e);
  const firmOf = new Map();
  const gd = new Map(); // eUid -> getData's latest rating (one per expert)
  for (const e of [...(data?.experts || []), ...(data?.notRankedExperts || [])]) {
    if (!e?.eUid) continue;
    if (typeof e.firm === "string" && e.firm.trim()) firmOf.set(e.eUid, e.firm.trim());
    if ((e.ratings || [])[0]) gd.set(e.eUid, e.ratings[0]);
  }
  const out = [];
  for (const r of m.ratings) {
    if (ticker && r?.object?.ticker && r.object.ticker !== ticker) continue; // a peer's rating
    const e = experts.get(r?.expert?.uid ?? r?.expert?.id);
    const n = cleanName(e?.name);
    const f = firmOf.get(r?.expert?.uid) ?? (typeof e?.firm === "string" ? e.firm.trim() : "");
    if (!n || !f || /^TipRanks\b/i.test(f)) continue;
    const pt = Number(r.priceTarget?.value);
    if (!Number.isFinite(pt) || pt <= 0) continue;
    const d = String(r.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    // TARGETS: the payload converts non-USD targets at TODAY's FX (SHOP Doug Taylor 128.9995 here
    // vs 127.537 in getData), so they wobble run to run — and src/reviewAlerts.ts keys a review on
    // n|f|d|r|pt, so every wobble would ring the bell as a "new review". getData's
    // convertedPriceTarget is stable; use it whenever getData names this same rating.
    const g = gd.get(r?.expert?.uid);
    const same = g && String(g.date || "").slice(0, 10) === d && Number.isFinite(g.convertedPriceTarget) && g.convertedPriceTarget > 0;
    const opt = same ? Number(g.convertedOldPriceTarget) : Number(r.oldPriceTarget);
    // STARS: TipRanks' own CSV formula, round(5 * rank.rank, 1). The `analyst|<n>` record (rating.expert.id)
    // is the live one; the sha record (expert.uid) is an older snapshot, kept as the fallback.
    const rk = experts.get(r?.expert?.id)?.rank?.rank ?? e?.rank?.rank;
    const st = Number.isFinite(rk) ? Math.round(5 * rk * 10) / 10 : null;
    out.push({
      n, f, r: POSITION[String(r.position || "").toLowerCase()] ?? null,
      pt: +(same ? g.convertedPriceTarget : pt).toFixed(2), opt: Number.isFinite(opt) && opt > 0 ? opt : null, d, st,
    });
  }
  return out;
}


/**
 * A stored rating is final: when this run shows the same analyst (mergeKey: name + date, plus firm for
 * "Unknown Analyst") and the same rating as a previous row, keep the previous row's firm, target and old target and take everything else
 * (rating, stars, ...) from the new row. The payload re-converts non-USD targets at today's FX and
 * its profile firm drifts when an analyst moves, so without this the same rating would re-alert in
 * the bell on every wobble (this subsumes the old keepPrevTarget sub-1% drift rule). A new date is
 * a new review and passes through.
 */
export function keepPrevRating(rows, prev) {
  if (!Array.isArray(prev) || !prev.length) return rows;
  const old = new Map(prev.filter((p) => p?.n && p.d).map((p) => [mergeKey(p), p]));
  return rows.map((f) => {
    const p = old.get(mergeKey(f));
    // a changed rating on the same date is a correction, i.e. a new review: pass it through whole
    return p && p.r === f.r ? { ...f, f: p.f, pt: p.pt, opt: p.opt ?? f.opt } : f;
  });
}

/** One row per analyst (name + firm; Unknown Analyst = per firm): the newest. Product choice
 *  (2026-11-16) — a newer rating replaces the analyst's older one instead of sitting beside it. */
export function latestPerAnalyst(rows) {
  const seen = new Set();
  return [...(rows || [])].sort((a, b) => (b.d || "").localeCompare(a.d || ""))
    .filter((f) => { const k = `${analystKey(f)}|${firmKey(f)}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Keep last run's NEWER rating for an analyst this run still lists, but only at an older date.
 * Without it, latestPerAnalyst would let a source regression (the page-recovered 11-15 row falls
 * out, the payload still has 11-11) swap the old row back in — and the bell, which forgot 11-11
 * when 11-15 replaced it, would ring for it as new. Never adds an analyst this run lacks.
 */
export function keepNewerPrev(out, prev) {
  const rows = Array.isArray(out) ? out : [];
  if (!Array.isArray(prev) || !prev.length) return rows;
  const id = (f) => `${analystKey(f)}|${firmKey(f)}`;
  const newest = new Map();
  for (const f of rows) if (f?.n && (newest.get(id(f)) ?? "") < (f.d || "")) newest.set(id(f), f.d || "");
  const back = prev.filter((f) => f?.n && f.d && Number.isFinite(f.pt) && newest.has(id(f)) && newest.get(id(f)) < f.d);
  if (!back.length) return rows;
  return [...rows, ...back].sort((a, b) => (b.d || "").localeCompare(a.d || ""));
}

// One analyst's identity for the carry/top-up joins: the name, or the firm for "Unknown Analyst".
const who = (f) => (analystKey(f) === UNKNOWN ? `${UNKNOWN}|${firmKey(f)}` : analystKey(f));
const newestBy = (rows) => {
  const m = new Map();
  for (const f of rows || []) if (f?.n && (m.get(who(f)) ?? "") < (f.d || "")) m.set(who(f), f.d || "");
  return m;
};
const sinceDay = (now, days) => new Date(now - days * 864e5).toISOString().slice(0, 10);
const realRow = (f) => f?.n && f.d && Number.isFinite(f.pt);

/** Fill `st == null` from `prev` by analystKey: stars belong to the analyst, not the rating, so a
 *  page-only row (the page renders none) keeps the star the analyst had last run. */
export function carryStars(rows, prev) {
  if (!Array.isArray(prev) || !prev.length) return rows;
  const star = new Map();
  for (const p of prev) if (p?.n && p.st != null && !star.has(analystKey(p))) star.set(analystKey(p), p.st);
  return rows.map((f) => (f.st == null && star.has(analystKey(f)) ? { ...f, st: star.get(analystKey(f)) } : f));
}

/**
 * Analysts (names) whose NEWEST payload rating has no price target and is newer than their row in
 * `fileRows`. The payload names the rating but withholds the target; the forecast page may render
 * it, so these — and only these, on a payload that parsed — are worth the ~11s page fetch.
 * An analyst with NO file row never counts: the payload keeps one rating per analyst, so there is
 * no older target the page could add, and live (2026-11-18) 13 of 16 target-less newest ratings on
 * AAPL/TWLO/UBER were such analysts — counting them fetched the page on every ticker, every run.
 */
function hiddenEntries(fj, ticker, fileRows) {
  const m = fj?.models;
  if (!Array.isArray(m?.ratings) || !Array.isArray(m?.experts)) return [];
  const experts = new Map();
  for (const e of m.experts) for (const id of [e?._id, e?.uid]) if (id != null && !experts.has(id)) experts.set(id, e);
  const latest = new Map(); // who -> { n, d, pt }
  for (const r of m.ratings) {
    if (ticker && r?.object?.ticker && r.object.ticker !== ticker) continue;
    const e = experts.get(r?.expert?.uid ?? r?.expert?.id);
    const n = cleanName(e?.name), f = typeof e?.firm === "string" ? e.firm.trim() : "";
    const d = String(r?.date || "").slice(0, 10);
    if (!n || !f || /^TipRanks\b/i.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const k = who({ n, f });
    if ((latest.get(k)?.d ?? "") < d) latest.set(k, { n, d, pt: Number(r.priceTarget?.value) });
  }
  const have = newestBy(fileRows);
  return [...latest.entries()]
    .filter(([k, x]) => !(Number.isFinite(x.pt) && x.pt > 0) && have.has(k) && have.get(k) < x.d)
    .map(([k, x]) => ({ n: x.n, key: `${k}|${x.d}` }));
}
export const hiddenTargets = (fj, ticker, fileRows) => hiddenEntries(fj, ticker, fileRows).map((x) => x.n);
/** hiddenTargets as `analystKey|date` keys (Unknown Analyst: `unknown analyst|firm|date`), the
 *  identity recorded in `_pageTried.json` so one hidden rating costs one page fetch, not one per run. */
export const hiddenTargetKeys = (fj, ticker, fileRows) => hiddenEntries(fj, ticker, fileRows).map((x) => x.key);

/** Fetch the page? Always when the payload failed; else only for a hidden target not tried yet. */
export function pageNeeded({ srcOk, hidden, tried }) {
  if (!srcOk) return true;
  const done = new Set(tried || []);
  return (hidden || []).some((k) => !done.has(k));
}

/** Did the payload work? A fetch/parse failure (null) did not — and neither did 0 rows while last
 *  run's file has some: that is a reshape or an id-scheme change, not every analyst vanishing, and
 *  treating it as success would shrink the file to its last 92 days. */
export const payloadOk = (src, prev) => src !== null && (src.length > 0 || !(Array.isArray(prev) && prev.length));

/**
 * Page rows worth adding next to the payload's: per analyst, those newer than our newest row for
 * them ("" = analyst absent), dated within `days` — older page history would only flap in on the
 * runs that fetch the page and out on the rest (carryRecentPrev keeps the same window).
 * Returns [{ who, since }] for topUpRows.
 */
export function missingOf(rows, pageRows, now = Date.now(), days = 92) {
  const have = newestBy(rows);
  const since = sinceDay(now, days);
  const out = new Map();
  for (const p of pageRows || []) {
    if (!p?.n || !p.d || p.d < since) continue;
    const k = who(p);
    if (p.d > (have.get(k) ?? "")) out.set(k, have.get(k) ?? "");
  }
  return [...out].map(([k, s]) => ({ who: k, since: s }));
}

/** The page rows missingOf asked for: that analyst's, newer than our newest row for them. */
export function topUpRows(pageRows, missing) {
  const want = new Map((missing || []).map((m) => [m.who, m.since ?? ""]));
  return (pageRows || []).filter((r) => want.has(who(r)) && (r.d || "") > want.get(who(r)));
}

/**
 * Last run's rows for analysts this run lacks, rated within `days` of `now` — or all of them with
 * `all` (the payload failed: never let a fetch failure shrink the file). Covers the page-recovered
 * rows on runs that skip the page, and an analyst a payload transiently omits. Never duplicates an
 * analyst already in `rows`.
 */
export function carryRecentPrev(rows, prev, { now = Date.now(), days = 92, all = false } = {}) {
  const out = Array.isArray(rows) ? rows : [];
  if (!Array.isArray(prev) || !prev.length) return out;
  const since = sinceDay(now, days);
  const present = new Set(out.filter((f) => f?.n).map(who));
  const seen = new Set();
  const back = prev.filter((f) => {
    if (!realRow(f) || present.has(who(f)) || (!all && f.d < since)) return false;
    const k = `${who(f)}|${f.d}`; if (seen.has(k)) return false; seen.add(k); return true;
  });
  if (!back.length) return out;
  return [...out, ...back].sort((a, b) => (b.d || "").localeCompare(a.d || ""));
}
