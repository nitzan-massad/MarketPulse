// THE DESCRIPTOR *AND* THE SCENE, BOTH WRITTEN BY THE MODEL, IN ONE CALL — the half-size
// identity line under the company name AND the photographable scene ci/post-image.mjs's
// buildImagePrompt uses in place of a sector-mapped phrase, generated per company instead of
// mapped from the TipRanks `sec` field.
//
// The bug this replaces (descriptor side): `descriptorFor()` (ci/post-image.mjs) maps a
// hand-written phrase to each of TipRanks' twelve sector buckets, and `General` — TipRanks' own
// UNCLASSIFIED bucket, not an industry — rendered "too big to label" under Alphabet. Both
// meaningless (the bucket says nothing about what the company does) and slightly absurd (a joke
// that happens to land on whichever mega-cap or conglomerate TipRanks couldn't sort). The user's
// call: "don't take the company description from TipRanks as is. Insert it to the model and ask
// for it to write it as a good description with everything that the model knows about the
// company and all of what we know."
//
// THE SAME BUG, ON THE IMAGE SIDE. `ci/post-image.mjs` used to map each sector to one
// hand-written scene, and skip the Flux photo entirely for `General` (rendering a palette
// abstract instead) on the reasoning that an unclassified bucket gives nothing to depict. The
// user rejected that too — every post gets a real photo, always, and `General` in particular
// (Alphabet chief among its ~44 rows) deserves a scene about its ACTUAL business, not a sector
// label or a filler abstract. The fix is identical in shape to the descriptor fix above: ask the
// model, given everything it already knows about the company plus `row.desc`, for a short,
// concrete, photographable scene — a data-centre hall for a search/cloud company, a lab bench
// for a biotech, never "a person in an office".
//
// ONE CALL, NOT TWO. The descriptor and the scene need the exact same context (name, sector,
// cap, price, analysts, `row.desc`), so this module asks for both in a single model call per
// published post (never per candidate) rather than doubling the round trips — see
// `buildDescriptorPrompt`'s two-line `DESCRIPTOR:` / `SCENE:` output format and
// `parseModelResponse` below.
//
// SAFETY: this is text that sits directly under a real public company's name, and a scene that
// feeds directly into a Flux prompt next to that name — same posture as ci/post-score.mjs's
// fabrication check, just cheaper to enforce because neither ever claims a NUMBER. The model's
// raw output is validated, not trusted, on both halves: `sanitizeDescriptor` rejects anything
// carrying a digit, a `$`/`%` sign, the company's own ticker, or a performance/valuation word
// (upside, buy, rating, undervalued, …); `sanitizeScene` rejects the same plus a pronoun/gender
// word (the person's gender is chosen separately — see ci/post-image.mjs's `personPhrase`) and
// logo/brand/chart/signage words (a scene that asks for one directly undermines the image
// template's own no-logo/no-chart clause far more than an incidental one Flux invents on its
// own). Neither ever reaches posts.json as claimable "text" — both are burned into the image
// (ci/post-compose.mjs) or fed to Flux (ci/post-image.mjs), never scored by the fabrication
// verifier. ANY failure — a network error, a malformed body, EITHER half failing sanitisation —
// deterministically falls back to the old sector maps (`descriptorFor` / `sectorScenePhrase`,
// ci/post-image.mjs) for BOTH halves together, so a bad or missing model response can never cost
// the post itself, and the cache (below) is never poisoned with a half-bad attempt. Those maps
// are still exactly right for what they now are: a FALLBACK, not the primary path.
//
// CACHE: keyed by ticker, one entry per company (`{ name, descriptor, scene }`), persisted to
// `src/data/company-descriptors.json` (committed by the same CI step that commits
// `src/data/posts.json` — see .github/workflows/site.yml's "Commit refreshed data" step, which
// already stages all of `src/data`). A cache hit costs zero neurons and returns the same
// descriptor/scene a reader may have already seen under this company's name on an earlier post —
// consistency, not just cost, is the reason to reuse rather than regenerate. The cache is
// invalidated per-entry the moment the company's DISPLAY name changes (a re-listing, a rebrand)
// since the entry is keyed on `{ ticker, name }` together, not ticker alone. An entry written
// before this module gained a scene (descriptor only, no `scene` field) is treated as a miss —
// `describeCompany` requires BOTH fields present to short-circuit — so it is transparently
// upgraded to carry a scene the next time that ticker is published.

import { coverage, displayCompanyName } from "./hooks.mjs";
import { descriptorFor, sectorScenePhrase } from "./post-image.mjs";

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

/** Pronoun/gender words the scene must never use — the person's gender is chosen separately and
 *  deterministically by ci/post-image.mjs's `personPhrase(seed)`, so the model-written scene has
 *  to read correctly after EITHER "a woman " or "a man " is prepended to it (identical
 *  requirement to `SECTOR_ROLE`'s hand-written actions — see that file's own comment). Matched on
 *  word boundaries, so "management"/"human" etc. are untouched. */
