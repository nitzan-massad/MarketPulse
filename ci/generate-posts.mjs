// THE WIRING — hooks -> de-ticker -> N candidates -> deterministic judge -> one post
// (+ one composed meme image).
//
// THREE separate steps make the image, deliberately not one blended function: the TEXT
// (`provider`, above), the PHOTO (`generateImageFor` -> ci/post-image.mjs), and the FUSION of
// the two into one raster (ci/post-compose.mjs, called directly below — it is pure and local,
// so unlike the network-touching steps it needs no injection to stay testable offline).
//
// Shape note: generate() takes its provider AND its image generator as arguments and does no
// file I/O, so ci/test-generate-posts.mjs can drive the whole pipeline offline with fakes for
// both. All reading and writing — including the image bytes and the prune — lives in main(),
// behind the entry guard at the bottom.
//
// Cadence is env config, not code — POSTS_PER_RUN=3 in site.yml is the only edit needed
// to go from one post per run to three.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { detectHooks, deTickerHooks, displayCompanyName, MIN_WINDOW } from "./hooks.mjs";
import { rankCandidates, MIN_PUBLISHABLE } from "./post-score.mjs";
import { makeProvider } from "./provider.mjs";
import { generateImage, postImageFilename } from "./post-image.mjs";
import { composePost } from "./post-compose.mjs";
import { describeCompany } from "./company-descriptor.mjs";
import { findCompanyPhoto } from "./company-photo.mjs";
import { isExhausted } from "./cf-budget.mjs";
import { newUsageTracker, recordTextCall, recordImageCall } from "./neuron-usage.mjs";
import {
  newRunTelemetry, recordStageMs, recordHookAttempt, recordHookPublished, recordCandidateOutcomes,
  buildHistoryRecord, formatSummaryBlock, computeHeadroom, sumNeuronsForDate, trimHistory, utcDateKey,
  estimateRunCostFromHistory, totalNeuronsForRun, NEURON_HISTORY_KEEP,
} from "./run-telemetry.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const STOCKS = path.join(ROOT, "src", "data", "stocks.json");
const POSTS = path.join(ROOT, "src", "data", "posts.json");
const CORPUS = path.join(ROOT, "ci", "style-corpus.json");
const IMAGES_DIR = path.join(ROOT, "public", "post-images");
// Per-company descriptor cache (ci/company-descriptor.mjs) — `{ [ticker]: { name, descriptor } }`.
// Lives under src/data/ so the existing CI commit step (site.yml's "Commit refreshed data",
// `git add src/data …`) persists it across runs with no workflow change.
const DESCRIPTORS = path.join(ROOT, "src", "data", "company-descriptors.json");
// (Run telemetry) One compact record per run — see ci/run-telemetry.mjs's `buildHistoryRecord`.
// Same neighbourhood/commit step as POSTS/DESCRIPTORS above (both under src/data/, both staged
// by site.yml's "Commit refreshed data" step, CLAUDE.md's "CI-owned" JSON) — nothing new to wire
// into the workflow for this to persist across runs.
const NEURON_HISTORY = path.join(ROOT, "src", "data", "neuron-usage-history.json");

/** The ANGLE — one line per hook kind, telling the model what makes this particular hook
 *  postable. Without it a kind falls through to "Report the fact.", which throws away the
 *  entire reason the rule fired: a `record` post that does not say "highest in the window"
 *  is just another upside number. One entry per kind ci/hooks.mjs can emit, all seven —
 *  ci/test-generate-posts.mjs fails if a kind is ever added without one. `trend` (net Smart
 *  Score drift) and `churn` (how many distinct scores) used to be here too; both were deleted
 *  from ci/hooks.mjs outright — a Smart Score change alone is not a post (see hooks.mjs's own
 *  comment on the `movement` rule for the reasoning), and neither kind had any other story to
 *  tell. `steady` survives: it is not about a change, it is about the absence of one. */
export const KIND_BRIEF = {
  surprise: "The number is the story. Lead with it.",
  contrarian: "Two models disagree. Name the disagreement, do not resolve it.",
  list: "A short ranked list. No preamble before the first name.",
  movement: "Something changed since five hours ago. Say what, and from what to what.",
  record: "This is the highest reading of the whole window. Say it is a high, and say how far it came.",
  steady: "Nothing moved, and that is the story. Say what it has held and for how long.",
  newcomer: "This name was not on the board when the window opened. Say it is new, and how long it has been here.",
};

