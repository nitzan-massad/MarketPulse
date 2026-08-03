// Self-check for the SSR-forecast-page parser (ci/forecast-html.mjs).
// Run: node ci/test-forecast-html.mjs   (no network — everything is a committed fixture)
//
// FIXTURES
//   adct-forecast.html / vtgn-forecast.html  real trimmed tipranks.com/stocks/<t>/forecast
//     responses. ADCT is the ticker that exposed the original bug: 4 analysts on the page,
//     all 4 anonymized in the getData API, so we wrote [] and the modal claimed "No analyst
//     forecasts for this stock". VTGN is the ticker that exposed the revised-target bug.
//   edge-*-forecast.html  SYNTHETIC: each row group is a byte-for-byte copy of ADCT's first
//     row group with only the analyst slug/name, firm, price-target cell, rating, action,
//     date and headline substituted (and the 10 repeated star glyphs trimmed to 2). Column
//     order, nesting and the obfuscated per-build class hashes are unchanged, so they still
//     exercise the real selector surface. We cannot fetch new real pages: tipranks.com 403s
//     direct and FlareSolverr isn't available in CI.
//
// THE THREE BUGS THIS PARSER HAS SHIPPED, each with a named regression below:
//   1. chunk slicing started mid-attribute -> the analyst href leaked into the firm field
//   2. the page ships the table TWICE (desktop + mobile) -> every row was duplicated
//   3. a revision renders "$15 → $0.9" and we took the FIRST $ -> VTGN published pt=15 for
//      a $0.24 stock (+6100% upside on screen)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseForecastHtml, withStars } from "./forecast-html.mjs";

const fx = (name) => readFileSync(new URL(`./fixtures/${name}-forecast.html`, import.meta.url), "utf8");
const REAL = ["adct", "vtgn"];
const SYNTH = ["edge-numbers", "edge-shapes", "edge-entities", "edge-dates"];

// Every row the parser is ever allowed to emit must satisfy this. Used on the real fixtures,
// on the synthetic ones, and on every mutated/markup-changed input — the point of the
// "degrade to a stale file, never a corrupt one" contract is that there is no input for
// which a MALFORMED row comes out. Emitting fewer rows is fine; emitting junk is not.
function assertWellFormed(rows, label) {
  assert.ok(Array.isArray(rows), `${label}: must return an array`);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r), ["n", "f", "r", "pt", "opt", "d"], `${label}: parser row shape`);
    for (const [k, v] of Object.entries(r)) {
      assert.ok(!/[<>|]|experts\/analysts|href=|class=/.test(String(v)), `${label}: ${k} leaked markup: ${v}`);
    }
    assert.equal(typeof r.n, "string");
    assert.equal(typeof r.f, "string");
    assert.ok(r.n.length > 0 && r.f.length > 0, `${label}: n/f must be non-empty`);
    assert.match(r.r, /^(Buy|Hold|Sell)$/, `${label}: rating must be Buy|Hold|Sell, got ${r.r}`);
    assert.equal(typeof r.pt, "number");
    assert.ok(Number.isFinite(r.pt), `${label}: pt must be finite, got ${r.pt}`);
    assert.ok(r.pt > 0, `${label}: pt must be positive, got ${r.pt}`);
    assert.ok(r.opt === null || (typeof r.opt === "number" && Number.isFinite(r.opt)),
      `${label}: opt must be null or a finite number, got ${r.opt}`);
    assert.match(r.d, /^\d{4}-\d{2}-\d{2}$/, `${label}: date must be YYYY-MM-DD, got ${r.d}`);
  }
}

/* ===================================================================== ADCT
   Real page, no revised rows. 4 analysts listed; H.C. Wainwright's target renders as
   "―" and a Forecast needs a target. */
