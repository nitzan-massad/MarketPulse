// A REAL PHOTOGRAPH, FOR REAL — Wikimedia Commons, compared against the Flux generation.
//
// The user's own example: the Googleplex, with the actual Google logo on the building. Flux
// (ci/post-image.mjs) can never show that — it fabricates brand marks as garbled pseudo-text,
// which is why buildImagePrompt() explicitly bans logos/signage from every generated scene. A
// REAL photo has no such problem: a real logo on a real building is just what the building
// looks like. Wikimedia Commons is the only source that is both free and legally usable in an
// automated publisher — a real API, no key, and every file carries explicit, machine-readable
// licensing (see `classifyLicense` below). Google Images is copyrighted and out of the question.
//
// THE ONE JOB: given a company name, find ONE relevant Commons image — headquarters, campus,
// office, or a product shot — and return its bytes plus a license short name and an
// attribution/author string, or `null` when there is no usable hit. NEVER THROWS: every
// failure (network error, malformed body, no hit, a hit that fails licensing or relevance)
// returns `null`, exactly like ci/post-image.mjs's `generateImage` — the pipeline falls back to
// Flux, never loses the post.
//
// LICENSING, FILTERED HARD. `classifyLicense` accepts only CC0, public domain, CC BY, and CC
// BY-SA (any version) — every one of these explicitly permits commercial use, which an
// automated publisher posting to the open web is. Anything carrying "NC" (non-commercial) is
// rejected outright. CC BY-ND ("no derivatives") is ALSO rejected, even though ND still permits
// commercial use of an unmodified copy — deliberately stricter than the letter of "permits
// commercial use", because ci/post-compose.mjs burns text directly into the photo's pixels,
// which IS a derivative work. An ND-licensed photo would not legally survive that. Anything
// with no license metadata at all, or a license this function does not recognise, is rejected —
// `null` is the correct, safe answer when in doubt, never a guess.
//
// RELEVANCE, THE HARD PART. A bare Commons search for a small biotech's name returns noise —
// searching "Praxis Precision Medicines" or "Opus Genetics" on Commons today returns a Hamburg
// stock-exchange sculpture and 19th-century genetics textbooks, matched on loose full-text
// relevance, not on the company at all (verified live against the real API while building this
// module). Publishing either under that company's name would be a worse failure than posting no
// photo. Two independent gates, BOTH required on every candidate this module ever returns:
//
//   1. TOKEN MATCH — the company's own significant name word(s) (`significantTokens`, generic
//      corporate suffixes like "Inc."/"Corp."/"Holdings" stripped) must appear, whole-word,
//      case-insensitively, in the candidate's OWN TITLE OR DESCRIPTION — never just a Commons
//      CATEGORY tag. This distinction matters: querying Commons' own `Category:Apple Inc.` for
//      real turned up a Taiwanese presidential-office photo filed under that category for
//      reasons unrelated to Apple, with no mention of Apple anywhere in its title or
//      description — a mis-tag, not a match. Trusting category membership alone would have
//      published a random politician's photo under Apple's name. Checking the file's OWN text
//      instead of the folder it happens to sit in is the fix. A single-word name (Apple,
//      Microsoft, Alphabet) needs that one word; a multi-word name needs at least two of its
//      significant words (`Math.min(tokens.length, 2)`) — strict enough that "Praxis Precision
//      Medicines" never matches on "Precision" alone (a word plenty of unrelated files use).
//
//   2. BUILDING-WORD MATCH (plain-search path only, see TIERS below) — the title or description
//      must also say what kind of place/thing this actually is (headquarters, campus, office,
//      building, sign, store, lab, plant, factory, logo, …). A company-name match alone is not
//      enough once the search query itself no longer carries a location keyword (the bare-name
//      fallback tier) — this is what keeps "Apple" from resolving to a photo of an apple.
//
// TWO TIERS, CHEAPEST-AND-STRONGEST FIRST.
//   TIER 1 — the company's own Commons category (`incategory:"<name>" (headquarters OR campus
//   OR …)`), when one exists by that exact name. Curated by Commons volunteers, so a much
//   stronger prior than free-text search — but still run through the SAME token-match gate
//   above (see the Apple/Taiwan example), never trusted blindly. No building-word requirement
//   here: category membership plus a same-file name match is already two independent signals.
//   TIER 2 — plain keyword search, one query per suffix (headquarters, campus, office, building,
//   logo, then the bare name as a last resort), most specific first, stopping at the first
//   suffix that yields any passing candidate. Both gates apply. This is deliberately several
//   small requests rather than one clever OR-query: an OR-grouped multi-keyword query against a
//   quoted company name was tried and measured live to rank noise (OCR'd historical PDFs
//   matching on an unrelated keyword) ahead of the real building photos that a plain two-word
//   query ("Apple headquarters", "Microsoft campus") returns cleanly.
//
// SIZE/FORMAT FILTERS. Only `image/jpeg`/`image/png` (ci/post-compose.mjs's `imageDimensions`
// reads only those two headers) — never SVG (vector logos, exactly what the brief says to
// skip), never audio/PDF/other junk namespace-6 sometimes contains. `MIN_DIMENSION` rejects
// thumbnails/icons. Among passing candidates, landscape orientation and larger area are
// preferred (`pickBest`), but neither is a hard requirement — a portrait-orientation photo
// still beats no photo.
//
// NO SDK, NO NEW DEPENDENCY. Plain `fetch` against the MediaWiki API on commons.wikimedia.org
// (`action=query`, `generator=search`, `prop=imageinfo`) — the same "one function, no class"
// posture as ci/provider.mjs and ci/post-image.mjs. `fetchImpl` is injectable for exactly the
// reason those two are: ci/test-company-photo.mjs never touches the network.