/**
 * HUMANISE FACT KEYS before they reach the prompt. Without this, `hook.facts` renders as
 * `- key: value` lines with the literal JS field name as the key — one published post read
 * "Alphabet Inc. smartScore: 10, unchanged for 30 snapshots." because the model copied the raw
 * key `smartScore` verbatim. This is the fix, and it belongs HERE, at the prompt boundary, not
 * in ci/hooks.mjs: `supportLine`-era consumers and ci/test-hooks.mjs depend on the current
 * field names, so those never change — only what the writer model is SHOWN does. Every key any
 * of the seven hook kinds emits (ci/hooks.mjs) is covered; an unmapped key (a future field, or a
 * typo) falls through to itself rather than throwing, same as `KIND_BRIEF`'s fallback below.
 * (`direction`, `distinctScores`, `low`, `high` were `trend`/`churn`-only keys — removed along
 * with those two kinds; no surviving kind emits them.)
 */
const FACT_LABELS = {
  upside: "Analyst upside",
  price: "Current price",
  priceTarget: "Street price target",
  consensus: "Analyst consensus",
  analysts: "Analysts covering",
  sector: "Sector",
  smartScore: "Smart Score",
  aiScore: "AI Score",
  aiRating: "AI rating",
  bullish: "More bullish side",
  upsideFrom: "Upside before",
  upsideTo: "Upside now",
  consensusFrom: "Consensus before",
  consensusTo: "Consensus now",
  smartScoreFrom: "Smart Score before",
  smartScoreTo: "Smart Score now",
  windowLow: "Lowest in the window",
  windowHigh: "Highest in the window",
  snapshots: "Snapshots in the window",
  days: "Days covered",
  seenIn: "Snapshots this name has appeared in",
  windowSnapshots: "Snapshots in the window",
  members: "The board",
  count: "Names on the board",
  leader: "Top name",
  leaderUpside: "Top name's upside",
  // (12) Comparison framing — ci/hooks.mjs's `sectorMedianUpside`, attached to `surprise`/
  // `record` hooks only when the sector has enough eligible peers this run AND the name's own
  // number is far enough from that median to be worth the contrast (see hooks.mjs's own comment).
  sectorMedianUpside: "Sector's median upside",
};

export const humanizeFactKey = (key) => FACT_LABELS[key] ?? key;

export function buildPrompt(hook, exemplars = []) {
  const system = [
    "You write short, punchy posts for a stock-data feed — the voice of a sharp finance editor",
    "on X who wants the read to stop a thumb mid-scroll, not sound like a ledger entry.",
    "Rules, all of them hard:",
    "- MAXIMUM 8 WORDS. Count them before you answer. 9 words is a failure, not a rounding error.",
    "- LEAD WITH THE NUMBER. Open the sentence on the figure itself — the percentage, the price, or the count — not the company, not a verb, not \"it\". \"~15% upside, 25 analysts covering\" beats \"Microsoft held...\" every time.",
    "- Good 8-word example: \"144% upside, 25 analysts — sector's usual is 60.\" — that is 8 words, opens on the number, cites the analyst count, and compares the name against its sector instead of stating the number alone.",
    "- The company name is already printed large on the card, above this text — do NOT repeat it here. Refer to \"it\"/\"its\" if you need a subject, or just state the fact with no subject at all.",
    "- Never use the ticker symbol, ever, for any reason.",
    "- Be BOLD, not flat. Find the one surprising angle in the numbers — the thing that makes someone look twice — instead of just restating them in order like a ledger.",
    "- Open with the fact. No greeting, no preamble, no 'Let's dive in'.",
    "- ROUND THE NUMBERS. You will be given some figures with decimal precision (143.6, 300.65, 6.3 days) — round each to a whole number before you use it (round half up: 143.6 becomes 144, 6.3 days becomes 6 days), or use it as a plain 1-decimal figure if that reads better (38.6 stays 38.6). A leading '~' (\"~144%\") is a good way to signal \"about\" when that reads more naturally than a bare rounded number — use your judgement. Never invent a different number, and never round UP past the true value (143.6 rounds to 144, never 145) — you are rounding the number you were given, not replacing it.",
    "- ANALYST COUNT AS SOCIAL PROOF. When you are given how many analysts cover a name, prefer working that count into the sentence (\"25 analysts agree\") over a bare percentage alone — a headcount reads like a jury verdict; a percentage on its own reads abstract.",
    "- COMPARE, DON'T JUST STATE, WHEN YOU CAN. If you are given the sector's typical (median) number alongside the name's own, prefer the comparison (\"more than double its sector's median\") over the bare figure — a comparison gives the reader something to agree or disagree with. Only compare when you are actually given both numbers; never invent a sector average you were not handed.",
    "- Never use a verb that claims a stock's PRICE moved (soared, plunged, plummeted, rocketed, crashed, jumped, surged, spiked, tanked, tumbled, nosedived, or the like) unless the number attached to it is an actual past price change. A price target, a Smart Score, an AI score, or an analyst upside is a forecast, a score, or a rating — not something that has already happened to the stock. Describe it as what it is (a target, a score, a call), never as a move.",
    "- No hashtags beyond one. No emoji. At most one exclamation mark, ideally zero.",
    "- Never give advice, never say buy or sell, never predict. Report what the data says.",
    "- No disclaimer, no 'not financial advice' line — the app adds that itself.",
    "- Output the post text only. No quotes around it, no explanation, no options list.",
  ].join("\n");

  const shots = exemplars.length
    ? `Posts in the voice to match:\n${exemplars.map((e) => `- ${e}`).join("\n")}\n\n`
    : "";

  const facts = Object.entries(hook.facts)
    .map(([k, v]) => `- ${humanizeFactKey(k)}: ${v}`)
    .join("\n");

  // DISPLAY name, not the raw legal name: the writer model is told the same clean name that
  // is about to be printed on the card (below), never "Applied Materials, Inc." or "Alphabet
  // Inc. Class A" — see ci/hooks.mjs's displayCompanyName(). hook.name itself is untouched;
  // this only affects what the prompt SHOWS the model.
  const prompt =
    `${shots}Angle: ${KIND_BRIEF[hook.kind] ?? "Report the fact."}\n\n` +
    `Company: ${displayCompanyName(hook.name)} (${hook.ticker}), ${hook.sec}\nFacts:\n${facts}\n\n` +
    `Write the post.`;

  return { system, prompt };
}

