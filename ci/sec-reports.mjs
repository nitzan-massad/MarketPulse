// Earnings announcement dates from SEC EDGAR, for ci/scrape-pe.mjs: each quarter's EPS should
// count from the day it was ANNOUNCED, not from a guessed "quarter end + 35 days".
//
// Source: https://data.sec.gov/submissions/CIK##########.json (free, no key; the SEC asks for a
// User-Agent naming a contact, and allows 10 requests/second — we stay under 5).
// Decided PER QUARTER (TEAM, ADCT, PGY… switched from 6-K to 10-Q filing at some point):
//   - The quarter has a 10-Q/10-K: the FIRST 8-K item 2.02 after the quarter ended and no later
//     than that 10-Q/10-K (so a genuine preliminary release counts). Item 2.02 is also used for
//     things that are not results (ABBV's IPR&D guidance, FANG's realized prices, HOOD's monthly
//     metrics, recasts, spin-offs), so with 2+ candidates each is read and must contain results
//     wording; none does -> the one closest to the 10-Q. No 2.02 at all -> the 10-Q/10-K date.
//   - Else a 6-K filer: the earliest 6-K of >= 250KB whose period is that quarter's end AND is at
//     least 3 days before its filing date — most 6-Ks just carry their filing date as the period,
//     which made any 6-K filed in a quarter's first week look like its results (BABA, BNTX, VOD).
//     Nothing qualifies -> no date (the 35-day guess).
//   - Accepted at/after 16:00 (an after-close release) -> counts from the next day. EDGAR's
//     acceptanceDateTime is Eastern time despite its trailing "Z".
//   - Amendments (forms ending in /A) are ignored.
// Pure logic is `pickReports` (the text check is injected); ci/test-sec-reports.mjs covers it.

const DAY = 864e5;
const days = (a, b) => (Date.parse(a) - Date.parse(b)) / DAY;
const addDay = (d) => new Date(Date.parse(d) + DAY).toISOString().slice(0, 10);
const near = (a, b) => Math.abs(days(a, b)) <= 7; // 52/53-week fiscal calendars

/** EDGAR's column-oriented filings block -> rows. */
export function rowsOf(block) {
  const n = block?.form?.length ?? 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      form: block.form[i],
      filingDate: block.filingDate[i],
      reportDate: block.reportDate?.[i] || "",
      items: block.items?.[i] || "",
      accepted: block.acceptanceDateTime?.[i] || "",
      size: Number(block.size?.[i] || 0),
      acc: block.accessionNumber?.[i] || "",
      doc: block.primaryDocument?.[i] || "",
    });
  }
  return out;
}

const effectiveDate = (r) => (Number(r.accepted.slice(11, 13)) >= 16 ? addDay(r.filingDate) : r.filingDate);

const byDate = (a, b) => (a.filingDate < b.filingDate ? -1 : 1);

/**
 * Quarter end -> announcement date, for each of `quarterEnds` we can place.
 * `isResults(row)` (async) says whether an 8-K's Item 2.02 is actually a results release; it is
 * only asked when a quarter has 2+ candidates. Default: trust them all (tests, offline use).
 */
export async function pickReports(rows, quarterEnds, isResults = async () => true) {
  const live = rows.filter((r) => !/\/A$/.test(r.form));
  const out = {};
  for (const q of quarterEnds) {
    const periodic = live
      .filter((r) => (r.form === "10-Q" || r.form === "10-K") && r.reportDate && near(r.reportDate, q) && r.filingDate > q)
      .sort(byDate)[0];
    let hit;
    if (periodic) {
      const cands = live
        .filter((r) => r.form === "8-K" && r.items.split(",").includes("2.02") && r.filingDate > q && r.filingDate <= periodic.filingDate)
        .sort(byDate);
      if (cands.length === 1) hit = cands[0];
      else if (cands.length > 1) {
        for (const c of cands.slice(0, 4)) if (await isResults(c)) { hit = c; break; }
        hit ??= cands[cands.length - 1];
      } else hit = periodic;
    } else {
      hit = live
        .filter((r) => r.form === "6-K" && r.size >= 250_000 && r.reportDate && near(r.reportDate, q) &&
          days(r.filingDate, r.reportDate) >= 3 && r.filingDate > q && days(r.filingDate, q) <= 100)
        .sort(byDate)[0];
    }
    if (hit) out[q] = effectiveDate(hit);
  }
  return out;
}


