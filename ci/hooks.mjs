// WHAT A POST IS ABOUT — chosen by rules over a 30-snapshot window, never by an LLM.
//
// Ask a model "what's interesting here" and it picks the same safe thing every run.
// Deterministic rules give variety AND reproducibility: the same window always yields the
// same ranked hooks, so a bad post can be traced to a rule instead of a temperature.
//
// The window is the whole point. Two snapshots can only say "this moved since 5h ago".
// Thirty say "a six-day high", "sliding all week", "hasn't left a 10 since Monday" — the
// things people actually repost. Task 0 measured the cost: 0.68s and 18.6MB.
//
// Every constant here was calibrated against the live data. Read Task 0's findings before
// changing one; three of them exist because the naive version produced a visibly bad feed.

/** Upside above this is a data artifact, not a call. */
export const SANE_MAX_UPSIDE = 200;

/** Below this many snapshots, the window rules stay silent rather than firing on a thin
 *  series — a "30-run high" off four readings is not a fact worth posting. */
export const MIN_WINDOW = 10;

/** (12) Comparison framing — below this many eligible rows in a sector THIS run, that sector's
 *  "typical" upside is not a real typical, it is two or three names. */
export const MIN_SECTOR_PEERS = 3;

/** (12) Comparison framing — a name's own upside has to clear its sector's median by at least
 *  this many points before the gap is worth stating as a comparison; anything closer just reads
 *  as noise around the middle. */
export const MIN_COMPARISON_GAP = 10;

const DEFAULTS = { minMc: 300, minPx: 3, minAnalysts: 4, limit: 12, maxPerKind: 2, recentKinds: [] };

/** Analysts covering the name. TipRanks splits the count across three fields. */
export const coverage = (r) => (r?.b ?? 0) + (r?.h ?? 0) + (r?.s ?? 0);

export function eligible(row, opts = {}) {
  const { minMc, minPx, minAnalysts } = { ...DEFAULTS, ...opts };
  return (
    Number.isFinite(row?.mc) && row.mc >= minMc &&
    Number.isFinite(row?.px) && row.px >= minPx &&
    Number.isFinite(row?.up) && row.up > 0 && row.up <= SANE_MAX_UPSIDE &&
    // Task 0, Finding 3: AGEN cleared cap and price but carried 148% upside on two
    // analysts. A "target" two people agree on is not a consensus worth posting.
    coverage(row) >= minAnalysts
  );
}

const round = (n) => Math.round(n * 10) / 10;
const base = (r, kind, score, facts) => ({
  kind, ticker: r.t, name: r.n, sec: r.sec, score: round(score), facts,
});

/** Bigger companies are more recognisable, so the same move is more postable. Log so a
 *  mega-cap does not simply always win. */
const prominence = (r) => Math.log10(Math.max(r.mc, 1)) / 6;

const isNum = (v) => Number.isFinite(v);

/**
 * @param history snapshots OLDEST FIRST; the last element is the current one.
 */
