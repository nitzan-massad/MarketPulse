// Self-check for the SSR-forecast-page parser. Run: node ci/test-forecast-html.mjs
// Fixture is a real (trimmed) tipranks.com/stocks/adct/forecast response — the ticker that
// exposed the bug: 4 analysts on the page, all 4 anonymized in the getData API, so we wrote
// [] and the modal claimed "No analyst forecasts for this stock".
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseForecastHtml, withStars } from "./forecast-html.mjs";

const html = readFileSync(new URL("./fixtures/adct-forecast.html", import.meta.url), "utf8");
const rows = parseForecastHtml(html);

// 4 analysts are listed; H.C. Wainwright's target renders as "—" and a Forecast needs a target
assert.equal(rows.length, 3, `expected 3 parsed rows, got ${rows.length}`);
assert.deepEqual(rows.map((r) => r.f), ["RBC Capital", "Guggenheim", "Stephens"]);
assert.deepEqual(rows[0], { n: "Leonid Timashev", f: "RBC Capital", r: "Hold", pt: 2, opt: null, d: "2026-07-07" });
assert.equal(rows.find((r) => r.f === "Guggenheim").pt, 10);
assert.equal(rows.find((r) => r.f === "Stephens").pt, 5);
assert.ok(!rows.some((r) => r.f.includes("Wainwright")), "row with no price target must be skipped");

// no field may carry markup or an href fragment (the chunk-start bug did exactly that)
for (const r of rows) {
  for (const [k, v] of Object.entries(r)) {
    assert.ok(!/[<>|]|experts\/analysts/.test(String(v)), `${k} leaked markup: ${v}`);
  }
  assert.match(r.d, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(r.pt) && r.pt > 0, "pt must be a positive number");
  assert.match(r.r, /^(Buy|Hold|Sell)$/);
}

// the page ships the table twice (desktop + mobile) — no analyst may appear twice
const keys = rows.map((r) => `${r.n}|${r.d}`);
assert.equal(new Set(keys).size, keys.length, "duplicate rows across the two table layouts");

// withStars: joins stars from the API payload on firm+date, emits the app's Forecast shape,
// newest-first. opt is unrecoverable from the SSR table and must be null, not undefined.
const withst = withStars(rows, {
  experts: [
    { firm: "RBC Capital", ratings: [{ date: "2026-07-07T00:00:00" }], rankings: [{ stars: 4.9 }] },
    { firm: "Guggenheim", ratings: [{ date: "2026-06-30T00:00:00" }], rankings: [{ stars: 3.1 }] },
  ],
});
assert.equal(withst[0].st, 4.9, "stars joined on firm+date");
assert.equal(withst[1].st, 3.1);
assert.equal(withst[2].st, null, "no matching API row -> null, never undefined");
assert.deepEqual(withst.map((r) => r.d), ["2026-07-07", "2026-06-30", "2026-06-04"], "newest-first");
for (const r of withst) {
  assert.deepEqual(Object.keys(r), ["n", "f", "st", "r", "pt", "opt", "d"], "Forecast key shape");
  assert.equal(r.opt, null);
}

// REVISED TARGETS. A revision renders as "$old → $new"; taking the FIRST $ published the
// pre-revision target. This shipped: VTGN wrote pt=15 for a $0.24 stock whose real target is
// 0.9 (+6100% upside on screen). The ADCT fixture has no revised row, which is exactly why
// the original test passed — hence this second fixture.
{
  const v = parseForecastHtml(readFileSync(new URL("./fixtures/vtgn-forecast.html", import.meta.url), "utf8"));
  const by = (n) => v.find((r) => r.n === n);
  assert.equal(v.length, 3, `expected 3 VTGN rows, got ${v.length}`);

  assert.deepEqual(by("Andrew Tsai"), { n: "Andrew Tsai", f: "Jefferies", r: "Hold", pt: 0.9, opt: 15, d: "2025-12-17" });
  assert.deepEqual(by("Elemer Piros"), { n: "Elemer Piros", f: "Lucid Capital", r: "Hold", pt: 1, opt: 19, d: "2025-12-17" });
  // unrevised row in the same table: single "$", so opt stays null
  assert.equal(by("Paul Matteis").pt, 1);
  assert.equal(by("Paul Matteis").opt, null);
  // William Blair's target renders "―" (no target at all) and must still be skipped
  assert.ok(!v.some((r) => r.f === "William Blair"), "no-target row must be skipped");

  // the invariant, stated directly: on a revision the new target is never the larger-by-default
  // one — it is whichever came after the arrow. Guard against silently reverting to first-$.
  for (const r of v) {
    if (r.opt != null) assert.notEqual(r.pt, r.opt, "pt and opt must differ on a revision");
  }
  assert.equal(withStars(v, {}).find((r) => r.n === "Andrew Tsai").opt, 15, "withStars must carry opt through");
}

// garbage in -> empty out, never a throw: a markup change must yield a stale file, not a crash
assert.deepEqual(parseForecastHtml(""), []);
assert.deepEqual(parseForecastHtml("<html><body>nothing here</body></html>"), []);
assert.deepEqual(parseForecastHtml("Analyst Profile but no rows"), []);

console.log(`forecast HTML parser: ok (${rows.length} rows from the ADCT fixture)`);
