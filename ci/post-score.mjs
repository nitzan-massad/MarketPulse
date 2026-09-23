// THE JUDGE — turns N candidates into the one that ships, with no model involved.
//
// This is the whole reason a free 8B model is viable here. One shot from a weak model is
// a coin flip; five shots plus a strict deterministic filter is reliable. The filter is
// blunt on purpose — it cannot tell good from great, but it reliably kills the three
// things that make a post read as machine-written: stock LLM phrasing, no concrete
// numbers, and saying what we already said last run.
//
// It also kills the one thing that would be worse than a machine-written post: a number
// that is not true of the company being named. See `unverifiedNumbers` below — that check
// is the only rule here about TRUTH rather than style, and it is a hard rejection, not a
// deduction, because posts.json ships to public main and into the JS bundle.
//
// A ticker symbol gets the same hard-rejection treatment (`TICKER_PENALTY`, below): the post
// text now sits burned into the image next to the company's real name (ci/post-compose.mjs),
// so "IRD soared 151.7%" reading next to "Opus Genetics" is a glaring, published mistake, not
// a style nit. This is the backstop; the root-cause fix is ci/hooks.mjs's `deTickerHooks`,
// which strips tickers out of a hook's facts before any candidate is ever written.
//
// Validated in Task 0 against real candidates: slop scored -93, good copy 86. It does NOT
// separate fine from great — three good candidates tied at 86 because the digit bonus
// caps at +16 and saturates, and ties break alphabetically. That ceiling is accepted on
// purpose. The lever for better copy is ci/style-corpus.json, not a cleverer formula here.

/** Phrases that mark copy as machine-written. Lowercase; matched as substrings. */
export const BANNED = [
  "let's dive in", "lets dive in", "dive into", "in the world of", "in today's",
  "game-changer", "game changer", "delve", "buckle up", "look no further",
  "it's important to note", "that being said", "when it comes to", "the bottom line is",
  "unlock the", "harness the", "navigate the", "landscape of", "testament to",
  "remember, ", "disclaimer:", "as an ai", "in conclusion", "furthermore",
  "skyrocket", "to the moon", "🚀🚀",
];

/** Below this, publish nothing. A skipped run beats a bad post. */
export const MIN_PUBLISHABLE = 30;

// THE HEADLINE LIMIT — 8 WORDS, not characters. The feed card (src/components/PostFeed.tsx)
// now overlays the post text large and bold directly on the image; it reads as a headline,
// not a caption, and has to be readable at a glance. This replaces the old character band
// (`IDEAL = { min: 25, max: 110 }`): a post can pack five numeral-heavy words into 60
// characters, or one long compound word into 12 — character count never tracked "does this
// read like a headline", word count does.
//
// MAX_WORDS=8 is a hard ceiling: over it is penalised hard enough that a 12-word candidate
// loses to an 8-word one even after the longer one's larger digit bonus (see the worked
// example in ci/test-post-score.mjs). MIN_WORDS=3 is the floor below which a "post" is a
// fragment, not a claim — enough for "$NAME up 42%." to be a complete sentence, not enough
// for a bare "NVDA up." to earn a pass.
export const MAX_WORDS = 8;
export const MIN_WORDS = 3;

/** A word is a run of non-space characters — "$174.25" and "42%" each count as one word,
 *  the way a person reading the sentence aloud would count them. */
const wordCount = (s) => (String(s).trim().match(/\S+/g) ?? []).length;

/** The distinctive leading word of a company name, so a post can name the company instead of
 *  the ticker. "Xpo, Inc." -> "Xpo"; "Praxis Precision Medicines" -> "Praxis". Corporate
 *  suffixes alone are never a match — "Inc" must not count as naming anything. */
export function nameStem(name) {
  const first = String(name ?? "").trim().split(/[\s,.]+/)[0] ?? "";
  return /^(inc|corp|co|ltd|plc|the|llc|sa|nv|ag)$/i.test(first) || first.length < 3 ? "" : first;
}

/** Word set for cheap near-duplicate detection — Jaccard over lowercased words >3 chars. */
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z$%\d.]{4,}/g) ?? []);
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / (a.size + b.size - hit);
};

