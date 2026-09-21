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

// ULTRA SHORT. Validated in Task 0: the winning posts land at 51-62 characters.
// 110 is a hard ceiling, not a target — a post at 105 scores no worse than one at 55,
// so the system prompt and the corpus are what actually pull length down; this band
// only rejects the outliers.
const IDEAL = { min: 25, max: 110 };

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
    score -= 30;
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

  // Ticker OR company name. The feed cards show "Netflix", not "NFLX", so a ticker-only
  // rule punishes exactly the copy we want — it scored the good NFLX candidate at 10 with
  // "missing NFLX" during Task 0. `nameStem` is the distinctive first word, so "Netflix"
  // matches "Netflix, Inc." and "Praxis" matches "Praxis Precision Medicines".
  if (hook?.ticker || hook?.name) {
    const stem = nameStem(hook?.name);
    const tickerMatch = hook?.ticker && s.includes(hook.ticker);
    const nameMatch = stem && lower.includes(stem.toLowerCase());
    if (tickerMatch || nameMatch) {
      score += 10;
      const matched = tickerMatch ? hook.ticker : stem;
      reasons.push(`names ${matched}`);
    } else {
      score -= 20;
      reasons.push(`does not name ${hook.ticker ?? stem}`);
    }
  }

  if (s.length < IDEAL.min) {
    score -= 25;
    reasons.push(`too short (${s.length} < ${IDEAL.min})`);
  } else if (s.length > IDEAL.max) {
    score -= Math.min(Math.ceil((s.length - IDEAL.max) / 20) * 5, 40);
    reasons.push(`too long (${s.length} > ${IDEAL.max})`);
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