export function detectHooks(history, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const snaps = Array.isArray(history) ? history.filter(Array.isArray) : [];
  if (!snaps.length) return [];

  const curr = snaps[snaps.length - 1];
  const rows = curr.filter((r) => eligible(r, o));
  if (!rows.length) return [];

  // (12) COMPARISON FRAMING — a name's own number next to what is TYPICAL for its sector this
  // run, so a candidate can say "42% upside, more than double its sector's usual 18%" instead of
  // stating 42% in isolation. Derived entirely from THIS snapshot's own eligible rows — no new
  // data source, nothing scraped or invented — grouped by `sec` and reduced to a MEDIAN, not a
  // mean: `eligible()` already allows upside up to SANE_MAX_UPSIDE (200%), and one outlier at the
  // top of that range would drag a sector "average" somewhere no individual name resembles.
  // Attached to a hook's facts only when (a) the sector has at least MIN_SECTOR_PEERS eligible
  // rows this run — a "typical" figure from two names is not a comparison worth publishing — and
  // (b) the caller decides the name's own number is far enough from that median to be worth the
  // contrast (see the `surprise`/`record` call sites below); a name sitting AT its sector's
  // median has nothing to compare itself against.
  const bySectorUpside = new Map();
  for (const r of rows) {
    if (!isNum(r.up)) continue;
    if (!bySectorUpside.has(r.sec)) bySectorUpside.set(r.sec, []);
    bySectorUpside.get(r.sec).push(r.up);
  }
  const sectorMedianUpside = new Map();
  for (const [sec, ups] of bySectorUpside) {
    if (ups.length < MIN_SECTOR_PEERS) continue;
    const sorted = [...ups].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    sectorMedianUpside.set(sec, round(median));
  }
  /** Only worth naming a comparison when the two numbers would actually read as different —
   *  paired with `sectorMedianUpside` above at each call site, never applied globally, since
   *  what counts as "meaningfully different" is a judgement the hook that fires gets to make. */
  const comparableSectorMedian = (r) => {
    const med = sectorMedianUpside.get(r.sec);
    return isNum(med) && Math.abs(r.up - med) >= MIN_COMPARISON_GAP ? med : null;
  };

  // ELIGIBLE rows only, exactly like the window series below. An ineligible previous reading
  // (a name that was a sub-$3 penny, or had no upside at all) is not a baseline anything can
  // legitimately be quoted "from".
  const prevSnap = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const before = new Map((prevSnap ?? []).filter((r) => eligible(r, o)).map((r) => [r.t, r]));

  // Per-ticker series across the window, eligible readings only, oldest first.
  const series = new Map();
  if (snaps.length >= MIN_WINDOW) {
    snaps.forEach((snap, i) => {
      for (const r of snap) {
        if (!eligible(r, o)) continue;
        if (!series.has(r.t)) series.set(r.t, []);
        series.get(r.t).push({ i, up: r.up, ss: r.ss, con: r.con });
      }
    });
  }
  const windowOpen = snaps.length >= MIN_WINDOW;
  /** A name counts as present from the start if it appears in the first fifth of the window. */
  const earlyCut = Math.max(1, Math.floor(snaps.length / 5));

  // Task 0, Finding 2: live data skews heavily to one kind, so the top hook was the same
  // SHAPE every run. Damping by how recently a kind was used rotates the feed.
  const damp = (k) => 1 / (1 + o.recentKinds.filter((x) => x === k).length);

  const hooks = [];

  for (const r of rows) {
    const prom = 1 + prominence(r);

    // 1. SURPRISE — the number itself is the story.
    if (r.up >= 40) {
      const facts = {
        upside: round(r.up), price: r.px, priceTarget: r.pt,
        consensus: r.con, analysts: coverage(r), sector: r.sec,
      };
      // (12) Comparison framing — only when it is cleanly derivable AND worth the contrast
      // (see `comparableSectorMedian` above).
      const secMed = comparableSectorMedian(r);
      if (isNum(secMed)) facts.sectorMedianUpside = secMed;
      hooks.push(base(r, "surprise", (r.up / SANE_MAX_UPSIDE) * 100 * prom * damp("surprise"), facts));
    }

    // 2. CONTRARIAN — the two models point opposite ways. ss is 1-10 and ai is 0-100, so
    //    compare on a common 0-100 scale.
    if (isNum(r.ss) && isNum(r.ai)) {
      const gap = r.ss * 10 - r.ai;
      if (Math.abs(gap) >= 40) {
        hooks.push(base(r, "contrarian", Math.abs(gap) * prom * damp("contrarian"), {
          smartScore: r.ss, aiScore: r.ai, aiRating: r.air,
          consensus: r.con, upside: round(r.up), price: r.px, analysts: coverage(r),
          bullish: gap > 0 ? "quant" : "ai",
        }));
      }
    }

    // 3. MOVEMENT — what changed since the last run. Coefficients are deliberately heavy
    //    (Task 0, Finding 4): with the naive weights all 11 real movements in the live
    //    snapshot lost to static high-upside names and none reached the top 12.
    //
    //    A SMART SCORE MOVE ALONE NO LONGER FIRES THIS. The user's explicit call: "a change
    //    in smart score is not something that's good enough for a post" — TipRanks' Smart
    //    Score is a 1-10 quant rating, and a post whose entire story is that rating moving is
    //    weak content that also invites misleading copy (a live post said a Smart Score jump
    //    happened "overnight" when the window behind it was 6.3 days). Only a real upside
    //    change or a consensus flip may trigger this hook now; Smart Score's own dedicated
    //    "the whole story is the rating" kinds (`trend`, the net drift across the window, and
    //    `churn`, how many distinct scores it has shown) are gone entirely — see the bottom of
    //    this file's window-rules section, where they used to live. `contrarian` (above) is
    //    NOT affected: that hook is about the quant model DISAGREEING with the AI model, a
    //    comparison between two ratings, not a change in either one.
    const p = before.get(r.t);
    if (p) {
      const dSs = isNum(r.ss) && isNum(p.ss) ? r.ss - p.ss : 0;
      const dUp = isNum(p.up) ? r.up - p.up : 0;
      const flipped = p.con !== r.con;
      if (Math.abs(dUp) >= 15 || flipped) {
        const mag = Math.abs(dSs) * 25 + Math.abs(dUp) * 1.5 + (flipped ? 40 : 0);
        // NO COERCION, on any key. These facts go verbatim into the writer prompt, and the
        // model is told to use the numbers it is given, so `?? 0` would put "upsideFrom: 0"
        // into a post about a name whose target was merely withdrawn, and a null consensus
        // would arrive as the literal string "null". CLAUDE.md's standing rule for `ss`
        // applies to `up`, `con` and `pt` the same way: an explicit null from TipRanks is
        // data, not a gap — omit the key rather than invent a value for it. Every key below
        // is written exactly as before when the reading is present.
        // Built key by key, in the order they used to be written, so the prompt reads the
        // same for a row with every reading present. `upsideFrom` is also guarded even
        // though `before` is now eligible-filtered (which already guarantees a finite `up`)
        // — defence in depth, and it costs nothing. UPSIDE AND CONSENSUS COME FIRST, ON
        // PURPOSE: they are what fired this hook, so they are what the model sees first.
        const facts = {};
        if (isNum(p.up)) facts.upsideFrom = round(p.up);
        facts.upsideTo = round(r.up);
        // Consensus is per-side, not a pair: a flip out of "no rating" into Strong Buy is
        // real news, and dropping `consensusTo` with it would leave the hook with nothing to
        // say. Smart Score stays a pair — `dSs` is 0 unless BOTH readings are finite, so a
        // hook can never fire on a half-known Smart Score the way it can on a consensus flip.
        if (p.con) facts.consensusFrom = p.con;
        if (r.con) facts.consensusTo = r.con;
        facts.price = r.px;
        if (isNum(r.pt)) facts.priceTarget = r.pt;
        facts.analysts = coverage(r);
        facts.sector = r.sec;
        // SMART SCORE IS LAST, AND ONLY WHEN IT ACTUALLY CHANGED — supporting colour on a
        // real upside/consensus story, never the lead, and never restated unchanged ("held at
        // 8" is `steady`'s job, not a footnote on a fact bag it did not cause to fire).
        if (isNum(p.ss) && isNum(r.ss) && p.ss !== r.ss) {
          facts.smartScoreFrom = p.ss;
          facts.smartScoreTo = r.ss;
        }
        hooks.push(base(r, "movement", mag * prom * damp("movement"), facts));
      }
    }

    // ------------------------------- window rules -------------------------------
    const hist = windowOpen ? series.get(r.t) : null;
    if (!hist || hist.length < MIN_WINDOW) continue;

    const ups = hist.map((x) => x.up).filter(isNum);
    const sss = hist.map((x) => x.ss).filter(isNum);

    // 4. RECORD — today's upside is the highest in the window, by a margin that matters.
    if (ups.length >= MIN_WINDOW) {
      const low = Math.min(...ups), high = Math.max(...ups);
      if (r.up >= high - 0.01 && r.up - low >= 20) {
        const facts = {
          upside: round(r.up), windowLow: round(low), windowHigh: round(high),
          snapshots: hist.length, days: round((hist.length * 5) / 24),
          price: r.px, priceTarget: r.pt, analysts: coverage(r),
        };
        // (12) Comparison framing, same rule as `surprise` above.
        const secMed = comparableSectorMedian(r);
        if (isNum(secMed)) facts.sectorMedianUpside = secMed;
        hooks.push(base(r, "record", (r.up - low) * 1.4 * prom * damp("record"), facts));
      }
    }

    // 5. STEADY — never left the top of the scale across the whole window.
    //
    //    `trend` (net Smart Score drift across the window) and `churn` (how many distinct
    //    scores it showed) used to live here too. Both are DELETED, not merely damped down:
    //    the user's call was that a Smart Score change is not a post, full stop, and both of
    //    those kinds' entire subject was exactly that — a rating moving. `steady` survives a
    //    deliberate judgement call in the other direction: it is not about a CHANGE (it fires
    //    on the absence of one), and "this name has not wavered all week" is a genuinely
    //    different, more interesting claim than "the number moved" — closer to `contrarian`'s
    //    kind of story (what the rating IS/has held) than to `trend`'s (that it changed).
    if (sss.length >= MIN_WINDOW && sss.length === hist.length && sss.every((v) => v >= 9)) {
      hooks.push(base(r, "steady", 60 * prom * damp("steady"), {
        smartScore: sss[sss.length - 1], snapshots: hist.length, days: round((hist.length * 5) / 24),
        upside: round(r.up), consensus: r.con, analysts: coverage(r),
      }));
    }

    // 6. NEWCOMER — absent when the window opened, here now.
    const firstSeen = hist[0].i;
    if (firstSeen >= earlyCut) {
      const facts = {
        seenIn: hist.length, windowSnapshots: snaps.length,
        days: round(((snaps.length - firstSeen) * 5) / 24),
        upside: round(r.up), consensus: r.con, analysts: coverage(r),
      };
      // Include Smart Score only when it exists — null is data, not a gap.
      if (isNum(r.ss)) {
        facts.smartScore = r.ss;
      }
      hooks.push(base(r, "newcomer", 55 * prom * damp("newcomer"), facts));
    }
  }

  // 7. LIST — one per run, built from the strongest upsides. A carousel, not a single name.
  const top = rows.filter((r) => r.up >= 30).sort((a, b) => b.up - a.up).slice(0, 5);
  if (top.length >= 3) {
    hooks.push({
      kind: "list", ticker: top[0].t, name: top[0].n, sec: top[0].sec,
      score: round((top.reduce((s, r) => s + r.up, 0) / top.length) * damp("list")),
      facts: {
        members: top.map((r) => `${r.t} (${round(r.up)}% to $${r.pt})`).join(", "),
        count: top.length, leader: top[0].t, leaderUpside: round(top[0].up),
      },
    });
  }

  // PER-KIND CAP. Measured against the live 30-snapshot window when this was tuned: without
  // it one kind takes the whole board — `churn` (since deleted, see the STEADY comment above)
  // took 5 of 12 slots at the first coefficients, and re-tuning only moved the flood to
  // `steady` (10 of 12). `steady` scores FLAT, so every mega-cap holding a 10 scores the same
  // and they arrive as a block; no coefficient can fix that, only a cap.
  const ranked = hooks.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  const used = new Map();
  const out = [];
  for (const h of ranked) {
    const n = used.get(h.kind) ?? 0;
    if (n >= o.maxPerKind) continue;
    used.set(h.kind, n + 1);
    out.push(h);
    if (out.length >= o.limit) break;
  }
  return out;
}

