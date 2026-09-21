// THE JUDGE — turns N candidates into the one that ships, with no model involved.
//
// This is the whole reason a free 8B model is viable here. One shot from a weak model is
// a coin flip; five shots plus a strict deterministic filter is reliable. The filter is
// blunt on purpose — it cannot tell good from great, but it reliably kills the three
// things that make a post read as machine-written: stock LLM phrasing, no concrete
// numbers, and saying what we already said last run.
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