const rows = parseForecastHtml(fx("adct"));
assertWellFormed(rows, "adct");
assert.equal(rows.length, 3, `expected 3 parsed rows, got ${rows.length}`);
assert.deepEqual(rows.map((r) => r.f), ["RBC Capital", "Guggenheim", "Stephens"]);
assert.deepEqual(rows[0], { n: "Leonid Timashev", f: "RBC Capital", r: "Hold", pt: 2, opt: null, d: "2026-07-07" });
assert.equal(rows.find((r) => r.f === "Guggenheim").pt, 10);
assert.equal(rows.find((r) => r.f === "Stephens").pt, 5);
assert.ok(!rows.some((r) => r.f.includes("Wainwright")), "row with no price target must be skipped");

// BUG 1 REGRESSION — chunk slicing started mid-attribute, so the analyst href survived
// tag-stripping and landed in the firm field. assertWellFormed's markup scan is the primary
// guard; this pins the exact field values so a leak can't hide behind a loose regex.
assert.equal(rows[0].f, "RBC Capital", "BUG 1: firm must be the firm cell, not an href fragment");
assert.equal(rows[0].n, "Leonid Timashev", "BUG 1: analyst name must be the name cell");

// Stephens' headline is "…price target lowered to $5 from $8 at Stephens" — real proof that
// a $ AFTER the date column cannot reach `money`. $8 must never become pt or opt.
const stephens = rows.find((r) => r.f === "Stephens");
assert.equal(stephens.pt, 5, "a $ in the headline must not become the target");
assert.equal(stephens.opt, null, "a $ in the headline must not become opt");

/* ===================================================================== VTGN
   Real page, ships the table TWICE (5 analysts x 2 layouts = 10 analyst-link marks) and
   contains two REVISED rows. */
const v = parseForecastHtml(fx("vtgn"));
assertWellFormed(v, "vtgn");
const by = (n) => v.find((r) => r.n === n);
assert.equal(v.length, 3, `expected 3 VTGN rows, got ${v.length}`);

// BUG 3 REGRESSION — "$15" "→" "$0.9": the NEW target is the LAST $, the first is `opt`.
// Verified against the API on 35 revised rows: last $ === priceTarget 35/35, first $ ===
// oldPriceTarget 35/35.
assert.deepEqual(by("Andrew Tsai"), { n: "Andrew Tsai", f: "Jefferies", r: "Hold", pt: 0.9, opt: 15, d: "2025-12-17" });
assert.deepEqual(by("Elemer Piros"), { n: "Elemer Piros", f: "Lucid Capital", r: "Hold", pt: 1, opt: 19, d: "2025-12-17" });
// stated as a direction-free invariant too: on a revision pt is whichever came AFTER the
// arrow, never "the bigger one" and never the first one.
for (const r of v) {
  if (r.opt != null) {
    assert.notEqual(r.pt, r.opt, "pt and opt must differ on a revision");
    assert.ok(r.pt < r.opt, "BUG 3: both VTGN revisions are cuts — pt must be the post-arrow value");
  }
}
// unrevised row in the same table: single "$", so opt stays null
assert.equal(by("Paul Matteis").pt, 1);
assert.equal(by("Paul Matteis").opt, null);
// two rows render "―" (William Blair, Maxim Group) and must both be skipped
assert.ok(!v.some((r) => r.f === "William Blair"), "no-target row must be skipped");
assert.ok(!v.some((r) => r.f === "Maxim Group"), "no-target row must be skipped");

// BUG 2 REGRESSION — the page ships the table twice. VTGN's raw markup carries 10 analyst
// link runs; the deduped output must carry 5 distinct analysts (3 of which have targets).
assert.equal((fx("vtgn").match(/\/experts\/analysts\/[a-z0-9-]+/g) || []).length, 20,
  "fixture sanity: VTGN really does ship the analyst links twice per layout");
const vkeys = v.map((r) => `${r.n}|${r.f}|${r.d}|${r.pt}`);
assert.equal(new Set(vkeys).size, vkeys.length, "BUG 2: duplicate rows across the two table layouts");
assert.equal(new Set(v.map((r) => r.n)).size, v.length, "BUG 2: an analyst must appear at most once");
// ...and the collapse must NOT be over-eager: three VTGN analysts share 12/17/25, two of
// which have targets. Same date + different analyst is two genuinely distinct forecasts.
assert.equal(v.filter((r) => r.d === "2025-12-17").length, 2, "distinct analysts on one date must not collapse");
assert.deepEqual(v.filter((r) => r.d === "2025-12-17").map((r) => r.n), ["Andrew Tsai", "Elemer Piros"]);

