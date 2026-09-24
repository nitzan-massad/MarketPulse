// RUN TELEMETRY — everything ci/neuron-usage.mjs's plain "N neurons, X% of the daily pool"
// summary does not answer: WHERE the budget actually went (per stage: writer/descriptor/image,
// each with its own call count, its own measured-vs-estimated neurons, and its own share of the
// run), what it cost PER PUBLISHED POST (the number that actually says whether POST_CANDIDATES
// or a prompt rule is the lever to pull), how many of the candidates the writer paid for were
// simply WASTED (rejected, and by which specific rule, most often), which HOOK KINDS are
// pulling their weight, how much of today's 10,000-neuron allocation is left once this run is
// done, and whether any of that is TRENDING — a single run's numbers are noise, a few weeks of
// them are a decision.
//
// PURE ON PURPOSE. Every function here takes plain data in and returns plain data out — no
// fs, no Date.now() calls buried inside (the caller supplies `now`/timestamps), no console
// output except `formatSummaryBlock`'s return value (a string the CALLER prints). This is the
// same posture ci/neuron-usage.mjs already takes, for the same reason: ci/generate-posts.mjs's
// generate() stays file-I/O-free and fully testable with fakes (see that module's own header),
// and NOTHING in here is allowed to change whether a post publishes — every call site in
// ci/generate-posts.mjs that records telemetry is wrapped so a telemetry bug degrades to
// "this run's numbers are incomplete", never to "the post didn't ship" (see that file's own
// comments at each call site).
//
// THE THREE CONSUMERS, KEPT SEPARATE. ci/generate-posts.mjs wires THREE independent
// ci/neuron-usage.mjs trackers (writer/descriptor/image) rather than one combined one — see
// that file's `main()` — specifically so this module can report each stage's own neuron cost
// without ci/neuron-usage.mjs itself needing to know about "stages" at all. That module stays
// exactly what it was: a plain call/token accumulator, one per consumer.

import { computeNeuronUsage, DAILY_FREE_NEURONS } from "./neuron-usage.mjs";
import { MIN_PUBLISHABLE } from "./post-score.mjs";

/** `.github/workflows/site.yml`'s own cron schedule fires on the hour, every 5 hours — 24/5 =
 *  4.8 runs/day. Restated here (not imported — the workflow YAML has no exports) so the "how
 *  many posts/day fit in the budget" comparison has a real number to compare against, not a
 *  made-up one; update this if the cron schedule ever changes. */
export const CRON_RUNS_PER_DAY = 24 / 5;

/** Bounds the persisted history file the same way `POSTS_KEEP` bounds `posts.json` (see
 *  ci/generate-posts.mjs) — one compact record per run, so even at the cron's 4.8 runs/day this
 *  is ~41 days of history before the oldest rolls off, comfortably enough to see a trend without
 *  the file growing forever in git. */
export const NEURON_HISTORY_KEEP = 200;

// ------------------------------------------------------------- rejection classification --

/**
 * Boil one candidate's `reasons` (ci/post-score.mjs's `scorePost`) down to ONE headline cause,
 * in the same priority order `scorePost`'s own penalties are sized (biggest penalty first) —
 * multi-reason candidates are common (a too-long, ticker-naming candidate is not rare), and
 * attributing it to the single most decisive rule is far more actionable than a bag of tags:
 * "4 of 5 candidates die on the fabrication check" is a finding; "4 candidates had between 1
 * and 3 reasons each" is not. Exported for direct test coverage — this is pure string matching
 * against `scorePost`'s own, already-tested reason strings, never re-deriving the scoring logic
 * itself.
 */
