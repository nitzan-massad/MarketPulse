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
 * Should we fetch the SSR page for this ticker?
 *
 * `merge` on  → always. The page is the only source of the freshest ratings, and Phase 0 found
 *               a gain on 85% of tickers, including ones whose JSON path returned plenty.
 * `merge` off → the legacy fallback: only when JSON gave us nothing AND the payload admits it
 *               withheld rows. Kept so SSR_MERGE=0 is an exact rollback, not a new code path.
 */
export function shouldFetchPage(fc, data, merge) {
  if (merge) return true;
  return !fc.length && (data?.expertRatingsFilteredCount ?? 0) > 0;
}

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
    out.push(f);
  }
  out.sort((a, b) => (b.d || "").localeCompare(a.d || ""));
  // Same analyst on two DIFFERENT dates = two ratings, both kept (product choice). Only a
  // same-date repeat is a duplicate, and mergeKey (name|date) already collapses that.
  return out;
}

const POSITION = { buy: "Buy", hold: "Hold", sell: "Sell" };

/**
 * Every rating in TipRanks' consensus window, NAMED, from /stocks/<t>/stock-forecast/payload.json
 * (`models.ratings[]` joined to `models.experts[]` on expert.uid = _id). Unlike getData it does not
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
  const experts = new Map(m.experts.filter((e) => e?._id).map((e) => [e._id, e]));
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
    const e = experts.get(r?.expert?.uid);
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
    out.push({
      n, f, r: POSITION[String(r.position || "").toLowerCase()] ?? null,
      pt: +(same ? g.convertedPriceTarget : pt).toFixed(2), opt: Number.isFinite(opt) && opt > 0 ? opt : null, d,
    });
  }
  return out;
}

/**
 * Bring back a rating an EARLIER run recovered but this run's sources no longer show.
 *
 * Every run rebuilds the file from its own sources, so a rating that was only ever named on the
 * page vanished once newer ratings pushed it below the page's ~15-row cut (AMD Mizuho 2026-11-04,
 * NFLX Argus/Deutsche/Seaport 2026-10-21, MA Clear Street 2026-10-30 flapped in and out). A
 * previous row returns only while it is provably still current:
 *   - getData still lists an ANONYMIZED rating with the same firm and date (it exists, still the
 *     analyst's latest — getData keeps one rating per expert);
 *   - no output row already covers that firm on that date;
 *   - the analyst has no newer row in the output.
 * Anything else (a superseded or expired rating) stays gone.
 */
export function carryForward(out, prev, data) {
  const rows = Array.isArray(out) ? out : [];
  if (!Array.isArray(prev) || !prev.length) return rows;
  const hidden = new Set();
  for (const e of data?.experts || []) {
    const r0 = (e?.ratings || [])[0];
    if (!e || e.name || e.aiModel || !e.firm || !r0?.date) continue;
    hidden.add(`${firmKey({ f: e.firm })}|${String(r0.date).slice(0, 10)}`); // getData calls it `firm`
  }
  if (!hidden.size) return rows;
  const covered = new Set(rows.map((f) => `${firmKey(f)}|${f.d}`));
  const newest = new Map();
  for (const f of rows) if (f?.n) newest.set(analystKey(f), (newest.get(analystKey(f)) || "") > f.d ? newest.get(analystKey(f)) : f.d);
  const back = prev.filter((f) => f?.n && f.f && f.d && Number.isFinite(f.pt)
    && hidden.has(`${firmKey(f)}|${f.d}`) && !covered.has(`${firmKey(f)}|${f.d}`)
    && !((newest.get(analystKey(f)) || "") >= f.d));
  if (!back.length) return rows;
  return [...rows, ...back].sort((a, b) => (b.d || "").localeCompare(a.d || ""));
}


/**
 * Keep last run's target when this run's differs only by FX drift: same rating (mergeKey and
 * position) within 1%. Covers the rows getData anonymizes, which have no stable converted target
 * of their own (see forecastsFromPayload) — without it each would re-alert in the bell whenever
 * the exchange rate moved. A real revision (> 1%, or a changed rating) passes straight through.
 */
export function keepPrevTarget(rows, prev) {
  if (!Array.isArray(prev) || !prev.length) return rows;
  const old = new Map(prev.filter((p) => p?.n && Number.isFinite(p.pt)).map((p) => [mergeKey(p), p]));
  return rows.map((f) => {
    const p = old.get(mergeKey(f));
    if (!p || p.r !== f.r || p.pt === f.pt || Math.abs(f.pt - p.pt) / p.pt >= 0.01) return f;
    return { ...f, pt: p.pt, opt: p.opt ?? f.opt };
  });
}

/**
 * Which second source to use next to getData: "payload" | "page" | "none". The payload when it
 * parsed — unless it came back empty while getData admits it hid rows (then the page can still
 * name them). Otherwise the legacy page rule (shouldFetchPage). `src` is forecastsFromPayload's
 * result: null = failed / reshaped / not fetched.
 */
export function pickSource(src, fc, data, merge) {
  if (merge && Array.isArray(src) && (src.length || !((data?.expertRatingsFilteredCount ?? 0) > 0))) return "payload";
  return shouldFetchPage(fc, data, merge) ? "page" : "none";
}