import { displayCompanyName } from "./hooks.mjs";

const API = "https://commons.wikimedia.org/w/api.php";

// Wikimedia asks every automated client for a descriptive User-Agent identifying the project
// and a way to reach its operator (https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy)
// — a repo URL, not a personal email, is the right identifier for an open-source pipeline like
// this one.
const USER_AGENT = "MarketPulse-CompanyPhoto/1.0 (https://github.com/nitzan-massad/MarketPulse)";

/** Reject anything with a shorter edge below this — a thumbnail or an icon, not a usable photo
 *  on a card that is itself composed at roughly this size or larger (see ci/post-image.mjs's
 *  Flux output, 1024x1024). */
const MIN_DIMENSION = 640;

/** Ask Commons to pre-scale to this width via `iiurlwidth` — caps the download at a sane size
 *  (some Commons originals run 8000px+ / tens of MB) without losing anything ci/post-compose.mjs
 *  needs; it re-encodes to JPEG at its own quality regardless (ci/jpeg-encode.mjs). */
const THUMB_WIDTH = 1600;

const SEARCH_LIMIT = 8;

/** Query suffixes for TIER 2, most specific/likely-relevant first — see the module header.
 *  `""` (the bare name) is the last resort, gated the hardest (a building-word match is
 *  required on every TIER 2 candidate, this one included). Also doubles as the OR-group for
 *  TIER 1's category-scoped query. */
const QUERY_SUFFIXES = ["headquarters", "campus", "office", "building", "logo", ""];

/** Generic corporate words that are never what makes a company's name IDENTIFIABLE — stripped
 *  before token-matching so "Praxis Precision Medicines, Inc." doesn't need a file to mention
 *  "Inc" to match, and so a name that is ENTIRELY generic words (rare, but see the empty-token
 *  guard in `findCompanyPhoto`) is correctly treated as unmatchable rather than matching
 *  everything. */
const GENERIC_NAME_WORDS = new Set([
  "inc", "corp", "corporation", "co", "company", "ltd", "limited", "plc", "group", "holdings",
  "llc", "the", "and", "of", "class", "sa", "nv", "ag", "a", "b", "c",
]);

/** What a candidate's title/description must say it actually IS, once the search query no
 *  longer carries a location word of its own (TIER 2 only — see the module header). */
const BUILDING_WORD_RE =
  /\b(headquarters|hq|campus|offices?|buildings?|tower|plant|factory|stores?|labs?|laboratory|centers?|centres?|park|complex|facilit(?:y|ies)|plaza|signage?|logo|site|works|warehouse|showroom)\b/i;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strip Commons' HTML-formatted `Artist`/`Credit` extmetadata fields down to plain text — they
 *  are typically a single `<a href="…">Name</a>` link, occasionally with nested markup. Not a
 *  general HTML sanitiser (this text is never rendered as HTML anywhere downstream, only burned
 *  as a plain string onto the image or stored as a JSON field), just enough to get a readable
 *  name out. */