// ---- network (used by scrape-pe.mjs) ------------------------------------------------------

const UA = { "User-Agent": process.env.SEC_USER_AGENT || "MarketPulse contact@example.org" };
const GAP_MS = 220; // < 5 req/s against the SEC's 10/s
let last = 0;
async function secFetch(url) {
  const wait = last + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  // a 403 is the SEC's rate/UA gate, never "this company has no reports": the caller retries later
  if (!r.ok) throw new Error(`SEC HTTP ${r.status}`);
  return r;
}
const secJson = async (url) => (await secFetch(url)).json();
const secText = async (url) => (await secFetch(url)).text();

// "…announced its financial results for the second quarter…", "…preliminary results…",
// "…earnings release…" — and not "Results of Operations and Financial Condition", the item's own title.
const RESULTS_RE = /\b(financial|operating|quarter(?:ly)?|fiscal|annual|year[- ]end|preliminary|unaudited)\b[^.]{0,60}\bresults\b|\bresults\b[^.]{0,40}\b(?:for|of)\b[^.]{0,40}\b(quarter|fiscal|year|period|months)\b|\bearnings (?:press )?release\b/i;

const NOT_YET_RE = /\b(?:have|has) not (?:yet )?been finalized\b|\bare expected to include\b/i;
const PRELIM_RE = /\bpreliminary (?:unaudited |selected )?(?:financial )?(?:results|revenues?|net sales|net revenues?)\b/i;

/** Is this 8-K's Item 2.02 a results release? Reads the filing's primary document. */
export async function isResultsFiling(cik, row) {
  if (!row.acc || !row.doc) return true;
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${row.acc.replace(/-/g, "")}/${row.doc}`;
  const html = await secText(url);
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
  const at = text.search(/Item\s*2\.02/i);
  const body = (at >= 0 ? text.slice(at, at + 2500) : text.slice(0, 4000)).replace(/Results of Operations and Financial Condition/gi, "");
  // "…expected to include $823M of IPR&D… Results for the quarter have not been finalized" (ABBV
  // every quarter) is a heads-up about one line item, not results — unless it gives preliminary
  // results/revenue themselves (NVDA's 2022 pre-announcement, the JPM-conference biotech updates).
  if (NOT_YET_RE.test(body) && !PRELIM_RE.test(body)) return false;
  return RESULTS_RE.test(body);
}

let cikMap = null;
/** ticker -> 10-digit CIK, from the SEC's own map (one fetch per run, only when needed). */
export async function cikOf(ticker) {
  if (!cikMap) {
    const j = await secJson("https://www.sec.gov/files/company_tickers.json");
    cikMap = new Map(Object.values(j).map((r) => [String(r.ticker).toUpperCase(), String(r.cik_str).padStart(10, "0")]));
  }
  return cikMap.get(ticker.toUpperCase().replace(".", "-")) ?? null;
}

/** All filings rows back to `since` — the `recent` block plus older pages for heavy filers
 *  (BAC/C file notes daily, so `recent`'s 1000 rows can cover only weeks). Capped at 30 pages. */
export async function filingsSince(cik, since) {
  const j = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const rows = rowsOf(j?.filings?.recent);
  const pages = (j?.filings?.files || []).slice(0, 30);
  for (const p of pages) {
    const oldest = rows.reduce((m, r) => (r.filingDate < m ? r.filingDate : m), "9999");
    if (oldest <= since) break;
    rows.push(...rowsOf(await secJson(`https://data.sec.gov/submissions/${p.name}`)));
  }
  return rows;
}