/** A number written the way a person writes one: 38, 38.6, 1,240, $174.25 (the `$` and `%`
 *  are not part of the token). No sign — "-5%" yields 5, and the fact side is compared on
 *  absolute value so that still lines up. */
const NUM_TOKEN_RE = /\d[\d,]*(?:\.\d+)?/g;

/** Every number the hook actually vouches for, INCLUDING the ones packed inside string facts —
 *  the `list` kind puts its whole board in one string ("IRD (120.4% to $41), PRAX (98.1% to
 *  $732)"), and those are real, sourced numbers a candidate is entitled to quote. */
export function factNumbers(facts) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "number") {
      if (Number.isFinite(v)) out.add(Math.abs(v));
    } else if (typeof v === "string") {
      for (const m of v.match(NUM_TOKEN_RE) ?? []) {
        const n = Number(m.replace(/,/g, ""));
        if (Number.isFinite(n)) out.add(Math.abs(n));
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(facts ?? {});
  return out;
}

/** Roundings a writer may legitimately apply to a sourced number: nearest integer,
 *  truncation, and one decimal place. Deliberately NOT `Math.ceil` — "$175" must not be
 *  allowed to stand in for a $174.25 price target. */
const vouchedBy = (n, vouched) => {
  for (const f of vouched) {
    if (n === f || n === Math.round(f) || n === Math.trunc(f) || n === Math.round(f * 10) / 10) return true;
  }
  return false;
};

/**
 * NUMBER VERIFICATION — the one rule in this file that is about truth rather than style.
 *
 * `src/data/posts.json` is committed to public `main` AND `import`ed into the JS bundle, so a
 * post claiming a number that is not true of the company it names is publicly retrievable even
 * with the feature flag off. Everything else here rewards digits (+2 each, capped +16) without
 * ever asking whether they are real, so before this check the only guard against a fabricated
 * figure was one line of prompt text enforced by an 8B model at temperature 0.95.
 *
 * A candidate number is accepted when it is in `hook.facts` (or is a legitimate rounding of one
 * — see `vouchedBy`). Two idioms are exempt because they state a SCALE, not a claim about the
 * company: "out of 10" / "1/10" (Smart Score is 1-10) and "out of 100" (AI Score is 0-100),
 * which Task 0's best-scoring candidate uses; and a bare four-digit year. The exemption is
 * idiom-scoped on purpose — a bare "$100 target" on a $412 name is still caught.
 *
 * Fails CLOSED: a hook that carries no facts vouches for nothing, so every number in the
 * candidate is unverified. Every hook `ci/hooks.mjs` emits carries facts. With no hook at all
 * there is nothing to check against and nothing is claimed about any company, so it is skipped.
 *
 * The predicate is `unverifiedNumbers(text, hook).length === 0`.
 *
 * @returns {string[]} the offending tokens, in order of appearance. Empty means clean.
 */
export function unverifiedNumbers(text, hook) {
  if (!hook) return [];
  const s = String(text ?? "");
  const vouched = factNumbers(hook.facts);
  const bad = [];

  for (const m of s.matchAll(NUM_TOKEN_RE)) {
    const tok = m[0];
    const n = Number(tok.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    if (vouchedBy(n, vouched)) continue;

    // "…out of 10", "…out of 100", "8/10" — the scale, not a claim.
    const before = s.slice(Math.max(0, m.index - 8), m.index);
    if ((n === 10 || n === 100) && /(?:out of|\/)\s*$/i.test(before)) continue;
    // A bare year. Never "$2000" (a price) and never "2000%" (an upside).
    if (/^\d{4}$/.test(tok) && n >= 1900 && n <= 2100 &&
        !before.endsWith("$") && s[m.index + tok.length] !== "%") continue;

    bad.push(tok);
  }
  return bad;
}

/** A fabricated number is not a style flaw, it is a false public claim, so this has to beat
 *  every bonus in `scorePost` combined (ceiling 50 + 16 + 10 + 10 = 86) by a clear margin.
 *  A rejected candidate lands at most at -64, well under MIN_PUBLISHABLE. */
export const FABRICATION_PENALTY = 150;

/** A ticker beat the fabrication check once and still shipped ("IRD soared 151.7% to
 *  $13.14.") because the old penalty was a plain -20 nudge: a candidate could still clear
 *  MIN_PUBLISHABLE (30) against the same 86-point ceiling the fabrication penalty is sized
 *  against. This is now decisive the same way: 86 - 100 = -14, comfortably under
 *  MIN_PUBLISHABLE regardless of what else the candidate earns (digits, length, even naming
 *  the company correctly elsewhere in the same sentence). Root cause is fixed upstream —
 *  ci/hooks.mjs's `deTickerHooks` strips tickers out of a hook's facts before any candidate is
 *  even written — this is the backstop for a model that names one anyway. */
export const TICKER_PENALTY = 100;

/** Same reported bug, same fix shape, different half of the sentence: "IRD soared 151.7% to
 *  $13.14" was ALSO wrong because "soared" claims something happened to the stock's PRICE, and
 *  151.7% was analyst upside-to-target, not a price move that occurred. The number was real —
 *  the verb lied about what it meant. Decisive for the same reason TICKER_PENALTY is: a model
 *  reaching for punchier verbs (the whole point of the bolder-copy rewrite) has to be stopped
 *  from reaching for a FALSE one just as hard as it is stopped from reaching for a ticker. */
export const MISDESCRIBED_MOVEMENT_PENALTY = 100;

/** Fact keys that describe a TARGET, a SCORE, a FORECAST, or a RATING — never something that
 *  has already happened to the stock's price. Matched against a fact's KEY (case-insensitively),
 *  not its value, so this generalises to a future key with no edit here. Deliberately does NOT
 *  match a bare "price"/"px" style key — a genuine realized price figure is exactly the kind of
 *  number a movement verb is allowed to describe (see `misdescribedMovementVerbs`'s own doc for
 *  a worked example; no hook ci/hooks.mjs emits today carries one, which is itself the reason
 *  these verbs are effectively always wrong in this app's current data — but the check is
 *  written against the SHAPE of the data, not today's specific hook kinds). */
const FORECAST_KEY_RE = /target|score|upside|forecast|rating|consensus/i;

/** Verbs that assert a stock's PRICE already moved. The task names five (soared, plunged,
 *  rocketed, crashed, jumped); a longer list of close synonyms is folded in too ("and the
 *  like") since a model told to avoid "jumped" reaches for "spiked" next — `plummeted` is a
 *  real example: a live generation run used it for a Smart Score drop ("Smart Score plummeted
 *  from 9 to 5") before it was added here, the exact same category error as "IRD soared
 *  151.7%" with a different verb. Matched on the verb root so any tense/inflection trips it.
 *  `skyrocket` is deliberately NOT here — it is already a hard BANNED phrase above regardless
 *  of context, as generic AI-slop, not because of what it might be describing. */
export const MOVEMENT_VERB_RE =
  /\b(soar(?:ed|s|ing)?|plunge(?:d|s|ing)?|plummet(?:ed|s|ing)?|rocket(?:ed|s|ing)?|crash(?:ed|es|ing)?|jump(?:ed|s|ing)?|surge(?:d|s|ing)?|spike(?:d|s|ing)?|tank(?:ed|s|ing)?|craters?(?:ed|ing)?|tumble(?:d|s|ing)?|nosedive[ds]?|nosediving|dove|dived|sank|skid(?:ded|s|ding)?)\b/gi;

/**
 * A movement verb (soared/plunged/rocketed/crashed/jumped/…) is a claim that something
 * happened to the stock's PRICE — a lie, not bold framing, when the number it sits next to is
 * actually a price TARGET, a Smart/AI SCORE, an upside FORECAST, or a consensus RATING, none of
 * which are a price that has moved (see the module header — this is the exact published bug,
 * "IRD soared 151.7% to $13.14", where 151.7% was upside-to-target, not a price move).
 *
 * Returns the offending verb(s), or `[]` when either no such verb is used, or every number the
 * candidate states is vouched for by a fact that is NOT target/score/forecast-shaped — the
 * genuinely-descriptive case the task asks to keep passing. No hook ci/hooks.mjs emits today
 * carries a real price-delta fact, so in practice this fires whenever the verb is used at all
 * over one of these hooks; a hypothetical future fact describing an actual price move (e.g.
 * `priceFrom`/`priceTo`) would license it, which is exactly what this is built to allow.
 */
export function misdescribedMovementVerbs(text, hook) {
  const s = String(text ?? "");
  MOVEMENT_VERB_RE.lastIndex = 0;
  const verbs = s.match(MOVEMENT_VERB_RE);
  if (!verbs || !verbs.length) return [];
  const facts = hook?.facts;
  if (!facts || typeof facts !== "object") return [];

  const unsafeNumbers = new Set();
  for (const [k, v] of Object.entries(facts)) {
    if (!FORECAST_KEY_RE.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      unsafeNumbers.add(Math.abs(v));
    } else if (typeof v === "string") {
      for (const m of v.match(NUM_TOKEN_RE) ?? []) {
        const n = Number(m.replace(/,/g, ""));
        if (Number.isFinite(n)) unsafeNumbers.add(Math.abs(n));
      }
    }
  }
  if (!unsafeNumbers.size) return [];

  for (const m of s.matchAll(NUM_TOKEN_RE)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n) && vouchedBy(n, unsafeNumbers)) return verbs;
  }
  return [];
}