/* ============================================================= NUMBER SHAPES
   edge-numbers: comma thousands, decimal, sub-dollar, zero, absurdly large, negative,
   and a non-numeric "$1.2.3". A Forecast is only meaningful with a finite POSITIVE pt, so
   zero/negative/non-finite must be dropped, not emitted as 0 / NaN / -5. */
{
  const n = parseForecastHtml(fx("edge-numbers"));
  assertWellFormed(n, "edge-numbers");
  const pt = (name) => n.find((r) => r.n === name);
  assert.equal(pt("Comma Thousands").pt, 1120, "$1,120 -> 1120 (comma stripped, not truncated at the comma)");
  assert.equal(pt("Decimal Target").pt, 12.5, "$12.50 -> 12.5");
  assert.equal(pt("Sub Dollar").pt, 0.9, "$0.9 -> 0.9, not 9 and not 0");
  assert.equal(pt("Absurd Target").pt, 999999999, "an absurd but finite target is still emitted");
  assert.equal(pt("Zero Target"), undefined, "$0 is not a forecast — must be dropped, not emitted as pt:0");
  assert.equal(pt("Negative Target"), undefined, "$-5 must be dropped, not emitted as pt:-5");
  assert.equal(pt("Nonfinite Target"), undefined, "$1.2.3 parses to NaN and must be rejected, never emitted");
  assert.equal(n.length, 4, `expected 4 usable numeric rows, got ${n.length}`);
  // the whole point: no emitted pt is ever 0, negative, NaN or Infinity
  for (const r of n) assert.ok(Number.isFinite(r.pt) && r.pt > 0, `pt out of contract: ${r.pt}`);
}

/* ================================================================ ROW SHAPES
   edge-shapes: missing rating, missing firm, missing analyst name, a column shift that
   puts an ACTION verb where the firm belongs, a headline carrying both a $ amount and a
   MM/DD/YY date, and a no-target ("―") row whose headline carries a $ amount. Two control
   rows bracket the broken ones so any field bleed shows up as a wrong control. */
{
  const s = parseForecastHtml(fx("edge-shapes"));
  const get = (name) => s.find((r) => r.n === name);

  // controls survive intact — nothing bled in from the broken rows around them
  assert.deepEqual(get("Control One"), { n: "Control One", f: "Control Capital", r: "Buy", pt: 8, opt: null, d: "2026-07-20" });
  assert.deepEqual(get("Control Two"), { n: "Control Two", f: "Control Capital", r: "Sell", pt: 2, opt: null, d: "2026-07-14" });

  assert.equal(get("No Rating"), undefined, "a row with no Buy/Hold/Sell cell must be dropped");
  assert.equal(get("Shifted Cols"), undefined, "an ACTION verb in the firm column means shifted columns — drop it");

  // headline noise must not reach any field of its own row
  assert.deepEqual(get("Noisy Headline"), { n: "Noisy Headline", f: "Noise Research", r: "Hold", pt: 3, opt: null, d: "2026-07-15" });
  assert.equal(get("Noisy Headline").d, "2026-07-15", "a MM/DD/YY in the headline must not become the date");
  assert.ok(!s.some((r) => r.pt === 99 || r.pt === 120), "a $ in the headline must never become a target");
  assert.ok(!s.some((r) => r.d === "2024-01-02"), "a date in the headline must never become the row date");

  // the dangerous combination: "―" target + a $ in the headline. This row has no target at
  // all, so it must be dropped — NOT rescued with the headline's $99.
  assert.equal(get("Dash Dollar"), undefined, "no-target row must be dropped even when its headline has a $");

  // FINDING (reported, not fixed): with the firm cells empty the columns shift left and the
  // price-target token lands in `f`. The row is emitted with f: "$6" — a corrupt firm. The
  // ACTIONS guard only catches a shift that lands an ACTION verb there, not a $ amount.
  // Not reachable from today's real pages (TipRanks always renders a firm), hence pinned
  // here rather than fixed. If forecast-html.mjs gains a "$"-in-firm guard, flip this to
  // `assert.equal(get("No Firm"), undefined)`.
  assert.equal(get("No Firm").f, "$6", "documented gap: an empty firm cell shifts the target into `f`");

  // FINDING (reported, not fixed): with the analyst-name span empty, the firm (rendered
  // twice) fills both `n` and `f`. Degraded but not corrupt — the app shows the firm as the
  // analyst name. Same reasoning as above.
  assert.deepEqual(get("Nameless Bank"), { n: "Nameless Bank", f: "Nameless Bank", r: "Buy", pt: 5, opt: null, d: "2026-07-17" },
    "documented gap: an empty analyst-name cell makes n fall back to the firm");

  assert.equal(s.length, 5, `expected 5 rows from edge-shapes, got ${s.length}`);
  // assertWellFormed intentionally runs LAST here: the two documented gaps above are the
  // only rows in the suite it would otherwise be asked to bless, and it still holds for
  // them (both are well-typed, just semantically wrong) — so the contract is unbroken.
  assertWellFormed(s, "edge-shapes");
}

