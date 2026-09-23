// THE DESCRIPTOR, WRITTEN BY THE MODEL — the half-size identity line under the company name on
// the composed card, generated per company instead of mapped from the TipRanks `sec` field.
//
// The bug this replaces: `descriptorFor()` (ci/post-image.mjs) maps a hand-written phrase to
// each of TipRanks' twelve sector buckets, and `General` — TipRanks' own UNCLASSIFIED bucket,
// not an industry — rendered "too big to label" under Alphabet. Both meaningless (the bucket
// says nothing about what the company does) and slightly absurd (a joke that happens to land on
// whichever mega-cap or conglomerate TipRanks couldn't sort). The user's call: "don't take the
// company description from TipRanks as is. Insert it to the model and ask for it to write it as
// a good description with everything that the model knows about the company and all of what we
// know."
//
// So this module asks the SAME writer model (ci/provider.mjs — no new dependency, no new API)
// one extra question per PUBLISHED post (never per candidate — see `describeCompany` below):
// given the company's name, sector, market cap, price, analyst coverage, and the real prose
// description `src/data/stocks.json` already carries per row (`row.desc` — populated for every
// row in the live snapshot, not a sometimes-empty field), write a short, characterful 2-4 word
// descriptor true to the actual business.
//
// SAFETY: this is text that sits directly under a real public company's name on a published
// card, so — same posture as ci/post-score.mjs's fabrication check, just cheaper to enforce
// because a descriptor never claims a NUMBER — the model's raw output is validated, not trusted.
// `sanitizeDescriptor` rejects anything carrying a digit, a `$`/`%` sign, the company's own
// ticker, or a performance/valuation word (upside, buy, rating, undervalued, …) — this is an
// identity line, not a stat, and post-score.mjs's own number-verification pass never runs on it
// (it never reaches posts.json as claimable "text"; it is burned into the image the same way the
// sector-mapped descriptor used to be). ANY failure — a network error, a malformed body, a
// descriptor that fails sanitisation — deterministically falls back to the old sector map
// (`descriptorFor`, ci/post-image.mjs), so a bad or missing model response can never cost the
// post itself. That map is still exactly right for what it now is: a FALLBACK, not the primary
// path — its `General` entry stays "too big to label" for the rare run where the model call for
// an unclassified-sector company fails, which is a real improvement over every General-sector
// post reading that way, always, forever.
//
// CACHE: keyed by ticker, one entry per company, persisted to `src/data/company-descriptors.json`
// (committed by the same CI step that commits `src/data/posts.json` — see .github/workflows/
// site.yml's "Commit refreshed data" step, which already stages all of `src/data`). A cache hit
// costs zero neurons and returns the same descriptor a reader may have already seen under this
// company's name on an earlier post — consistency, not just cost, is the reason to reuse rather
// than regenerate. The cache is invalidated per-entry the moment the company's DISPLAY name
// changes (a re-listing, a rebrand) since the entry is keyed on `{ ticker, name }` together, not
// ticker alone.

import { coverage, displayCompanyName } from "./hooks.mjs";
import { descriptorFor } from "./post-image.mjs";

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words that turn an identity line into a claim — the exact thing the brief rules out ("no
 *  claims about performance or valuation — it sits under the company name as an identity line,
 *  not a stat"). Matched loosely (substring-ish via word boundary) since a model asked for
 *  "characterful" prose reaches for these first when it runs out of real description to lean on. */
const CLAIM_WORD_RE =
  /\b(upside|downside|buy|sell|hold|rating|score|target|undervalued|overvalued|bullish|bearish|analyst|consensus|soar\w*|plunge\w*|surge\w*|rally|crash\w*|gain\w*|loss\w*|beat|miss|outperform|underperform|overweight|underweight)\b/i;

const MIN_WORDS = 2;
const MAX_WORDS = 4;
/** A model asked for "2-4 words" sometimes hands back 5 or 6 and still means it — trimmed to
 *  MAX_WORDS rather than rejected outright. Past this, treat it as having ignored the brief. */
const LENIENT_MAX_WORDS = 6;

/**
 * Clean and validate one candidate descriptor. Returns the trimmed 2-4 word string, or `null`
 * if the text fails ANY safety rule — the caller falls back to `descriptorFor(sector)` on `null`,
 * exactly like a thrown provider error.
 */
export function sanitizeDescriptor(raw, { ticker } = {}) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  // A model asked for "output the text only" still sometimes wraps it in quotes or ends it
  // with a period — strip both rather than reject on them.
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  s = s.replace(/\.+$/, "").trim();
  if (!s) return null;

  if (/\d/.test(s)) return null; // no numbers, ever — this is an identity line, not a stat.
  if (/[$%]/.test(s)) return null;
  if (CLAIM_WORD_RE.test(s)) return null;
  if (ticker) {
    const re = new RegExp(`\\b${escapeRe(ticker)}\\b`);
    if (re.test(s)) return null; // never the ticker — same rule the post's own text follows.
  }
  // A newline or any leftover sentence-ending punctuation (after the one trailing period already
  // stripped above) means the model kept talking past a single short phrase.
  if (/[\n\r]/.test(s) || /[.!?]/.test(s)) return null;

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS || words.length > LENIENT_MAX_WORDS) return null;
  return words.slice(0, MAX_WORDS).join(" ");
}