export function scorePost(text, ctx = {}) {
  const { hook, recent = [] } = ctx;
  const s = String(text ?? "").trim();
  const lower = s.toLowerCase();
  const reasons = [];
  let score = 50;

  for (const phrase of BANNED) {
    if (lower.includes(phrase)) {
      score -= 25;
      reasons.push(`banned phrase: "${phrase}"`);
    }
  }

  const digits = (s.match(/\d/g) ?? []).length;
  if (digits === 0) {
    // -35, not -30: with the length-band's own +10 best case, -30 nets to EXACTLY
    // MIN_PUBLISHABLE (50-30+10=30) for any short, clean, digit-free sentence — which used to
    // be caught anyway by the old "does not name the company" -20 whenever the hook had a
    // name. That penalty is gone now that naming is no longer required (see the naming block
    // below), so a digit-free, contextless candidate has to be sunk on its own: -35 makes the
    // no-digits case decisive against the best possible length-band bonus (50-35+10=25 <30) on
    // its own, with no dependency on what else the candidate did or did not name.
    score -= 35;
    reasons.push("no numbers — not a data post");
  } else {
    score += Math.min(digits * 2, 16);
    reasons.push(`${digits} digits of concrete detail`);
  }

  // …and now check that those digits are TRUE, not just present. Decisive, not a nudge.
  const invented = unverifiedNumbers(s, hook);
  if (invented.length) {
    score -= FABRICATION_PENALTY;
    reasons.push(
      `unverified number${invented.length === 1 ? "" : "s"} not in the hook's facts: ${invented.join(", ")}`,
    );
  }

  // Ticker BAD, always — but naming the company is no longer REQUIRED. The composed card
  // (ci/post-compose.mjs) already prints the company name large above this text, so the old
  // reward for naming it (+10) and penalty for omitting it (-20) fought the prompt's own
  // instruction not to repeat a name that is already on the card (see ci/generate-posts.mjs's
  // system prompt, and defect F in the task this fixed: "Astera Labs, Inc." printed once by
  // the card and again, redundantly, by the statement). A ticker is unaffected by any of this
  // — the feed cards show "Netflix", never "NFLX", and a ticker sitting next to the company's
  // real printed name is a glaring published mistake, not a stylistic quirk, so it is still a
  // hard, decisive rejection.
  //
  // Naming the company is left NEUTRAL, not penalised either way, rather than removed outright:
  // some sentences read more naturally with the name in them (a `list` post naming its leader,
  // for instance), and there is no reason to fight a candidate that happens to include it. What
  // must NOT happen is a nameless, contextless candidate suddenly scoring well just because this
  // penalty is gone — and it does not, because every OTHER quality gate here is untouched: no
  // digits still costs -35 ("not a data post"), the length band, banned phrases, fabrication,
  // the ticker penalty itself, and dedupe all still apply exactly as before. Removing a rule
  // about NAMING never makes a post more truthful or more concrete.
  //
  // The ticker check is a STANDALONE-TOKEN, CASE-SENSITIVE match (`\bTICKER\b`), not a
  // substring test, for two reasons pulling opposite ways:
  //   - a short ticker is often a substring of an ordinary word ("ALL" inside "call"); word
  //     boundaries stop that. Case-sensitivity also stops a common lowercase word from
  //     tripping a ticker that happens to be a real English word ("on" vs the ON ticker) —
  //     a person writing a ticker symbol writes it in caps.
  //   - some companies' names ARE (or start with) their own ticker, spelled identically
  //     apart from case — hook `IRD` / "Ird Holdings" is a real example already covered
  //     below. Naming the company there ALSO satisfies `\bIRD\b` case-insensitively, so
  //     `tickerIsTheName` recognises that coincidence and does not charge the ticker penalty
  //     for what is actually just the company's own name.
  if (hook?.ticker || hook?.name) {
    const stem = nameStem(hook?.name);
    const ticker = hook?.ticker;
    const tickerHit = Boolean(ticker && new RegExp(`\\b${ticker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(s));
    const nameMatch = Boolean(stem && lower.includes(stem.toLowerCase()));
    const tickerIsTheName = Boolean(stem && ticker && stem.toUpperCase() === ticker.toUpperCase());
    const tickerMatch = tickerHit && !tickerIsTheName;

    if (tickerMatch) {
      score -= TICKER_PENALTY;
      reasons.push(`names the ticker ${ticker} instead of the company`);
    } else if (nameMatch) {
      // Informational only — the card already shows the name, so this is neither rewarded
      // nor required (see above). Kept in `reasons` for visibility when debugging a score.
      reasons.push(`names ${stem}`);
    }
  }

  // A movement verb (soared/plunged/rocketed/…) claiming a price move that the number it
  // touches does not actually show — see MISDESCRIBED_MOVEMENT_PENALTY's own doc. Bold framing
  // of a true fact is the goal; a verb that misdescribes what the number MEANS is not, and is
  // just as serious as a fabricated number even though every digit in it is real.
  const badVerbs = misdescribedMovementVerbs(s, hook);
  if (badVerbs.length) {
    score -= MISDESCRIBED_MOVEMENT_PENALTY;
    reasons.push(
      `movement verb misdescribes a target/score/forecast number: ${[...new Set(badVerbs)].join(", ")}`,
    );
  }

  const nWords = wordCount(s);
  if (nWords < MIN_WORDS) {
    score -= 25;
    reasons.push(`too short (${nWords} word${nWords === 1 ? "" : "s"} < ${MIN_WORDS})`);
  } else if (nWords > MAX_WORDS) {
    // Same shape as the old character penalty: escalates with the overage, capped so this
    // one rule is never the sole reason a candidate is or isn't publishable. 4 words over
    // (the task's own worked example, 12 vs. 8) costs 48 — comfortably more than the length
    // band's own +10 best case plus the digit bonus a longer sentence tends to also pick up.
    score -= Math.min((nWords - MAX_WORDS) * 12, 60);
    reasons.push(`too long (${nWords} words > ${MAX_WORDS})`);
  } else {
    score += 10;
    reasons.push("length in band");
  }

  // Hashtag spam is the loudest bot tell after stock phrasing.
  const tags = (s.match(/#\w+/g) ?? []).length;
  if (tags > 3) {
    score -= (tags - 3) * 8;
    reasons.push(`${tags} hashtags`);
  }

  // Exclamation-mark density.
  const bangs = (s.match(/!/g) ?? []).length;
  if (bangs > 1) {
    score -= bangs * 6;
    reasons.push(`${bangs} exclamation marks`);
  }

  const w = words(s);
  let worst = 0;
  let tickerRepeat = false;
  for (const r of recent) {
    const sim = jaccard(w, words(r?.text ?? ""));
    if (sim > worst) worst = sim;
    if (!tickerRepeat && r?.ticker && hook?.ticker && r.ticker === hook.ticker) tickerRepeat = true;
  }
  if (tickerRepeat) {
    score -= 12;
    reasons.push(`${hook.ticker} appeared in a recent post`);
  }
  if (worst > 0.35) {
    score -= Math.round(worst * 80);
    reasons.push(`duplicate of a recent post (${Math.round(worst * 100)}% word overlap)`);
  }

  return { score: Math.round(score), reasons };
}

export function pickBest(candidates, ctx = {}) {
  const ranked = (candidates ?? [])
    .map((text) => ({ text: String(text ?? "").trim(), ...scorePost(text, ctx) }))
    .filter((c) => c.text)
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  const top = ranked[0];
  return top && top.score >= MIN_PUBLISHABLE ? top : null;
}