// ---------------------------------------------------------- de-tickering -----
//
// A published post once read "IRD soared 151.7% to $13.14." — a ticker, which is banned.
// The ticker penalty in ci/post-score.mjs is one line of defence; this is the other, and it
// is the root-cause fix: the `list` hook's OWN facts were handing the model tickers to quote
// (`members: "IRD (151.7% to $13.14), …"`, `leader: "IRD"`), so even a model that never
// invents anything just read one back verbatim. This runs as its own pass, immediately after
// detectHooks and before anything (the prompt builder, the scorer) ever sees a hook — a hook
// downstream of this point should never carry a ticker symbol in its `facts` again.

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Legal-entity suffixes only — never "Holdings"/"Group", which can be load-bearing brand
 *  identity (see ci/test-post-score.mjs's "Ird Holdings" fixture). Looped so a chained tail
 *  ("Foo, Inc., Ltd.") still fully strips, capped so a pathological name can't loop forever. */
const CORP_SUFFIX_RE =
  /,?\s+(?:Inc(?:orporated)?|Corp(?:oration)?|Co(?:mpany)?|Ltd|Limited|LLC|LLP|PLC|plc|N\.?V\.?|S\.?A\.?|L\.?P\.?)\.?$/i;

/** "Kymera Therapeutics, Inc." -> "Kymera Therapeutics"; "Opus Genetics, Inc." -> "Opus
 *  Genetics". Sensible shortening for a fact string that names several companies at once
 *  (`list`'s `members`) — a five-way list of full legal names is unreadable, a five-way list
 *  of the names people actually use is exactly what a `list` post should quote. */
export function shortCompanyName(name) {
  let s = String(name ?? "").trim();
  if (!s) return s;
  for (let i = 0; i < 4; i++) {
    const next = s.replace(CORP_SUFFIX_RE, "").trim();
    if (next === s) break;
    s = next;
  }
  return s || String(name ?? "").trim();
}

// ------------------------------------------------------------- display name --
//
// shortCompanyName() above is deliberately CONSERVATIVE — it exists to substitute a real
// company name back in for a ticker inside a `facts` STRING that already lists several
// companies at once (deTickerHooks), so it never touches "Holdings"/"Group": those can be
// load-bearing brand identity in that context (see this file's own "Ird Holdings" fixture in
// ci/test-hooks.mjs). displayCompanyName() below is a SEPARATE, more aggressive stripper for a
// different job entirely — the one line a human actually SEES: the big name printed on the
// composed image (ci/post-compose.mjs) and the name spoken to the writer model in the prompt
// (ci/generate-posts.mjs's buildPrompt). A published card once read "Applied Materials, Inc."
// and, on an earlier run, "Alphabet Inc. Class A" printed large over the photo — full
// legal-entity plumbing nobody asked to read on a headline.
//
// Strips ONLY from the END of the name, in a loop so a chained tail resolves fully ("Rani
// Therapeutics Holdings, Inc. Class A" -> "Rani Therapeutics", three passes) — NEVER a leading
// or interior token, so "Group 1 Automotive" keeps its "Group" (the match requires the suffix
// to reach all the way to the end of the string, which "Group" does not there) and "3M Co."
// keeps its "3M" (only "Co." matches and strips, leaving a non-empty name). Never returns an
// empty string: a name that would fully strip away (a pathological "Inc." with nothing in
// front of it) falls back to the original rather than vanish from the card.
//
// "Company" (spelled out — "Eli Lilly And Company", "Merck & Company") and "AG" (the German
// public-company suffix — "On Holding Ag Class A") are not in the task's literal example list
// but are the same category of cruft as "Co." and "N.V."/"S.A." respectively, and both show up
// in this app's own src/data/stocks.json — see ci/test-hooks.mjs for the exact real-data cases
// this was built and verified against.
const DISPLAY_SUFFIX_RE =
  /,?\s+(?:Class\s+[ABC]|&\s*Co(?:mpany)?|and\s+Co(?:mpany)?|Inc(?:orporated)?|Corp(?:oration)?|Co(?:mpany)?|Ltd|Limited|LLC|LLP|PLC|plc|N\.?V\.?|S\.?A\.?|L\.?P\.?|AG|Holdings?|Group)\.?$/i;

export function displayCompanyName(name) {
  const original = String(name ?? "").trim();
  if (!original) return original;
  let s = original;
  for (let i = 0; i < 6; i++) {
    const next = s.replace(DISPLAY_SUFFIX_RE, "").replace(/,\s*$/, "").trim();
    if (next === s) break;
    s = next;
  }
  return s || original;
}

/**
 * De-ticker one string fact value: replace every standalone ticker token (word-boundary,
 * case-sensitive — a ticker symbol is written in caps) with the matching company's short
 * name from `nameByTicker`. Non-string values pass through untouched — this only ever
 * touches the string facts a ticker could hide inside.
 */
function deTickerString(value, tickerRe, nameByTicker) {
  if (typeof value !== "string" || !tickerRe) return value;
  return value.replace(tickerRe, (m) => shortCompanyName(nameByTicker.get(m) ?? m));
}

/**
 * The normalisation pass. Runs after detectHooks, before the prompt builder or the scorer
 * ever see a hook. `rows` is the CURRENT snapshot's rows (any array of `{ t, n, ... }`,
 * typically `history[history.length - 1]`) — the `t` -> `n` map it builds is the only source
 * of truth for what a ticker's company is actually called.
 *
 * General on purpose: it does not special-case `members`/`leader` by key name, it scans every
 * string-valued fact on every hook for a KNOWN ticker token and replaces it. `members` and
 * `leader` are exactly what that catches today; a future fact that happens to carry a ticker
 * (a new hook kind, a new field on an existing one) is caught the same way with no edit here.
 *
 * Never touches `hook.ticker` / `hook.name` themselves — those are the hook's own identity,
 * already correct, and are never sent to the model as a raw "Facts:" line the way `hook.facts`
 * is (see buildPrompt in ci/generate-posts.mjs).
 */
export function deTickerHooks(hooks, rows) {
  const list = Array.isArray(hooks) ? hooks : [];
  const nameByTicker = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.t && r.n) nameByTicker.set(r.t, r.n);
  }
  if (!nameByTicker.size) return list;

  // Longest-first so a ticker that is a prefix of another ("A" vs "AA") cannot pre-empt the
  // longer, more specific match — irrelevant for the word-boundary case here, but free and
  // future-proof against a lookahead-free engine change.
  const tickers = [...nameByTicker.keys()].sort((a, b) => b.length - a.length);
  const tickerRe = new RegExp(`\\b(?:${tickers.map(escapeRe).join("|")})\\b`, "g");

  return list.map((h) => {
    const facts = h?.facts;
    if (!facts || typeof facts !== "object") return h;
    const nextFacts = {};
    let changed = false;
    for (const [k, v] of Object.entries(facts)) {
      const nv = deTickerString(v, tickerRe, nameByTicker);
      nextFacts[k] = nv;
      if (nv !== v) changed = true;
    }
    return changed ? { ...h, facts: nextFacts } : h;
  });
}