/** Trim `row.desc` (a real prose paragraph, sometimes several hundred words) to a size that
 *  keeps the prompt small without cutting off mid-idea too abruptly — a period near the cut
 *  point reads far more naturally to a model than a hard character chop. */
function trimDesc(desc, maxChars = 500) {
  const s = String(desc ?? "").trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const lastStop = cut.lastIndexOf(". ");
  return (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
}

/**
 * Build the { system, prompt } pair for one company. `row` is a `src/data/stocks.json` entry
 * (or the minimal `{ t, n, sec }` shape a hook still carries when the row itself is unavailable —
 * see `describeCompany` below): only `n` (name), `sec`, `px`, `mc`, `desc`, and the `b`/`h`/`s`
 * analyst-coverage triad are ever read.
 */
export function buildDescriptorPrompt(row) {
  const name = displayCompanyName(row?.n);
  const sector = String(row?.sec ?? "").trim();
  const analysts = coverage(row);
  const desc = trimDesc(row?.desc);

  const system = [
    "You write the short identity line that sits directly beneath a company's name on a",
    "stock-data card — half the size of the name, the way a sharp editor would caption a photo",
    "of the business, not the way a filing would classify it.",
    "Rules, all of them hard:",
    "- 2 to 4 words. No more.",
    "- Say what the company actually DOES or IS, using everything you already know about it plus",
    "  whatever description you are given below — never just restate its stock sector as a label.",
    "  A sector bucket like \"General\" or \"Diversified\" describes a filing category, not a",
    "  business; ignore it as a description and describe the real business instead.",
    "- No ticker symbols. No numbers, digits, percentages, or dollar signs, ever.",
    "- No claims about performance, valuation, ratings, or analysts — this is an identity line,",
    "  not a stat. Never say upside, buy, sell, rating, target, over/undervalued, or similar.",
    "- Characterful and specific to this one company, not generic corporate-speak.",
    "- Output the descriptor text only. No quotes, no punctuation at the end, no explanation.",
  ].join("\n");

  const facts = [
    `Company: ${name}`,
    sector ? `TipRanks sector (approximate, often wrong or unclassified — do not just restate it): ${sector}` : null,
    Number.isFinite(row?.mc) ? `Market cap: ~$${row.mc}M` : null,
    Number.isFinite(row?.px) ? `Share price: ~$${row.px}` : null,
    analysts ? `Analyst coverage: ${analysts} analysts` : null,
    desc ? `What the company does:\n${desc}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `${facts}\n\nWrite the descriptor.`;
  return { system, prompt };
}

/**
 * Resolve one company's descriptor: cache hit, then a single model call, then the deterministic
 * sector fallback — in that order, and the caller never has to catch anything (mirrors
 * `generateImage`'s "never throw, always resolve" shape in ci/post-image.mjs).
 *
 * @param row a `src/data/stocks.json` row (or the `{ t, n, sec }` minimal shape).
 * @param provider the SAME text provider ci/provider.mjs builds for the post's own copy — this
 *   is one extra call per PUBLISHED post, never per candidate (the caller in
 *   ci/generate-posts.mjs invokes this exactly once per hook, after `pickBest`, not inside the
 *   candidate loop), so it costs nothing close to what the 5-candidate text generation already
 *   spends.
 * @param cache a plain object the caller persists to disk (`src/data/company-descriptors.json`)
 *   across runs — `{ [ticker]: { name, descriptor } }`. Mutated in place on a fresh success;
 *   never written to on a fallback, so a transient failure gets retried next run instead of
 *   being cached as a wrong answer forever.
 */
export async function describeCompany({ row, provider, cache }) {
  const ticker = row?.t;
  const name = displayCompanyName(row?.n);
  const sector = row?.sec;

  const cached = ticker && cache ? cache[ticker] : null;
  if (cached && cached.name === name && cached.descriptor) {
    return cached.descriptor;
  }

  try {
    if (typeof provider !== "function") throw new Error("no provider");
    const { system, prompt } = buildDescriptorPrompt(row);
    const [raw] = await provider({ system, prompt, n: 1 });
    const clean = sanitizeDescriptor(raw, { ticker });
    if (!clean) throw new Error(`model descriptor failed validation: ${JSON.stringify(raw)}`);
    if (cache && ticker) cache[ticker] = { name, descriptor: clean };
    return clean;
  } catch (err) {
    console.error(`  ${ticker ?? "?"}: descriptor generation fell back — ${err?.message ?? err}`);
    return descriptorFor(sector);
  }
}