/* ===================================================================== DATES
   MM/DD/YY -> YYYY-MM-DD via a literal "20" + YY prefix, with no calendar validation. */
{
  const d = parseForecastHtml(fx("edge-dates"));
  assertWellFormed(d, "edge-dates");
  const get = (name) => d.find((r) => r.n === name);
  // year rollover across the Dec/Jan boundary
  assert.equal(get("Rollover Dec").d, "2025-12-31", "12/31/25 -> 2025-12-31");
  assert.equal(get("Rollover Jan").d, "2026-01-02", "01/02/26 -> 2026-01-02");
  assert.ok(get("Rollover Dec").d < get("Rollover Jan").d, "string compare must order the rollover correctly");

  // WHAT THE CODE ACTUALLY DOES with a malformed / out-of-range date (measured, not assumed):
  // the regex is purely positional (^\d{2}/\d{2}/\d{2}$) and the year is a literal "20"+YY,
  // so there is NO calendar or range validation whatsoever. All three of these are emitted.
  // FINDING (reported, not fixed): a broken feed can therefore publish an unsortable or
  // never-expiring date. 2099 sorts to the top of the newest-first list forever, and
  // "2026-13-45" is an Invalid Date in the UI. Low likelihood (TipRanks renders real dates)
  // but zero cost to guard. Pinned here so a future guard is a deliberate test change.
  assert.equal(get("Impossible Date").d, "2026-13-45", "documented gap: 13/45/26 passes through unvalidated");
  assert.equal(get("Ancient Date").d, "2014-07-07", "documented gap: a pre-2015 date is not rejected");
  assert.equal(get("Future Date").d, "2099-07-07", "documented gap: a future date is not rejected");
  assert.equal(d.length, 5);

  // ...but on every REAL page we have, the sane-range invariant does hold. This is the
  // assertion that would catch a genuine date regression (century prefix, MM/DD swap,
  // two-digit-year drift) on real markup.
  const today = new Date().toISOString().slice(0, 10);
  for (const name of REAL) {
    for (const r of parseForecastHtml(fx(name))) {
      assert.ok(r.d >= "2015-01-01", `${name}: pre-2015 date on a real page: ${r.d}`);
      assert.ok(r.d <= today, `${name}: future date on a real page: ${r.d}`);
      const [, mm, dd] = r.d.split("-");
      assert.ok(+mm >= 1 && +mm <= 12, `${name}: month out of range: ${r.d}`);
      assert.ok(+dd >= 1 && +dd <= 31, `${name}: day out of range: ${r.d}`);
    }
  }
}