function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The company name's significant word(s) — generic corporate suffixes and single/two-letter
 * share-class noise stripped, short filler dropped. Exported for its own direct test coverage
 * (see the module header on why this is one of the two relevance gates).
 */
export function significantTokens(name) {
  return String(name ?? "")
    .replace(/[.,()]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w.toLowerCase()));
}

/**
 * Accept CC0, public domain, CC BY, and CC BY-SA (any version) — every one explicitly permits
 * commercial use. Reject NC (non-commercial) and ND (no-derivatives — see the module header on
 * why ND is rejected too, despite technically permitting commercial use of an unmodified copy:
 * this pipeline always modifies the photo by compositing text onto it). Reject anything with no
 * license metadata, or a license this function does not recognise — `null` is the safe default,
 * not a guess. Exported for direct test coverage.
 */
export function classifyLicense(rawShortName) {
  const s = String(rawShortName ?? "").trim();
  if (!s) return { ok: false, reason: "no license metadata" };
  const lower = s.toLowerCase();
  if (/\bnc\b|non[-\s]?commercial/.test(lower)) return { ok: false, reason: `non-commercial license (${s})` };
  if (/\bnd\b|no[-\s]?derivatives?/.test(lower)) {
    return { ok: false, reason: `no-derivatives license — incompatible with compositing text onto the photo (${s})` };
  }
  if (/\bcc0\b|creative commons zero/.test(lower)) return { ok: true, short: s };
  if (/public domain|^pd\b|\bpd[-\s]/.test(lower)) return { ok: true, short: s };
  if (/\bcc[-\s]?by(?:[-\s]?sa)?\b/.test(lower)) return { ok: true, short: s };
  return { ok: false, reason: `unrecognised or restrictive license (${s})` };
}

/** One `query.pages` entry -> a flat candidate record, or `null` when the page carries no
 *  usable imageinfo (should not happen for a namespace-6 hit, but MediaWiki responses are never
 *  trusted blindly here — see the module header's "never throws" posture). */
function toCandidate(page) {
  const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  if (!info) return null;
  const downloadUrl = info.thumburl || info.url;
  if (!downloadUrl) return null;
  const meta = info.extmetadata ?? {};
  return {
    title: String(page?.title ?? "").replace(/^File:/, ""),
    description: stripHtml(meta.ImageDescription?.value ?? ""),
    artist: stripHtml(meta.Artist?.value ?? ""),
    credit: stripHtml(meta.Credit?.value ?? ""),
    licenseShort: String(meta.LicenseShortName?.value ?? meta.License?.value ?? "").trim(),
    mime: String(info.mime ?? ""),
    width: Number(info.thumbwidth ?? info.width ?? 0) || 0,
    height: Number(info.thumbheight ?? info.height ?? 0) || 0,
    downloadUrl: String(downloadUrl),
    pageUrl: String(page?.descriptionurl ?? info.descriptionurl ?? ""),
  };
}

/** One `generator=search` + `prop=imageinfo` call -> an array of candidates (never throws; any
 *  non-ok response, malformed body, or a zero-hit `{"batchcomplete":""}` response with no
 *  `query` key at all — the real shape Commons returns for zero hits, verified live — yields
 *  `[]`). `iiurlwidth` gets a pre-scaled `thumburl`/`thumbwidth`/`thumbheight` back for anything
 *  larger than `THUMB_WIDTH`; smaller originals come back as `url`/`width`/`height` with no
 *  `thumburl` at all, which `toCandidate` falls back to. */
async function searchCommons(fetchImpl, query, { limit = SEARCH_LIMIT } = {}) {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: String(THUMB_WIDTH),
  });
  try {
    const res = await fetchImpl(`${API}?${params.toString()}`, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!res.ok) return [];
    const body = await res.json();
    const pages = body?.query?.pages;
    if (!pages || typeof pages !== "object") return [];
    return Object.values(pages).map(toCandidate).filter(Boolean);
  } catch {
    return [];
  }
}

function passesHardFilters(candidate) {
  if (candidate.mime !== "image/jpeg" && candidate.mime !== "image/png") return false;
  if (candidate.width < MIN_DIMENSION || candidate.height < MIN_DIMENSION) return false;
  return classifyLicense(candidate.licenseShort).ok;
}