const PRONOUN_RE = /\b(he|she|him|her|his|hers|woman|women|man|men|male|female)\b/i;

/** Words that would directly undermine `buildImagePrompt`'s own no-logo/no-brand/no-chart/
 *  no-signage clause — far worse coming from the SCENE itself (a positive request Flux is asked
 *  to paint) than an incidental element Flux might invent despite the negative instruction (see
 *  ci/post-image.mjs's SCREENS-REDIRECTED comment on exactly that failure mode). */
const SCENE_BANNED_RE =
  /\b(logo|logos|brand|brands|trademark|watermark|signage|sign|chart|charts|graph|graphs|diagram|diagrams|ticker)\b/i;

const SCENE_MIN_WORDS = 4;
const SCENE_MAX_WORDS = 40;

/**
 * Clean and validate one candidate SCENE — the photographable role+action phrase
 * ci/post-image.mjs's `buildImagePrompt` substitutes for `sectorScenePhrase(sector)`. Returns
 * the trimmed phrase, or `null` if it fails ANY safety rule — the caller falls back to
 * `sectorScenePhrase(sector)` on `null`, exactly like a thrown provider error. Deliberately NOT
 * trimmed to a fixed word count the way `sanitizeDescriptor` is: a scene is a descriptive phrase,
 * not a 2-4-word caption, so an overlong response is rejected outright rather than chopped
 * mid-clause (chopping could as easily strip the trailing "no logos" implication of a well-formed
 * sentence as a redundant word).
 */
export function sanitizeScene(raw, { ticker } = {}) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
  s = s.replace(/\.+$/, "").trim();
  if (!s) return null;

  if (/\d/.test(s)) return null; // no numbers, ever — same rule buildImagePrompt itself enforces.
  if (/[$%]/.test(s)) return null;
  if (PRONOUN_RE.test(s)) return null;
  if (SCENE_BANNED_RE.test(s)) return null;
  if (ticker) {
    const re = new RegExp(`\\b${escapeRe(ticker)}\\b`, "i");
    if (re.test(s)) return null;
  }
  // A newline or any leftover sentence-ending punctuation (after the one trailing period already
  // stripped above) means the model kept talking past a single continuous phrase.
  if (/[\n\r]/.test(s) || /[.!?]/.test(s)) return null;

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < SCENE_MIN_WORDS || words.length > SCENE_MAX_WORDS) return null;
  return s;
}

/** Split one raw model response into its two labelled halves — `DESCRIPTOR: …` / `SCENE: …`, in
 *  either order, each captured up to end of line so one label's text never swallows the other's
 *  (see `buildDescriptorPrompt`'s "respond with exactly two lines" instruction). A missing label
 *  yields `null` for that half, which `describeCompany` treats as validation failure exactly like
 *  a `sanitize*` rejection — the whole response falls back together (see the module header on
 *  why a half-bad response is never partially cached). */
