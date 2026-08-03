// Parse analyst forecasts out of TipRanks' SSR forecast page.
//
// Why this exists: the `getData` API paywall-anonymizes a fixed teaser window of rows —
// 6 AI-model rows plus up to 4 real brokers. An anonymized row keeps `firm`, `date`,
// `ratingId` and `stars`, but has `name: null` and EVERY price-target field nulled, so
// `toForecasts()` in scrape-forecasts.mjs drops it on the `!e.name` guard. On a large cap
// that's noise (AAPL: 194 experts, 4 hidden). On a micro cap whose entire coverage is
// 3-4 ratings the window swallows 100% of it and we write `[]` — which is why ~49 tickers
// showed "No analyst forecasts" while tipranks.com plainly listed them. Relaxing the
// guards recovers nothing: the targets are absent from the JSON. The SSR page has them.
//
// The payload self-reports the withholding via `expertRatingsFilteredCount`, which equals
// the count of name-null experts (verified across 21 payloads, zero mismatches). That's the
// gate for this fallback, so ~300 healthy tickers never pay the 260 KB page fetch.
//
// ponytail: regex over the stripped text, no cheerio. Anchored on the analyst-profile slug
// and on column ORDER, never on class names — TipRanks ships obfuscated per-build hashes
// (`Q9SxkXbq`). Guarded by ci/test-forecast-html.mjs against a real trimmed page. If the
// markup moves, that test fails and this returns [] — a stale file, never a corrupt one.

const ACTIONS = /^(Reiterated|Initiated|Maintained|Assigned|Upgraded|Downgraded|Reinstated)$/;

// Column order in the table: Analyst | Firm | Price Target | Position | Upside | Action | Date
export function parseForecastHtml(html) {
  const start = html.indexOf("Analyst Profile");
  if (start < 0) return [];
  const body = html.slice(start);

  // Each row links its analyst slug twice (avatar + name), so a row starts where the slug
  // CHANGES. Bounding rows this way keeps a headline's "$5" out of the next row's fields.
  const re = /\/experts\/analysts\/([a-z0-9-]+)/g;
  const marks = [];
  for (let m; (m = re.exec(body)); ) {
    if (!marks.length || marks[marks.length - 1].slug !== m[1]) marks.push({ slug: m[1], i: m.index });
  }

  const out = [];
  const seen = new Set();
  for (let k = 0; k < marks.length; k++) {
    // back up to the enclosing tag's "<": starting mid-attribute leaves a partial tag that
    // survives stripping and leaks the href into the first text token
    const from = body.lastIndexOf("<", marks[k].i);
    const chunk = body.slice(from < 0 ? marks[k].i : from,
      k + 1 < marks.length ? marks[k + 1].i : marks[k].i + 6000);

    const tok = chunk
      .replace(/<[^>]+>/g, "|")
      .replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
      .split("|").map((s) => s.trim()).filter(Boolean);

    const date = tok.find((s) => /^\d{2}\/\d{2}\/\d{2}$/.test(s));
    if (!date) continue;
    const before = tok.slice(0, tok.indexOf(date)); // the headline sits AFTER the date — exclude it
    // A REVISED target renders as two cells joined by an arrow: "$15" "→" "$0.9". The NEW
    // target is the LAST one; the first is the prior target, which is `opt`. Taking the first
    // `$` here silently published pre-revision targets — VTGN wrote pt=15 for a $0.24 stock
    // whose real target is 0.9, i.e. +6100% upside on screen. Verified against the API on 35
    // revised rows: last $ === priceTarget 35/35, first $ === oldPriceTarget 35/35.
    const money = before.filter((s) => /^\$[\d.,]+$/.test(s));
    if (!money.length) continue; // rendered "―": a real analyst with no target, and a Forecast needs one
    const num = (s) => +s.slice(1).replace(/,/g, "");
    const pt = num(money[money.length - 1]);
    const opt = money.length > 1 ? num(money[0]) : null;
    const r = before.find((s) => /^(Buy|Hold|Sell)$/.test(s));
    const [n, f] = before;
    if (!n || !f || !r || ACTIONS.test(f)) continue; // ACTIONS guard: shifted columns, don't invent a firm

    const [mm, dd, yy] = date.split("/");
    const row = { n, f, r, pt, opt, d: `20${yy}-${mm}-${dd}` };
    if (!Number.isFinite(row.pt) || row.pt <= 0) continue;
    if (row.opt != null && !Number.isFinite(row.opt)) row.opt = null;
    const key = `${row.n}|${row.f}|${row.d}|${row.pt}`;
    if (seen.has(key)) continue; // the page ships the table twice (desktop + mobile layouts)
    seen.add(key);
    out.push(row);
  }
  return out;
}

// Stars survive anonymization in the API payload, so recover them by joining firm+date.
// `opt` comes from the page itself (the "$old → $new" pair), so nothing is lost here.
export function withStars(rows, data) {
  const stars = new Map();
  for (const e of data.experts || []) {
    const r0 = (e.ratings || [])[0];
    if (!e.firm || !r0?.date) continue;
    const rk = (e.rankings || []).find((x) => x.stars != null);
    if (rk) stars.set(`${e.firm}|${String(r0.date).slice(0, 10)}`, rk.stars);
  }
  return rows
    .map((x) => ({ n: x.n, f: x.f, st: stars.get(`${x.f}|${x.d}`) ?? null, r: x.r, pt: x.pt, opt: x.opt ?? null, d: x.d }))
    .sort((a, b) => (b.d || "").localeCompare(a.d || ""));
}