/* ============================================================ HTML ENTITIES
   The parser decodes exactly four forms: &amp; &#x27;/&#39; &quot; &nbsp;. */
{
  const e = parseForecastHtml(fx("edge-entities"));
  assertWellFormed(e, "edge-entities");
  const get = (name) => e.find((r) => r.n === name);
  // &amp; — real case: "Ladenburg Thalmann & Co."
  assert.equal(get("Michael Higgins").f, "Ladenburg Thalmann & Co.", "&amp; must decode to &");
  assert.ok(!e.some((r) => /&amp;|&quot;|&nbsp;/.test(r.f + r.n)), "no named entity may survive into output");
  // &#39; and &quot;
  assert.equal(e.find((r) => r.f.startsWith("O'Neil")).f, 'O\'Neil "Alpha" Group', "&#39; -> ' and &quot; -> \"");
  // &nbsp; becomes a plain space (and must not leave a stray U+00A0)
  assert.equal(get("Ítalo Müller-Sørensen").f, "Nordea Markets", "&nbsp; -> plain space");
  assert.ok(!/ /.test(get("Ítalo Müller-Sørensen").f), "no raw NBSP in output");
  // literal unicode passes through unchanged
  assert.equal(get("Ítalo Müller-Sørensen").n, "Ítalo Müller-Sørensen", "unicode analyst name survives");

  // FINDING (reported, not fixed): only those four entity forms are decoded. Any other
  // numeric entity — e.g. &#225; for "á" — reaches the JSON raw and renders literally in
  // the modal. The two real fixtures contain no entities at all, so this is unproven on
  // real markup; it is a plausible failure for accented analyst names.
  assert.equal(e.find((r) => r.n.includes("Brien")).n, "Se&#225;n O'Brien",
    "documented gap: numeric entities other than &#39;/&#x27; are not decoded");
}

/* ============================================================ DEDUP DETAILS
   Two axes: rows that differ ONLY by layout must collapse (VTGN, above); rows that differ
   by analyst must not. Here: two DISTINCT analysts at the SAME firm on the SAME date. */
{
  const e = parseForecastHtml(fx("edge-entities"));
  const same = e.filter((r) => r.f === "Ladenburg Thalmann & Co.");
  assert.equal(same.length, 2, "two different analysts at one firm on one date must both survive");
  assert.deepEqual(same.map((r) => r.n), ["Michael Higgins", "Collide One"]);
  assert.equal(new Set(same.map((r) => r.d)).size, 1, "fixture sanity: they really do share a date");
}

