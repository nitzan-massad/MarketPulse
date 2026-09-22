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
      hooks.push(base(r, "surprise", (r.up / SANE_MAX_UPSIDE) * 100 * prom * damp("surprise"), {
        upside: round(r.up), price: r.px, priceTarget: r.pt,
        consensus: r.con, analysts: coverage(r), sector: r.sec,
      }));
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
    const p = before.get(r.t);
    if (p) {
      const dSs = isNum(r.ss) && isNum(p.ss) ? r.ss - p.ss : 0;
      const dUp = isNum(p.up) ? r.up - p.up : 0;
      const flipped = p.con !== r.con;
      if (Math.abs(dSs) >= 2 || Math.abs(dUp) >= 15 || flipped) {
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
        // — defence in depth, and it costs nothing.
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
        if (isNum(p.ss) && isNum(r.ss)) {
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
        hooks.push(base(r, "record", (r.up - low) * 1.4 * prom * damp("record"), {
          upside: round(r.up), windowLow: round(low), windowHigh: round(high),
          snapshots: hist.length, days: round((hist.length * 5) / 24),
          price: r.px, priceTarget: r.pt, analysts: coverage(r),
        }));
      }
    }

    // 5. TREND — net Smart Score drift from one end of the window to the other.
    if (sss.length >= MIN_WINDOW) {
      const from = sss[0], to = sss[sss.length - 1], d = to - from;
      if (Math.abs(d) >= 3) {
        hooks.push(base(r, "trend", Math.abs(d) * 22 * prom * damp("trend"), {
          smartScoreFrom: from, smartScoreTo: to, direction: d > 0 ? "up" : "down",
          snapshots: hist.length, days: round((hist.length * 5) / 24),
          upside: round(r.up), consensus: r.con, analysts: coverage(r),
        }));
      }

      // 6. STEADY — never left the top of the scale across the whole window.
      if (sss.length === hist.length && sss.every((v) => v >= 9)) {
        hooks.push(base(r, "steady", 60 * prom * damp("steady"), {
          smartScore: to, snapshots: hist.length, days: round((hist.length * 5) / 24),
          upside: round(r.up), consensus: r.con, analysts: coverage(r),
        }));
      }

      // 7. CHURN — the quant model cannot make up its mind about this name.
      const distinct = new Set(sss);
      if (distinct.size >= 4) {
        hooks.push(base(r, "churn", distinct.size * 9 * prom * damp("churn"), {
          distinctScores: distinct.size, low: Math.min(...sss), high: Math.max(...sss),
          smartScore: to, snapshots: hist.length, days: round((hist.length * 5) / 24),
          analysts: coverage(r),
        }));
      }
    }

    // 8. NEWCOMER — absent when the window opened, here now.
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

  // 9. LIST — one per run, built from the strongest upsides. A carousel, not a single name.
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

  // PER-KIND CAP. Measured against the live 30-snapshot window: without it one kind takes
  // the whole board — churn took 5 of 12 slots at the first coefficients, and re-tuning only
  // moved the flood to `steady` (10 of 12). `steady` scores FLAT, so every mega-cap holding a
  // 10 scores the same and they arrive as a block; no coefficient can fix that, only a cap.
  // With maxPerKind = 2 the same window yields 7 distinct kinds across 12 slots.
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