function tokenMatchCount(candidate, tokens) {
  const haystack = `${candidate.title} ${candidate.description}`.toLowerCase();
  return tokens.filter((t) => new RegExp(`\\b${escapeRe(t.toLowerCase())}\\b`).test(haystack)).length;
}

/** Both relevance gates from the module header, as one predicate. `requireBuildingWord` is
 *  `false` for TIER 1 (category-scoped) candidates and `true` for TIER 2 (plain search). */
function isRelevant(candidate, tokens, { requireBuildingWord }) {
  if (!tokens.length) return false;
  const required = Math.min(tokens.length, 2);
  if (tokenMatchCount(candidate, tokens) < required) return false;
  if (requireBuildingWord && !BUILDING_WORD_RE.test(`${candidate.title} ${candidate.description}`)) return false;
  return true;
}

/** Landscape first, then larger area — a preference (see the module header), not a filter:
 *  called only on a list that has already passed every hard/relevance gate, so the worst this
 *  ever returns is a smaller or portrait-orientation photo, never an irrelevant or wrongly
 *  licensed one. */
function pickBest(candidates) {
  const scored = candidates.map((c) => ({
    c,
    score: (c.width >= c.height ? 1 : 0) * 1e12 + c.width * c.height,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.c ?? null;
}

/** Download the chosen candidate's actual bytes and shape the final return value. Any failure
 *  here (network error, non-ok response, empty body) is treated exactly like "no candidate" —
 *  `findCompanyPhoto`'s single try/catch covers this too. */
async function downloadPhoto(fetchImpl, candidate) {
  const res = await fetchImpl(candidate.downloadUrl, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) return null;
  const author = candidate.artist || candidate.credit || "a Wikimedia Commons contributor";
  return {
    bytes,
    width: candidate.width,
    height: candidate.height,
    mime: candidate.mime,
    license: candidate.licenseShort,
    attribution: `${author} — Wikimedia Commons (${candidate.licenseShort})`,
    sourceUrl: candidate.pageUrl,
    title: candidate.title,
  };
}

/**
 * Find one relevant, commercially-usable Commons photo for `companyName`, or return `null`.
 * NEVER THROWS (see the module header). `fetchImpl` is injectable so ci/test-company-photo.mjs
 * never touches the network; `console` is used directly for logging, same as
 * ci/post-image.mjs/ci/provider.mjs.
 *
 * @returns `{ bytes, width, height, mime, license, attribution, sourceUrl, title }` or `null`.
 */
export async function findCompanyPhoto(companyName, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const name = displayCompanyName(companyName) || String(companyName ?? "").trim();
    if (!name) return null;
    const tokens = significantTokens(name);
    if (!tokens.length) {
      console.log(`  ${companyName}: no distinctive name token to match against — skipping Commons search`);
      return null;
    }

    // TIER 1 — the company's own Commons category, if one exists by this exact name.
    const catQuery = `incategory:"${name}" (${QUERY_SUFFIXES.filter(Boolean).join(" OR ")})`;
    const catCandidates = (await searchCommons(fetchImpl, catQuery)).filter(passesHardFilters);
    const catRelevant = catCandidates.filter((c) => isRelevant(c, tokens, { requireBuildingWord: false }));
    if (catRelevant.length) {
      const best = pickBest(catRelevant);
      const photo = await downloadPhoto(fetchImpl, best);
      if (photo) {
        console.log(`  ${name}: Commons hit via its own category — "${best.title}" (${best.licenseShort})`);
        return photo;
      }
    }

    // TIER 2 — plain keyword search, most specific suffix first, stopping at the first suffix
    // that yields any passing, relevant candidate.
    for (const suffix of QUERY_SUFFIXES) {
      const query = suffix ? `${name} ${suffix}` : name;
      const candidates = (await searchCommons(fetchImpl, query)).filter(passesHardFilters);
      const relevant = candidates.filter((c) => isRelevant(c, tokens, { requireBuildingWord: true }));
      if (!relevant.length) continue;
      const best = pickBest(relevant);
      const photo = await downloadPhoto(fetchImpl, best);
      if (photo) {
        console.log(`  ${name}: Commons hit via "${query}" — "${best.title}" (${best.licenseShort})`);
        return photo;
      }
    }

    console.log(`  ${name}: no usable Commons photo found (no relevant, commercially-licensed hit)`);
    return null;
  } catch (err) {
    console.error(`  company-photo failed for "${companyName}" — ${err?.message ?? err}`);
    return null;
  }
}