/* ================================================================= withStars
   Joins stars from the API payload on `firm|date`, emits the app's Forecast shape
   (n, f, st, r, pt, opt, d) newest-first. Stars survive anonymization in the JSON; opt
   comes from the page's "$old → $new" pair. */
{
  const withst = withStars(rows, {
    experts: [
      { firm: "RBC Capital", ratings: [{ date: "2026-07-07T00:00:00" }], rankings: [{ stars: 4.9 }] },
      { firm: "Guggenheim", ratings: [{ date: "2026-06-30T00:00:00" }], rankings: [{ stars: 3.1 }] },
    ],
  });
  assert.equal(withst[0].st, 4.9, "HIT: stars joined on firm+date");
  assert.equal(withst[1].st, 3.1);
  assert.equal(withst[2].st, null, "MISS: no matching API row -> null, never undefined");
  assert.ok(withst.every((r) => r.st !== undefined), "st must never be undefined");
  assert.deepEqual(withst.map((r) => r.d), ["2026-07-07", "2026-06-30", "2026-06-04"], "newest-first");
  for (const r of withst) {
    assert.deepEqual(Object.keys(r), ["n", "f", "st", "r", "pt", "opt", "d"], "app Forecast key order/shape");
    assert.equal(r.opt, null);
  }
  // input must not be mutated (the scraper reuses `rows` on no other path, but a mutating
  // join would be a landmine)
  assert.deepEqual(Object.keys(rows[0]), ["n", "f", "r", "pt", "opt", "d"], "withStars must not mutate its input rows");

  // FIRM-NAME MISMATCH: the join is an exact string match, so "RBC Capital Markets" in the
  // API vs "RBC Capital" on the page yields no stars rather than a wrong join.
  assert.equal(withStars(rows, {
    experts: [{ firm: "RBC Capital Markets", ratings: [{ date: "2026-07-07" }], rankings: [{ stars: 5 }] }],
  })[0].st, null, "a near-miss firm name must not join");
  // DATE MISMATCH on a matching firm
  assert.equal(withStars(rows, {
    experts: [{ firm: "RBC Capital", ratings: [{ date: "2026-07-06" }], rankings: [{ stars: 5 }] }],
  })[0].st, null, "right firm, wrong date must not join");

  // stars: 0 is a legitimate value and must survive `?? null` as 0, not become null
  assert.equal(withStars(rows, {
    experts: [{ firm: "RBC Capital", ratings: [{ date: "2026-07-07T00:00:00" }], rankings: [{ stars: 0 }] }],
  })[0].st, 0, "stars:0 must stay 0, not collapse to null");
  // rankings entries with stars:null are skipped in favour of the first ranked one
  assert.equal(withStars(rows, {
    experts: [{ firm: "RBC Capital", ratings: [{ date: "2026-07-07" }], rankings: [{ stars: null }, { stars: 3.3 }] }],
  })[0].st, 3.3, "first non-null stars ranking wins");

  // COLLISION: two experts at the same firm on the same date. The map is keyed on
  // firm|date only, so the LAST expert in payload order wins and both page rows get that
  // same value. Documented, not fixed — stars are cosmetic and the API gives us no page
  // row -> expert identity we could join on (names are nulled, which is why we're here).
  const collided = withStars(rows, {
    experts: [
      { firm: "RBC Capital", ratings: [{ date: "2026-07-07" }], rankings: [{ stars: 1.1 }] },
      { firm: "RBC Capital", ratings: [{ date: "2026-07-07" }], rankings: [{ stars: 2.2 }] },
    ],
  });
  assert.equal(collided[0].st, 2.2, "documented: on a firm|date collision the LAST expert wins");

  // degenerate payloads — all must yield st:null rather than throwing
  for (const [label, data] of [
    ["empty object", {}],
    ["experts: []", { experts: [] }],
    ["experts: null", { experts: null }],
    ["expert with no firm", { experts: [{ ratings: [{ date: "2026-07-07" }], rankings: [{ stars: 5 }] }] }],
    ["expert with no ratings", { experts: [{ firm: "RBC Capital", rankings: [{ stars: 5 }] }] }],
    ["expert with no rankings", { experts: [{ firm: "RBC Capital", ratings: [{ date: "2026-07-07" }] }] }],
    ["expert with all-null stars", { experts: [{ firm: "RBC Capital", ratings: [{ date: "2026-07-07" }], rankings: [{ stars: null }] }] }],
    ["ratings[0].date missing", { experts: [{ firm: "RBC Capital", ratings: [{}], rankings: [{ stars: 5 }] }] }],
  ]) {
    const got = withStars(rows, data);
    assert.equal(got.length, rows.length, `${label}: rows must pass through`);
    for (const r of got) {
      assert.equal(r.st, null, `${label}: st must be null, got ${r.st}`);
      assert.deepEqual(Object.keys(r), ["n", "f", "st", "r", "pt", "opt", "d"], `${label}: shape`);
    }
  }
  assert.deepEqual(withStars([], { experts: [{ firm: "X", ratings: [{ date: "2026-01-01" }], rankings: [{ stars: 1 }] }] }), [],
    "no page rows -> no output, whatever the payload says");

  // `opt` is carried through untouched (it is unrecoverable from the JSON, so losing it
  // here would silently drop every "$old → $new" revision we went to the page to get)
  const vs = withStars(v, {});
  assert.equal(vs.find((r) => r.n === "Andrew Tsai").opt, 15, "withStars must carry opt through");
  assert.equal(vs.find((r) => r.n === "Elemer Piros").opt, 19);
  assert.equal(vs.find((r) => r.n === "Paul Matteis").opt, null, "an absent opt stays null, never undefined");
  assert.ok(vs.every((r) => r.opt !== undefined));
  // sort: newest-first, and stable for the two rows that share 12/17/25 (parse order kept)
  assert.deepEqual(vs.map((r) => r.d), ["2026-07-06", "2025-12-17", "2025-12-17"], "newest-first");
  assert.deepEqual(vs.filter((r) => r.d === "2025-12-17").map((r) => r.n), ["Andrew Tsai", "Elemer Piros"],
    "equal dates keep parse order (stable sort)");
  // a row with no date sorts last rather than throwing on localeCompare
  const nod = withStars([{ n: "a", f: "b", r: "Buy", pt: 1, opt: null, d: undefined }, ...rows], {});
  assert.equal(nod[nod.length - 1].n, "a", "a dateless row sorts last, not a crash");
  assert.equal(nod[nod.length - 1].d, undefined);
  // extra keys on an input row are dropped — the output is exactly the Forecast shape
  assert.deepEqual(Object.keys(withStars([{ n: "a", f: "b", r: "Buy", pt: 1, d: "2026-01-01", junk: 1 }], {})[0]),
    ["n", "f", "st", "r", "pt", "opt", "d"]);
}