export function classifyRejectionReason(reasons) {
  const all = Array.isArray(reasons) ? reasons.join(" | ") : String(reasons ?? "");
  if (/unverified number/.test(all)) return "fabricated number";
  if (/names the ticker/.test(all)) return "contains a ticker";
  if (/movement verb misdescribes/.test(all)) return "banned movement verb";
  if (/claims a timeframe/.test(all)) return "misdescribed timeframe";
  if (/too long \(/.test(all)) return "over the 8-word cap";
  if (/duplicate of a recent post/.test(all)) return "duplicate of a recent post";
  if (/too short \(/.test(all)) return "too short";
  if (/no numbers/.test(all)) return "no numbers";
  if (/banned phrase/.test(all)) return "banned phrase";
  if (/appeared in a recent post/.test(all)) return "ticker repeated from a recent post";
  return "other";
}

// ------------------------------------------------------------------------- accumulator --

/**
 * One fresh accumulator for a whole run. `usage` is the map of the THREE independent
 * ci/neuron-usage.mjs trackers ci/generate-posts.mjs's `main()` constructs (`{ writer,
 * descriptor, image }`) — this module never constructs one itself, so a caller that only cares
 * about, say, candidate/rejection telemetry (a test) can pass empty trackers and still get
 * correct (zero-cost) numbers back rather than a crash.
 */
export function newRunTelemetry(usage) {
  return {
    usage, // { writer, descriptor, image } — each a ci/neuron-usage.mjs tracker
    stageMs: { writer: 0, descriptor: 0, image: 0, wikimedia: 0 },
    hookOutcomes: {}, // { [kind]: { attempted, published } }
    candidates: { generated: 0, used: 0, outscored: 0, rejected: 0 },
    rejectionReasons: {}, // { [bucket]: count }
  };
}

/** Accumulate milliseconds spent in one named stage — called around each `await` in
 *  ci/generate-posts.mjs's hook loop. Unknown stage names are recorded as given (not rejected):
 *  a typo here should show up as a visibly-wrong stage name in the summary, not vanish. */
export function recordStageMs(telemetry, stage, ms) {
  telemetry.stageMs[stage] = (telemetry.stageMs[stage] ?? 0) + Math.max(0, Number(ms) || 0);
}

export function recordHookAttempt(telemetry, kind) {
  const k = String(kind ?? "unknown");
  telemetry.hookOutcomes[k] ??= { attempted: 0, published: 0 };
  telemetry.hookOutcomes[k].attempted++;
}

export function recordHookPublished(telemetry, kind) {
  const k = String(kind ?? "unknown");
  telemetry.hookOutcomes[k] ??= { attempted: 0, published: 0 };
  telemetry.hookOutcomes[k].published++;
}

/**
 * Tally one hook's full candidate set — `ranked` is ci/post-score.mjs's `rankCandidates()`
 * output (every candidate, scored, best first); `winnerText` is the text that actually became
 * this hook's published post, or `null` if none did. Every candidate lands in exactly one
 * bucket: the one that WON (`used`), one that scored high enough to publish but simply lost to
 * a better candidate (`outscored` — healthy best-of-N competition, not a problem), or one that
 * scored below `MIN_PUBLISHABLE` (`rejected`, further broken down by `classifyRejectionReason`
 * — THIS is the "waste" the brief asks for: a rule tripping most of the field, run after run).
 */
export function recordCandidateOutcomes(telemetry, { ranked, winnerText }) {
  const list = Array.isArray(ranked) ? ranked : [];
  telemetry.candidates.generated += list.length;
  for (const c of list) {
    if (winnerText != null && c.text === winnerText) {
      telemetry.candidates.used++;
      continue;
    }
    if (c.score < MIN_PUBLISHABLE) {
      telemetry.candidates.rejected++;
      const bucket = classifyRejectionReason(c.reasons);
      telemetry.rejectionReasons[bucket] = (telemetry.rejectionReasons[bucket] ?? 0) + 1;
    } else {
      telemetry.candidates.outscored++;
    }
  }
}

// --------------------------------------------------------------------- cost / headroom --

/** Neurons spent per PUBLISHED post this run — the single most useful figure in the brief: it
 *  is what actually tells you whether a change to POST_CANDIDATES or the image pipeline moves
 *  the needle. `null` when nothing published (dividing by zero posts is not "infinite cost",
 *  it is "no data" — never printed as a number). */
export function neuronsPerPublishedPost(totalNeurons, publishedCount) {
  if (!publishedCount || !Number.isFinite(totalNeurons)) return null;
  return totalNeurons / publishedCount;
}

/** How many posts/day the free tier affords AT this run's own measured cost-per-post — `null`
 *  when there is no real cost-per-post to divide by (nothing published, or a zero/invalid
 *  cost). Always a whole number: a fractional "36.4 posts/day" implies more precision than a
 *  single run's cost figure actually carries. */
export function dailyPostCapacity(costPerPost) {
  if (!costPerPost || !Number.isFinite(costPerPost) || costPerPost <= 0) return null;
  return Math.floor(DAILY_FREE_NEURONS / costPerPost);
}

/**
 * Headroom left in TODAY's 10,000-neuron allocation, given how much history says was already
 * spent today (`usedTodayBeforeThisRun`, from the persisted history — see `sumNeuronsForDate`
 * below) plus this run's own total. Never negative (Cloudflare's own hard cap means the true
 * floor is zero, not a negative number that implies debt).
 */
export function computeHeadroom(usedTodayBeforeThisRun, thisRunNeurons) {
  const usedTotal = Math.max(0, Number(usedTodayBeforeThisRun) || 0) + Math.max(0, Number(thisRunNeurons) || 0);
  return {
    usedTotal,
    remaining: Math.max(0, DAILY_FREE_NEURONS - usedTotal),
    percentUsed: (usedTotal / DAILY_FREE_NEURONS) * 100,
  };
}

// -------------------------------------------------------------------------- history --

/** `YYYY-MM-DD` in UTC — the daily allocation resets at 00:00 UTC (Cloudflare's documented
 *  reset), so "today" for this accounting must be the UTC date, not the runner's local one
 *  (GitHub Actions runners are UTC anyway, but a local `node ci/generate-posts.mjs` run might
 *  not be — this keeps the two consistent either way). */
export function utcDateKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Sum of every history record's `totalNeurons` whose `date` matches `dateKey` — the "already
 *  spent today, before this run" figure `computeHeadroom` needs. A record with a missing/
 *  malformed `totalNeurons` contributes zero rather than `NaN`-poisoning the sum. */
export function sumNeuronsForDate(history, dateKey) {
  return (Array.isArray(history) ? history : [])
    .filter((r) => r?.date === dateKey)
    .reduce((sum, r) => sum + (Number(r?.totalNeurons) || 0), 0);
}

/** Keep only the most recent `keep` records — same "bounded, not unbounded growth in git"
 *  posture as `POSTS_KEEP` (ci/generate-posts.mjs); records are appended oldest-last... no,
 *  OLDEST-FIRST (append to the end as runs happen), so the most recent `keep` are the LAST
 *  `keep` entries. */
export function trimHistory(history, keep = NEURON_HISTORY_KEEP) {
  const list = Array.isArray(history) ? history : [];
  return list.slice(Math.max(0, list.length - keep));
}

/** A rough "what is this run likely to cost" figure from the last few runs' ACTUAL recorded
 *  cost — the only honest basis for a before-the-fact warning (there is no way to know a run's
 *  real cost before running it). `null` with no history at all (a repo's very first run, or a
 *  fresh history file) — silence, not a made-up number, per the same "null when in doubt"
 *  posture the rest of this pipeline follows. */
export function estimateRunCostFromHistory(history, { sampleSize = 5 } = {}) {
  const list = Array.isArray(history) ? history : [];
  if (!list.length) return null;
  const sample = list.slice(-sampleSize);
  const sum = sample.reduce((s, r) => s + (Number(r?.totalNeurons) || 0), 0);
  return sum / sample.length;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * One compact record for the persisted history file — deliberately SMALL (this lands in git
 * every cron run, per the brief) — no per-candidate text, no raw reasons arrays, just the
 * aggregated numbers a future trend line needs.
 */
export function buildHistoryRecord(telemetry, { publishedCount, ts = Date.now() } = {}) {
  const perStage = perStageUsage(telemetry.usage);
  const total = perStage.writer.totalNeurons + perStage.descriptor.totalNeurons + perStage.image.totalNeurons;
  const totalMeasured = perStage.writer.measuredNeurons + perStage.descriptor.measuredNeurons + perStage.image.measuredNeurons;
  return {
    ts: new Date(ts).toISOString(),
    date: utcDateKey(ts),
    model: telemetry.usage?.writer?.model,
    calls: {
      writer: telemetry.usage?.writer?.calls?.writer ?? 0,
      descriptor: telemetry.usage?.descriptor?.calls?.descriptor ?? 0,
      image: telemetry.usage?.image?.calls?.image ?? 0,
    },
    measuredNeurons: round2(totalMeasured),
    estimatedNeurons: round2(total - totalMeasured),
    totalNeurons: round2(total),
    publishedCount: publishedCount ?? 0,
    stageMs: { ...telemetry.stageMs },
    candidates: { ...telemetry.candidates },
    rejectionReasons: { ...telemetry.rejectionReasons },
    hookOutcomes: Object.fromEntries(
      Object.entries(telemetry.hookOutcomes).map(([k, v]) => [k, { ...v }]),
    ),
  };
}

// -------------------------------------------------------------------------- reporting --

/** `computeNeuronUsage` on each of the three per-stage trackers — a thin wrapper so callers
 *  never have to remember which sub-tracker belongs to which key, and a missing/undefined
 *  tracker (a caller that only wired up one or two stages, e.g. most tests) degrades to a
 *  correct all-zero entry rather than throwing. */
export function perStageUsage(usage) {
  const empty = { measuredNeurons: 0, estimatedNeurons: 0, totalNeurons: 0, percentOfDailyFree: 0 };
  return {
    writer: usage?.writer ? computeNeuronUsage(usage.writer) : empty,
    descriptor: usage?.descriptor ? computeNeuronUsage(usage.descriptor) : empty,
    image: usage?.image ? computeNeuronUsage(usage.image) : empty,
  };
}

/** The grand total (writer + descriptor + image) for one run's telemetry — the single number
 *  `computeHeadroom`/the history record need, without every caller re-summing `perStageUsage`'s
 *  three entries by hand. */
export function totalNeuronsForRun(telemetry) {
  const p = perStageUsage(telemetry.usage);
  return p.writer.totalNeurons + p.descriptor.totalNeurons + p.image.totalNeurons;
}

const bar = (ch = "-") => ch.repeat(78);
const pad = (s, n) => String(s).padEnd(n);
const padNum = (s, n) => String(s).padStart(n);
const fmtNeurons = (n) => `${Math.round(n).toLocaleString()}`;
const fmtPct = (n) => `${n.toFixed(1)}%`;

/**
 * THE summary block the brief asks for: one compact, aligned, human-readable report at the end
 * of a run — everything a person tweaking `POST_CANDIDATES`/deciding whether to cut a hook kind
 * needs, in one place, instead of scattered across fifty log lines. Per-candidate detail can
 * (and does) stay verbose above this in the log; this is the part meant to be READ.
 *
 * `headroom` is `computeHeadroom(...)`'s return value; `historyNote` is a short free-text line
 * (main() decides what to say — e.g. "no history yet" on a repo's very first run) so this
 * function never has to know about the filesystem.
 */
export function formatSummaryBlock(telemetry, { publishedCount, headroom, historyNote } = {}) {
  const perStage = perStageUsage(telemetry.usage);
  const total = perStage.writer.totalNeurons + perStage.descriptor.totalNeurons + perStage.image.totalNeurons;
  const totalMeasured = perStage.writer.measuredNeurons + perStage.descriptor.measuredNeurons + perStage.image.measuredNeurons;
  const totalEstimated = total - totalMeasured;
  const calls = {
    writer: telemetry.usage?.writer?.calls?.writer ?? 0,
    descriptor: telemetry.usage?.descriptor?.calls?.descriptor ?? 0,
    image: telemetry.usage?.image?.calls?.image ?? 0,
  };
  const totalCalls = calls.writer + calls.descriptor + calls.image;

  const lines = [];
  lines.push(bar("="));
  lines.push(` NEURON USAGE SUMMARY — ${telemetry.usage?.writer?.model ?? "unknown model"}`);
  lines.push(bar("-"));
  lines.push(` ${pad("STAGE", 12)}${padNum("CALLS", 6)}  ${pad("MEASURED", 10)}${pad("ESTIMATED", 11)}${pad("SHARE", 8)}TIME`);
  for (const [stage, label] of [["writer", "writer"], ["descriptor", "descriptor"], ["image", "image"]]) {
    const u = perStage[stage];
    const share = total > 0 ? fmtPct((u.totalNeurons / total) * 100) : "-";
    const ms = telemetry.stageMs[stage] ?? 0;
    lines.push(
      ` ${pad(label, 12)}${padNum(calls[stage], 6)}  ${pad(fmtNeurons(u.measuredNeurons), 10)}${pad(fmtNeurons(u.estimatedNeurons), 11)}${pad(share, 8)}${(ms / 1000).toFixed(1)}s`,
    );
  }
  if ((telemetry.stageMs.wikimedia ?? 0) > 0) {
    lines.push(` ${pad("(wikimedia lookup, folded into image time above)", 45)}${(telemetry.stageMs.wikimedia / 1000).toFixed(1)}s`);
  }
  lines.push(bar("-"));
  lines.push(
    ` TOTAL: ${totalCalls} call(s) — ${fmtNeurons(totalMeasured)} measured + ${fmtNeurons(totalEstimated)} estimated ` +
    `= ~${fmtNeurons(total)} neurons (${fmtPct((total / DAILY_FREE_NEURONS) * 100)} of ${DAILY_FREE_NEURONS.toLocaleString()}/day)`,
  );
  lines.push(bar("-"));

  const perPost = neuronsPerPublishedPost(total, publishedCount);
  if (perPost != null) {
    const cap = dailyPostCapacity(perPost);
    lines.push(` Published ${publishedCount} post(s) this run -> ~${fmtNeurons(perPost)} neurons/post`);
    if (cap != null) {
      lines.push(
        ` At this cost: ~${cap} post(s)/day fit in the free tier ` +
        `(cron attempts ${CRON_RUNS_PER_DAY.toFixed(1)} run(s)/day)`,
      );
    }
  } else {
    lines.push(" No post published this run — no cost-per-post to report.");
  }
  lines.push(bar("-"));

  const { generated, used, outscored, rejected } = telemetry.candidates;
  lines.push(` Candidates: ${generated} generated, ${used} used, ${outscored} outscored, ${rejected} rejected`);
  const reasonEntries = Object.entries(telemetry.rejectionReasons).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of reasonEntries) {
    lines.push(`   - ${reason}: ${count}`);
  }
  lines.push(bar("-"));

  const kindEntries = Object.entries(telemetry.hookOutcomes);
  if (kindEntries.length) {
    const kindStr = kindEntries.map(([kind, o]) => `${kind} ${o.published}/${o.attempted}`).join(", ");
    lines.push(` Hook kinds (published/attempted): ${kindStr}`);
  } else {
    lines.push(" Hook kinds: none attempted this run.");
  }
  lines.push(bar("-"));

  if (headroom) {
    lines.push(
      ` Headroom: ${fmtNeurons(headroom.usedTotal)} used today of ${DAILY_FREE_NEURONS.toLocaleString()} ` +
      `-> ${fmtNeurons(headroom.remaining)} remaining (${fmtPct(headroom.percentUsed)} of today's allocation used)`,
    );
  }
  if (historyNote) lines.push(` ${historyNote}`);
  lines.push(bar("="));

  return lines.join("\n");
}