export function parseModelResponse(raw) {
  const s = String(raw ?? "");
  const descriptorMatch = s.match(/descriptor\s*:\s*(.+)/i);
  const sceneMatch = s.match(/scene\s*:\s*(.+)/i);
  return {
    descriptorRaw: descriptorMatch ? descriptorMatch[1] : null,
    sceneRaw: sceneMatch ? sceneMatch[1] : null,
  };
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
 * Build the { system, prompt } pair for one company — asking for BOTH the descriptor and the
 * image scene in one call (see the module header on why one call, not two). `row` is a
 * `src/data/stocks.json` entry (or the minimal `{ t, n, sec }` shape a hook still carries when
 * the row itself is unavailable — see `describeCompany` below): only `n` (name), `sec`, `px`,
 * `mc`, `desc`, and the `b`/`h`/`s` analyst-coverage triad are ever read.
 */
export function buildDescriptorPrompt(row) {
  const name = displayCompanyName(row?.n);
  const sector = String(row?.sec ?? "").trim();
  const analysts = coverage(row);
  const desc = trimDesc(row?.desc);

  const system = [
    "You write two short things for a stock-data card, both about the SAME company, both",
    "grounded in everything you already know about it plus the description you are given below.",
    "",
    "PART 1 — DESCRIPTOR: the identity line that sits directly beneath the company's name, half",
    "its size, the way a sharp editor would caption a photo of the business, not the way a",
    "filing would classify it.",
    "- 2 to 4 words. No more.",
    "- Say what the company actually DOES or IS — never just restate its stock sector as a",
    "  label. A sector bucket like \"General\" or \"Diversified\" describes a filing category, not",
    "  a business; ignore it as a description and describe the real business instead.",
    "- No ticker symbols. No numbers, digits, percentages, or dollar signs, ever.",
    "- No claims about performance, valuation, ratings, or analysts — this is an identity line,",
    "  not a stat. Never say upside, buy, sell, rating, target, over/undervalued, or similar.",
    "- Characterful and specific to this one company, not generic corporate-speak.",
    "",
    "PART 2 — SCENE: a short, concrete, photographable scene for an editorial stock photograph —",
    "ONE person actively doing real work specific to THIS company's actual business (a real job",
    "someone there might actually have), never a generic office scene and never the company's",
    "sector restated as a label. For a search/cloud company this might be an engineer checking a",
    "rack of servers in a data-centre hall; for a biotech, a technician calibrating lab equipment;",
    "always something concrete to THIS business, not a placeholder.",
    "- 6 to 20 words, one continuous phrase — no full stop, no second sentence.",
    "- Depict hands-on physical work: hands, tools, equipment, or materials visible and doing",
    "  something, not a person merely standing near their work.",
    "- Never mention the person's gender or use a pronoun (he/she/his/her/woman/man) — the",
    "  phrase must read naturally immediately after EITHER \"a woman \" or \"a man \", which is",
    "  added separately afterward.",
    "- Prefer physical work, equipment, and materials over a screen or monitor as the main",
    "  subject of the scene.",
    "- No text, no numbers, no logos, no brand marks, no charts, no graphs, no signage of any",
    "  kind anywhere in the scene — describe the real-world equivalent instead.",
    "",
    "Respond with EXACTLY two lines and nothing else:",
    "DESCRIPTOR: <the 2-4 word descriptor>",
    "SCENE: <the scene description>",
  ].join("\n");

  const facts = [
    `Company: ${name}`,
    sector ? `TipRanks sector (approximate, often wrong or unclassified — do not just restate it): ${sector}` : null,
    Number.isFinite(row?.mc) ? `Market cap: ~$${row.mc}M` : null,
    Number.isFinite(row?.px) ? `Share price: ~$${row.px}` : null,
    analysts ? `Analyst coverage: ${analysts} analysts` : null,
    desc ? `What the company does:\n${desc}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `${facts}\n\nWrite the descriptor and the scene.`;
  return { system, prompt };
}

/**
 * Resolve one company's descriptor AND scene together: cache hit, then a single model call, then
 * the deterministic sector fallback for BOTH — in that order, and the caller never has to catch
 * anything (mirrors `generateImage`'s "never throw, always resolve" shape in
 * ci/post-image.mjs). Returns `{ descriptor, scene }`, always both non-empty strings.
 *
 * @param row a `src/data/stocks.json` row (or the `{ t, n, sec }` minimal shape).
 * @param provider the SAME text provider ci/provider.mjs builds for the post's own copy — this
 *   is one extra call per PUBLISHED post, never per candidate (the caller in
 *   ci/generate-posts.mjs invokes this exactly once per hook, after `pickBest`, not inside the
 *   candidate loop), so it costs nothing close to what the 5-candidate text generation already
 *   spends, and it is still ONE call for both the descriptor and the scene (see the module
 *   header) rather than two.
 * @param cache a plain object the caller persists to disk (`src/data/company-descriptors.json`)
 *   across runs — `{ [ticker]: { name, descriptor, scene } }`. Mutated in place on a fresh
 *   success where BOTH halves validate; never written to when either half falls back, so a
 *   transient or partial failure gets retried next run instead of freezing a wrong (or
 *   half-wrong) answer forever. An older cache entry saved before this module gained `scene`
 *   (descriptor only) is treated as a miss, not a hit, and transparently upgraded on next use.
 */
export async function describeCompany({ row, provider, cache }) {
  const ticker = row?.t;
  const name = displayCompanyName(row?.n);
  const sector = row?.sec;

  const cached = ticker && cache ? cache[ticker] : null;
  if (cached && cached.name === name && cached.descriptor && cached.scene) {
    return { descriptor: cached.descriptor, scene: cached.scene };
  }

  const fallback = () => ({ descriptor: descriptorFor(sector), scene: sectorScenePhrase(sector) });

  try {
    if (typeof provider !== "function") throw new Error("no provider");
    const { system, prompt } = buildDescriptorPrompt(row);
    const [raw] = await provider({ system, prompt, n: 1 });
    const { descriptorRaw, sceneRaw } = parseModelResponse(raw);
    const descriptor = sanitizeDescriptor(descriptorRaw, { ticker });
    const scene = sanitizeScene(sceneRaw, { ticker });
    if (!descriptor || !scene) {
      throw new Error(`model response failed validation: ${JSON.stringify(raw)}`);
    }
    if (cache && ticker) cache[ticker] = { name, descriptor, scene };
    return { descriptor, scene };
  } catch (err) {
    console.error(`  ${ticker ?? "?"}: descriptor/scene generation fell back — ${err?.message ?? err}`);
    return fallback();
  }
}