export async function generate({
  history, recent = [], provider, exemplars = [], config = {}, generateImageFor, getDescriptorFor,
  getCompanyPhotoFor, usageTracker, telemetry,
}) {
  // (Run telemetry) Every recording call below is wrapped through this — a telemetry bug must
  // degrade to "this run's numbers are incomplete", never to "the post didn't ship" (the
  // brief's own explicit caution). `telemetry` itself is optional (undefined in every existing
  // test that predates this work, and in any caller that just doesn't care), so this is a
  // no-op unless main() actually wired one in.
  const safeTelemetry = (fn) => {
    if (!telemetry) return;
    try {
      fn();
    } catch (err) {
      console.error(`  telemetry recording failed (ignored, post still ships) — ${err?.message ?? err}`);
    }
  };
  const { postsPerRun = 1, candidates = 5, kindMemory = 4, photoSource = "flux" } = config;
  // Task 0, Finding 2: feed the last few posts' KINDS back into the detector so the top
  // hook rotates shape instead of being "big upside number" every single run.
  const recentKinds = recent.slice(0, kindMemory).map((p) => p.kind).filter(Boolean);
  const rawHooks = detectHooks(history, { recentKinds });
  // DE-TICKER, as its own pass, before anything downstream (the prompt builder, the scorer)
  // ever sees a hook's facts. See ci/hooks.mjs for why this has to run here and not inside
  // detectHooks itself — a hook's `facts` fed a ticker straight to the model once
  // ("members: IRD (151.7% to $13.14), …"), and this is the fix for THAT, not a duplicate of
  // the scorer's ticker penalty (which stays, and is now decisive — see ci/post-score.mjs).
  const curr = Array.isArray(history) && history.length ? history[history.length - 1] : [];
  const hooks = deTickerHooks(rawHooks, curr);
  // The full `src/data/stocks.json` row per ticker — ci/company-descriptor.mjs needs the market
  // cap/price/real description a hook's own (much narrower) `facts` bag does not carry.
  const rowByTicker = new Map(Array.isArray(curr) ? curr.map((r) => [r.t, r]) : []);
  const posts = [];
  const usedTickers = new Set();

  for (const hook of hooks) {
    if (posts.length >= postsPerRun) break;
    if (usedTickers.has(hook.ticker)) continue;

    const { system, prompt } = buildPrompt(hook, exemplars);
    let texts = [];
    const writerT0 = Date.now();
    try {
      // (Neuron accounting) onUsage fires once per successful candidate, with Cloudflare's own
      // real usage object — see ci/provider.mjs/ci/neuron-usage.mjs. A no-op when no tracker is
      // wired in (e.g. every existing test that never mentions `usageTracker` at all).
      texts = await provider({
        system, prompt, n: candidates,
        onUsage: usageTracker ? (usage) => recordTextCall(usageTracker, "writer", usage) : undefined,
      });
    } catch (err) {
      console.error(`  ${hook.ticker}: provider threw — ${err.message}`);
      continue;
    } finally {
      safeTelemetry(() => recordStageMs(telemetry, "writer", Date.now() - writerT0));
    }
    // (Neuron accounting) Cloudflare's daily free allocation is a hard, account-wide cap — once
    // ci/cf-budget.mjs's shared flag is set (by the call just above, or by an earlier hook's
    // descriptor/image call this same run), every further hook would fail the exact same way.
    // ci/cf-budget.mjs already printed the ONE clear line this needs; stop trying more hooks
    // rather than repeating "0 candidates, none publishable" once per remaining hook.
    if (isExhausted()) break;

    // (Run telemetry) `rankCandidates` gives every candidate's OWN score/reasons, not just the
    // winner's — see ci/post-score.mjs's own comment on why this exists. `pickBest`'s exact
    // decision (a winner, or `null` when even the best falls below MIN_PUBLISHABLE) is
    // reproduced inline rather than calling `pickBest` a second time, so the ranking is only
    // ever computed once per hook.
    safeTelemetry(() => recordHookAttempt(telemetry, hook.kind));
    const ranked = rankCandidates(texts, { hook, recent: [...recent, ...posts] });
    const best = ranked[0] && ranked[0].score >= MIN_PUBLISHABLE ? ranked[0] : null;
    safeTelemetry(() => recordCandidateOutcomes(telemetry, { ranked, winnerText: best ? best.text : null }));
    if (!best) {
      console.error(`  ${hook.ticker} (${hook.kind}): ${texts.length} candidates, none publishable`);
      continue;
    }

    usedTickers.add(hook.ticker);
    const ts = new Date().toISOString();
    const id = `${hook.ticker}-${ts}`;
    const post = {
      id,
      ts,
      kind: hook.kind,
      ticker: hook.ticker,
      name: hook.name,
      sector: hook.sec,
      text: best.text,
      score: best.score,
      reasons: best.reasons,
      facts: hook.facts,
    };

    // THE DESCRIPTOR *AND* THE SCENE — ci/company-descriptor.mjs, one extra call per PUBLISHED
    // post (never per candidate — this runs exactly once here, after `pickBest` above already
    // picked the winner). Injected exactly like `generateImageFor` below, so `generate()` stays
    // network-free and testable offline; `main()` wires it to the real provider + a persisted
    // cache. `getDescriptorFor` now resolves `{ descriptor, scene }` together (one call feeds
    // both — see ci/company-descriptor.mjs's module header): a missing injector, a thrown error,
    // or a malformed (non-object) response leave BOTH `post.descriptor` and the local `scene`
    // unset. `post.descriptor` unset falls back to composePost()'s own sector-mapped descriptor
    // (ci/post-compose.mjs); `scene` unset falls back to generateImageFor's own sector-mapped
    // scene (ci/post-image.mjs) — neither a failed call here nor a failed Flux call below ever
    // loses the post.
    let scene;
    if (typeof getDescriptorFor === "function") {
      let result;
      const descriptorT0 = Date.now();
      try {
        result = await getDescriptorFor(rowByTicker.get(hook.ticker) ?? { t: hook.ticker, n: hook.name, sec: hook.sec });
      } catch (err) {
        console.error(`  ${hook.ticker}: descriptor/scene generation threw — ${err.message}`);
      } finally {
        safeTelemetry(() => recordStageMs(telemetry, "descriptor", Date.now() - descriptorT0));
      }
      if (result && typeof result === "object") {
        if (typeof result.descriptor === "string" && result.descriptor.trim()) {
          post.descriptor = result.descriptor.trim();
        }
        if (typeof result.scene === "string" && result.scene.trim()) {
          scene = result.scene.trim();
        }
      }
    }

    // THREE separate steps, deliberately: text (above), image (here), fusion (below). Image
    // generation is injected exactly like `provider` above, so `generate()` stays
    // file-I/O-free and testable offline (see the shape note up top) — writing the bytes to
    // public/post-images/ happens in main(). The SECTOR, the TICKER, and the SCENE (resolved
    // above, or `undefined` on any failure) are passed in. The ticker is used for exactly one
    // thing: seeding buildImagePrompt's deterministic man/woman choice (ci/post-image.mjs). It
    // is never concatenated into the prompt text itself — ci/post-image.mjs never sees a hook
    // fact, number, company name, or the ticker AS TEXT. EVERY sector, `General` included, now
    // reaches this call — there is no more skip. A declined or failed call just omits `image`
    // and the card renders the canvas fallback — the post still publishes.
    //
    // (Wikimedia) TWO SOURCES NOW, controlled by `photoSource` (config.photoSource ->
    // POST_PHOTO_SOURCE — see main() below and ci/README.md): `"flux"` (the default and the
    // only behaviour that existed before this) generates via `generateImageFor` only.
    // `"wikimedia"` tries `getCompanyPhotoFor` (ci/company-photo.mjs's real, licensed photo)
    // first and falls back to Flux only when Commons has no usable hit — same "degrade, never
    // lose the post" posture as everything else here. `"both"` runs BOTH unconditionally (for a
    // human to compare side by side, see ci/company-photo.mjs's coverage tool) — the Wikimedia
    // photo still wins the PRIMARY slot when both succeed (a real photo beats a generated one
    // whenever one is actually available), and the Flux generation is saved ALONGSIDE it under
    // a `-compare-flux` suffix rather than discarded; that comparison file is never referenced
    // by the post record itself (`post.compareImage`/`post.compareImageBuffer` are stripped by
    // main() before posts.json is written, exactly like `imageBuffer`), so a reviewer finds it
    // by filename convention in public/post-images/, not through the app.
    if (typeof generateImageFor === "function" || typeof getCompanyPhotoFor === "function") {
      const displayName = displayCompanyName(hook.name);
      let wikiPhoto = null;
      if ((photoSource === "wikimedia" || photoSource === "both") && typeof getCompanyPhotoFor === "function") {
        const wikiT0 = Date.now();
        try {
          wikiPhoto = await getCompanyPhotoFor(displayName);
        } catch (err) {
          console.error(`  ${hook.ticker}: Wikimedia photo lookup threw — ${err.message}`);
        } finally {
          safeTelemetry(() => recordStageMs(telemetry, "wikimedia", Date.now() - wikiT0));
        }
      }
      // Flux runs when the source calls for it directly ("flux"/"both"), or as the fallback
      // when "wikimedia" came back with nothing usable.
      const needsFlux = photoSource === "flux" || photoSource === "both" || !wikiPhoto;
      let fluxPhoto = null;
      if (needsFlux && typeof generateImageFor === "function") {
        const imageT0 = Date.now();
        try {
          fluxPhoto = await generateImageFor(hook.sec, hook.ticker, scene);
        } catch (err) {
          console.error(`  ${hook.ticker}: image generation threw — ${err.message}`);
        } finally {
          safeTelemetry(() => recordStageMs(telemetry, "image", Date.now() - imageT0));
        }
      }

      const primaryPhoto = wikiPhoto ? wikiPhoto.bytes : fluxPhoto;
      // CC BY and CC BY-SA both legally require attribution — this credit line is where it
      // lives on the card itself (ci/post-compose.mjs's `credit` param). Never set for a Flux
      // photo: there is nothing to credit.
      const primaryCredit = wikiPhoto ? `Photo: ${wikiPhoto.attribution}` : undefined;
      // Only present under "both", and only when Wikimedia actually won the primary slot —
      // otherwise there is nothing distinct left to compare against.
      const comparisonPhoto = photoSource === "both" && wikiPhoto ? fluxPhoto : null;

      if (primaryPhoto) {
        // FUSION — burn the words into the pixels so the file travels with its text when
        // posted elsewhere. Pure and local (no network, no randomness beyond what's already
        // deterministic from the hook), so unlike `provider`/`generateImageFor` this is called
        // directly rather than injected — see ci/post-compose.mjs. A composition failure
        // degrades exactly like a failed Flux call: no `image` field, canvas fallback, post
        // still ships — never lose the post over an image.
        try {
          // DISPLAY name here too — the whole reason this exists (see the buildPrompt comment
          // above): the card must never print "Applied Materials, Inc." when "Applied
          // Materials" is what a person would actually call it. hook.name / post.name (above)
          // stay the raw legal name from src/data/stocks.json; only what gets BURNED INTO THE
          // PIXELS is stripped.
          const composed = composePost({
            photo: primaryPhoto, companyName: displayName, sector: hook.sec,
            descriptor: post.descriptor, statement: best.text, credit: primaryCredit,
          });
          post.image = postImageFilename(id);
          post.imageBuffer = composed.jpeg; // internal only — main() writes it to disk and strips it
          if (wikiPhoto) {
            post.imageSource = "wikimedia";
            post.imageLicense = wikiPhoto.license;
            post.imageAttribution = wikiPhoto.attribution;
          } else {
            post.imageSource = "flux";
          }
        } catch (err) {
          console.error(`  ${hook.ticker}: image composition threw — ${err.message}`);
        }
      }
      if (comparisonPhoto && post.image) {
        try {
          const composedCompare = composePost({
            photo: comparisonPhoto, companyName: displayName, sector: hook.sec,
            descriptor: post.descriptor, statement: best.text,
          });
          post.compareImage = post.image.replace(/\.jpg$/, "-compare-flux.jpg");
          post.compareImageBuffer = composedCompare.jpeg; // internal only, see main()
        } catch (err) {
          console.error(`  ${hook.ticker}: comparison image composition threw — ${err.message}`);
        }
      }
      if (!post.image) {
        console.log(`  ${hook.ticker}: image generation failed — shipped with canvas art`);
      }
    }

    posts.push(post);
    safeTelemetry(() => recordHookPublished(telemetry, hook.kind));
    console.log(`  ${hook.ticker} (${hook.kind}) scored ${best.score} from ${texts.length} candidates`);
  }

  return posts;
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

/** The last `n` committed snapshots, OLDEST FIRST, with the working-copy snapshot appended
 *  as the current one. The repo IS the history — 376 commits of src/data/stocks.json and
 *  counting — so there is nothing to store. Task 0 measured 30 snapshots at 0.68s / 18.6MB,
 *  covering 5.8 days.
 *
 *  Commits are listed with `--follow`-free `git log -- <path>`, which lists only the commits
 *  that CHANGED the file. That matters: plain `HEAD~1` is often an unrelated feature commit
 *  (Task 0, Finding 1) and comparing against it silently yields zero movement hooks.
 *
 *  In CI this runs AFTER the refresh step has overwritten the working copy but BEFORE the
 *  commit step, so the file on disk is genuinely newer than every commit. Locally, after a
 *  refresh has already been committed, the newest commit and the working copy are identical —
 *  the duplicate is dropped below so the window is not one snapshot short. */
function loadWindow(n) {
  const git = (args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

  const current = readJson(STOCKS, []);
  let shas = [];
  try {
    shas = git(["log", `-${n}`, "--format=%H", "--", "src/data/stocks.json"]).trim().split("\n").filter(Boolean);
  } catch {
    console.error("  no git history available — window rules are skipped this run");
    return [current];
  }

  const window = [];
  for (const sha of shas.reverse()) {            // oldest first
    try {
      window.push(JSON.parse(git(["show", `${sha}:src/data/stocks.json`])));
    } catch {
      // A commit that predates the file, or a bad blob: skip it, keep the rest.
    }
  }

  // Drop the newest commit if it is byte-identical to the working copy (the local case).
  const last = window[window.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(current)) window.pop();

  window.push(current);

  // LOUD, because the failure mode is silent. `git log` exits 0 on a shallow clone and
  // simply returns one sha, so the catch above never fires: the window quietly collapses
  // to 2 and record/steady/newcomer stop firing with nothing in the log to say why. That
  // is exactly what a default `actions/checkout@v4` (fetch-depth: 1) used to do to this
  // step. MIN_WINDOW is imported from ci/hooks.mjs rather than restated here, so the
  // threshold can never drift between the detector and this warning.
  if (window.length < MIN_WINDOW) {
    console.error(
      `  WARNING: only ${window.length} snapshot(s) in the window, below MIN_WINDOW=${MIN_WINDOW} — ` +
      "the record/steady/newcomer rules will NOT fire this run. " +
      `git log returned ${shas.length} commit(s) for src/data/stocks.json; ` +
      "the usual cause is a shallow clone (set fetch-depth: 0 on actions/checkout).",
    );
  }

  return window;
}

async function main() {
  // Kill switch. The UI half of this feature is behind the `feed` flag; this is the
  // generation half, so the whole thing can be switched off without reverting code.
  // Set POSTS_ENABLED to "false" in site.yml to stop writing posts.
  if (String(process.env.POSTS_ENABLED ?? "true").toLowerCase() === "false") {
    console.log("POSTS_ENABLED=false — generation is off, leaving posts.json unchanged");
    return;
  }

  // (Wikimedia) POST_PHOTO_SOURCE — see ci/company-photo.mjs and generate()'s own comment on
  // `photoSource` for what each value does. An unrecognised value falls back to the safe
  // default rather than silently doing nothing.
  const rawPhotoSource = String(process.env.POST_PHOTO_SOURCE ?? "flux").toLowerCase();
  const photoSource = ["flux", "wikimedia", "both"].includes(rawPhotoSource) ? rawPhotoSource : "flux";
  if (rawPhotoSource !== photoSource) {
    console.error(`  POST_PHOTO_SOURCE="${rawPhotoSource}" is not flux/wikimedia/both — defaulting to "flux"`);
  }

  const config = {
    postsPerRun: Number(process.env.POSTS_PER_RUN ?? 1),
    candidates: Number(process.env.POST_CANDIDATES ?? 5),
    photoSource,
  };
  const keep = Number(process.env.POSTS_KEEP ?? 200);
  // Same on/off shape as POSTS_ENABLED — a real image call can be switched off without
  // reverting code. Costs ~43 neurons against the same free 10,000/day pool the text
  // candidates already spend ~15% of.
  const imagesEnabled = String(process.env.POST_IMAGES ?? "true").toLowerCase() !== "false";

  const existing = readJson(POSTS, []);
  const exemplars = readJson(CORPUS, []);
  const history = loadWindow(Number(process.env.POST_WINDOW ?? 144));
  const curr = history[history.length - 1];

  console.log(`generate-posts — ${curr.length} rows, ${history.length} snapshots in window, ` +
              `${existing.length} existing posts, ` +
              `${config.postsPerRun} post(s) x ${config.candidates} candidates, ` +
              `images ${imagesEnabled ? "on" : "off"} (source: ${photoSource})`);

  const provider = makeProvider();
  // (Run telemetry) THREE independent trackers, one per consumer, not one shared one — this is
  // what lets ci/run-telemetry.mjs report each stage's OWN neuron cost (a total tells you
  // nothing about which knob to pull; a per-stage breakdown does). `CF_MODEL` (env.CF_MODEL) is
  // passed through to each so the measured-token->neuron conversion charges the documented rate
  // for the model actually in use, not silently assuming the default.
  const cfModel = process.env.CF_MODEL;
  const writerUsage = newUsageTracker(cfModel);
  const descriptorUsage = newUsageTracker(cfModel);
  const imageUsage = newUsageTracker(cfModel);
  const telemetry = newRunTelemetry({ writer: writerUsage, descriptor: descriptorUsage, image: imageUsage });

  // (Run telemetry) "Say so before starting, rather than failing partway" — read the persisted
  // history (if any), sum what today has already spent, and compare that against a rough
  // estimate of what a run like this one typically costs (this run's OWN cost is not knowable
  // until it has actually run). Advisory only: it changes nothing about whether the run
  // proceeds — Cloudflare's own 4006 handling (ci/cf-budget.mjs) is what actually degrades
  // gracefully if the budget really is gone.
  const historyBefore = readJson(NEURON_HISTORY, []);
  const todayKey = utcDateKey();
  const usedTodayBeforeRun = sumNeuronsForDate(historyBefore, todayKey);
  const estimatedRunCost = estimateRunCostFromHistory(historyBefore);
  if (estimatedRunCost != null && usedTodayBeforeRun + estimatedRunCost > 10_000) {
    console.error(
      `  WARNING: ~${Math.round(usedTodayBeforeRun)} neurons already used today, and recent runs ` +
      `average ~${Math.round(estimatedRunCost)} neurons — this run may not have enough of today's ` +
      "free allocation left to complete. Proceeding anyway; a genuine exhaustion degrades gracefully (see ci/cf-budget.mjs).",
    );
  }

  const generateImageFor = imagesEnabled
    ? (sector, ticker, scene) => generateImage({
        sector, ticker, scene, env: process.env, fetchImpl: globalThis.fetch,
        onSuccess: () => recordImageCall(imageUsage),
      })
    : undefined;
  // Wired in regardless of `photoSource` — generate() only ever CALLS this when the source
  // config actually calls for it ("wikimedia"/"both"), so this costs nothing when POST_IMAGES
  // is off or POST_PHOTO_SOURCE is left at the "flux" default. No cache: unlike the descriptor
  // (a model call, worth caching against neuron cost) this is a free, keyless HTTP call, and a
  // company's real-world Commons coverage does not change run to run in a way worth
  // invalidating a cache for.
  const getCompanyPhotoFor = imagesEnabled
    ? (companyName) => findCompanyPhoto(companyName, { fetchImpl: globalThis.fetch })
    : undefined;
  // The descriptor cache persists per-company results ACROSS runs (see the DESCRIPTORS const
  // above) — reused, not regenerated, whenever the same ticker comes up again, so this call
  // costs neurons only on a genuine cache miss.
  const descriptorCache = readJson(DESCRIPTORS, {});
  const getDescriptorFor = (row) => describeCompany({
    row, provider, cache: descriptorCache,
    onUsage: (usage) => recordTextCall(descriptorUsage, "descriptor", usage),
  });
  const posts = await generate({
    history, recent: existing.slice(0, 50), provider, exemplars, config, generateImageFor, getDescriptorFor,
    getCompanyPhotoFor, usageTracker: writerUsage, telemetry,
  });

  // (Run telemetry) The one compact, aligned block the brief asks for — printed every run,
  // whether or not anything published, so a bad run's WASTE is visible even when it produced
  // nothing. Per-candidate/per-hook detail already streamed above this, verbosely; this is the
  // part meant to be read.
  //
  // `exhausted: isExhausted()` is load-bearing, not decorative: a run where every call 429'd on
  // code 4006 records ZERO local spend (a rejected call is never billed, so onUsage/onSuccess
  // never fire — see ci/neuron-usage.mjs), which used to make this line report "10,000
  // remaining" in the SAME summary that had already printed "the daily free allocation is
  // exhausted" a few lines earlier. A real 4006 is authoritative regardless of what this
  // process measured locally — see ci/run-telemetry.mjs's `computeHeadroom` for the full
  // reasoning and ci/test-run-telemetry.mjs for the regression test pinning this exact case.
  const headroomAfter = computeHeadroom(usedTodayBeforeRun, totalNeuronsForRun(telemetry), { exhausted: isExhausted() });
  let historyAfter = historyBefore;
  try {
    const record = buildHistoryRecord(telemetry, { publishedCount: posts.length });
    historyAfter = trimHistory([...historyBefore, record], NEURON_HISTORY_KEEP);
    writeFileSync(NEURON_HISTORY, `${JSON.stringify(historyAfter, null, 2)}\n`);
  } catch (err) {
    console.error(`  neuron usage history write failed (ignored) — ${err?.message ?? err}`);
  }
  console.log(formatSummaryBlock(telemetry, {
    publishedCount: posts.length,
    headroom: headroomAfter,
    historyNote: `${historyAfter.length} run(s) in neuron usage history (${NEURON_HISTORY_KEEP} max kept).`,
  }));

  if (!posts.length) {
    console.log("nothing publishable this run — leaving posts.json unchanged");
    return;
  }

  // Persist whatever the descriptor cache picked up this run (new tickers, or a stale entry
  // refreshed after a name change) — same "only write when there is something to publish"
  // posture as posts.json/the image files below.
  writeFileSync(DESCRIPTORS, `${JSON.stringify(descriptorCache, null, 2)}\n`);

  // Write the image bytes now — generate() stays file-I/O-free (see the shape note up top),
  // so this is the only place in the pipeline that touches public/post-images/.
  mkdirSync(IMAGES_DIR, { recursive: true });
  // (Wikimedia) The `-compare-flux` file (POST_PHOTO_SOURCE=both only — see generate()'s own
  // comment) is written the same way but deliberately NEVER referenced by the post record: it
  // exists purely for a human to open both files side by side in public/post-images/, and is
  // dropped from `posts.json` before that file is even written, below.
  const compareFilenames = [];
  for (const post of posts) {
    if (post.imageBuffer) {
      writeFileSync(path.join(IMAGES_DIR, post.image), post.imageBuffer);
      delete post.imageBuffer;
    }
    if (post.compareImageBuffer) {
      writeFileSync(path.join(IMAGES_DIR, post.compareImage), post.compareImageBuffer);
      compareFilenames.push(post.compareImage);
      delete post.compareImageBuffer;
      delete post.compareImage;
    }
  }

  const rolling = [...posts, ...existing].slice(0, keep);
  writeFileSync(POSTS, `${JSON.stringify(rolling, null, 2)}\n`);
  console.log(`wrote ${posts.length} post(s) — ${posts.map((p) => p.ticker).join(", ")}`);
  if (compareFilenames.length) {
    console.log(`  wrote ${compareFilenames.length} comparison image(s) for review, not in posts.json: ` +
                compareFilenames.join(", "));
  }

  // Prune: POSTS_KEEP bounds posts.json, but says nothing about the image files themselves —
  // at ~100KB/image that is unbounded growth in git otherwise. Anything under
  // public/post-images/ whose post fell out of the rolling window this write produced gets
  // deleted right here. THIS RUN's `-compare-flux` files are spared for exactly one run (they
  // are not in `rolling` at all, since posts.json never carries them — see above): a reviewer
  // needs to look right after the run that produced them, because the next run's prune pass has
  // no record of them and will delete them as orphaned, same as any other untracked file here.
  const keptImages = new Set([...rolling.filter((p) => p.image).map((p) => p.image), ...compareFilenames]);
  let pruned = 0;
  for (const file of readdirSync(IMAGES_DIR)) {
    if (!keptImages.has(file)) {
      rmSync(path.join(IMAGES_DIR, file));
      pruned++;
    }
  }
  console.log(`pruned ${pruned} orphaned post image(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