/* ================================================================ ROBUSTNESS
   The whole justification for a regex parser over a DOM library is that a TipRanks markup
   change must degrade to a STALE file, never a corrupt one. So: for every mutation of a
   real page, the result is either [] or a set of well-formed rows — never junk, never a
   throw. (scrape-forecasts.mjs only writes when the parse is non-empty, so [] leaves the
   previous file in place; ci/test-forecast-gate.mjs pins that.) */
{
  assert.deepEqual(parseForecastHtml(""), [], "empty string");
  assert.deepEqual(parseForecastHtml("<html><body>nothing here</body></html>"), [], "non-forecast HTML");
  assert.deepEqual(parseForecastHtml("Analyst Profile but no rows"), [], "header present, no rows");
  assert.deepEqual(parseForecastHtml("not html at all, just prose"), [], "non-HTML text");
  assert.deepEqual(parseForecastHtml(JSON.stringify({ experts: [{ name: "x", firm: "y" }] })), [], "JSON body instead of a page");
  assert.deepEqual(parseForecastHtml("<pre>{\"error\":\"403\"}</pre>"), [], "a Cloudflare/403 body");
  // header row markup with no tbody rows at all (real prefix, rows removed)
  const adct = fx("adct");
  assert.deepEqual(parseForecastHtml(adct.slice(0, adct.indexOf('<div class="rt-tr-group">'))), [],
    "real table header with zero rows");

  // PLAUSIBLE MARKUP CHANGES — the parser anchors on the analyst-profile slug path, the
  // "Analyst Profile" column header, the MM/DD/YY date format and column ORDER. Rename or
  // reformat any of them and we must lose rows, not gain garbage.
  const mutations = {
    "analyst link path renamed": adct.replaceAll("/experts/analysts/", "/experts/analyst-profile/"),
    "analyst link path pluralised away": adct.replaceAll("/experts/analysts/", "/analyst/"),
    "slug becomes an opaque id": adct.replace(/\/experts\/analysts\/[a-z0-9-]+/g, "/experts/analysts/A1B2C3"),
    "column header renamed": adct.replaceAll("Analyst Profile", "Analyst"),
    "date format -> ISO": adct.replace(/<span>(\d{2})\/(\d{2})\/(\d{2})<\/span>/g, "<span>20$3-$1-$2</span>"),
    "date format -> DD.MM.YYYY": adct.replace(/<span>(\d{2})\/(\d{2})\/(\d{2})<\/span>/g, "<span>$2.$1.20$3</span>"),
    "currency symbol -> EUR": adct.replace(/>\$([\d.,]+)<\/span>/g, ">€$1</span>"),
    "target moves into an attribute": adct.replace(/>\$([\d.,]+)<\/span>/g, "></span>"),
    "rating words localised": adct.replaceAll(">Hold<", ">Halten<").replaceAll(">Buy<", ">Kaufen<"),
    "class hashes rebuilt": adct.replaceAll("Mdcvgxd7", "zZ9aB1cD").replaceAll("rt-td", "tr-cell"),
    "everything wrapped in one line of minified JSX": adct.replace(/></g, "> <"),
  };
  for (const [label, mutated] of Object.entries(mutations)) {
    let got;
    assert.doesNotThrow(() => { got = parseForecastHtml(mutated); }, `markup change must not throw: ${label}`);
    assertWellFormed(got, `markup change: ${label}`);
    assert.ok(got.length <= rows.length, `markup change must not invent rows: ${label}`);
  }
  // the headline mutations specifically must yield NOTHING (stale file), not a subset
  for (const label of ["analyst link path renamed", "analyst link path pluralised away",
    "slug becomes an opaque id", "column header renamed", "date format -> ISO",
    "date format -> DD.MM.YYYY", "currency symbol -> EUR", "target moves into an attribute",
    "rating words localised"]) {
    assert.deepEqual(parseForecastHtml(mutations[label]), [],
      `a change to a load-bearing anchor must return [] so the existing file is kept: ${label}`);
  }
  // `rt-td` renamed / class hashes rebuilt is survivable — the parser is deliberately
  // anchored on column ORDER, not class names. Assert it still gets everything right.
  assert.deepEqual(parseForecastHtml(mutations["class hashes rebuilt"]), rows,
    "obfuscated class-hash churn must be a no-op (that is why we don't match on class names)");

  // TRUNCATED MID-ROW. Measured behaviour: the parse degrades to a PREFIX of the full
  // result — it never emits a partial row, but it also does not detect the truncation, so
  // a short FlareSolverr response would write a shorter-but-valid file over a complete one.
  // FINDING (reported, not fixed): no row-count sanity check against the page's own
  // "N Wall Street analysts" figure. Low impact (the next run overwrites it) but it is the
  // one way a bad fetch can quietly shrink real data.
  const full = parseForecastHtml(adct);
  let prev = 0;
  for (let cut = 0; cut <= adct.length; cut += 250) {
    const got = parseForecastHtml(adct.slice(0, cut));
    assertWellFormed(got, `truncated at ${cut}`);
    assert.ok(got.length >= prev, `truncation must be monotonic: ${cut} gave ${got.length} after ${prev}`);
    assert.ok(got.length <= full.length, `truncation must not invent rows at ${cut}`);
    assert.deepEqual(got, full.slice(0, got.length), `truncated parse must be a prefix of the full parse at ${cut}`);
    prev = got.length;
  }
  assert.ok(parseForecastHtml(adct.slice(0, 4000)).length === 0, "cut inside the first row -> no row at all");

  // INPUT CONTRACT: a string is required. The sole caller (scrape-forecasts.mjs) passes
  // `j.solution.response || ""`, so this is unreachable in production — pinned so the
  // contract is explicit. If forecast-html.mjs ever coerces instead, flip these.
  assert.throws(() => parseForecastHtml(), TypeError, "documented: parseForecastHtml requires a string");
  assert.throws(() => parseForecastHtml(null), TypeError);
  assert.throws(() => parseForecastHtml(123), TypeError);
}

/* ============================================== CROSS-FIXTURE SANITY SWEEP */
let total = 0;
for (const name of [...REAL, ...SYNTH]) {
  const got = parseForecastHtml(fx(name));
  assertWellFormed(got, name);
  assert.ok(got.length > 0, `${name}: fixture must produce at least one row or it proves nothing`);
  // withStars must accept every fixture's rows and preserve count + shape
  const st = withStars(got, {});
  assert.equal(st.length, got.length, `${name}: withStars must not drop rows`);
  for (let i = 1; i < st.length; i++) assert.ok(st[i - 1].d >= st[i].d, `${name}: withStars must sort newest-first`);
  total += got.length;
}

console.log(`forecast HTML parser: ok (${rows.length} ADCT + ${v.length} VTGN rows, ${total} rows across ${REAL.length + SYNTH.length} fixtures)`);
