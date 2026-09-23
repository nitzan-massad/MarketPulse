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
import { detectHooks, deTickerHooks, MIN_WINDOW } from "./hooks.mjs";
import { pickBest } from "./post-score.mjs";
import { makeProvider } from "./provider.mjs";
import { generateImage, postImageFilename } from "./post-image.mjs";
import { composePost } from "./post-compose.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const STOCKS = path.join(ROOT, "src", "data", "stocks.json");
const POSTS = path.join(ROOT, "src", "data", "posts.json");
const CORPUS = path.join(ROOT, "ci", "style-corpus.json");
const IMAGES_DIR = path.join(ROOT, "public", "post-images");

/** The ANGLE — one line per hook kind, telling the model what makes this particular hook
 *  postable. Without it a kind falls through to "Report the fact.", which throws away the
 *  entire reason the rule fired: a `record` post that does not say "highest in the window"
 *  is just another upside number. One entry per kind ci/hooks.mjs can emit, all nine —
 *  ci/test-generate-posts.mjs fails if a kind is ever added without one. */
export const KIND_BRIEF = {
  surprise: "The number is the story. Lead with it.",
  contrarian: "Two models disagree. Name the disagreement, do not resolve it.",
  list: "A short ranked list. No preamble before the first name.",
  movement: "Something changed since five hours ago. Say what, and from what to what.",
  record: "This is the highest reading of the whole window. Say it is a high, and say how far it came.",
  trend: "One direction across days, not a single jump. Give both ends and which way it went.",
  steady: "Nothing moved, and that is the story. Say what it has held and for how long.",
  churn: "The quant model keeps changing its mind. Say how many different scores, and the range.",
  newcomer: "This name was not on the board when the window opened. Say it is new, and how long it has been here.",
};

export function buildPrompt(hook, exemplars = []) {
  const system = [
    "You write short posts for a stock-data feed, in the voice of a finance person on X.",
    "Rules, all of them hard:",
    "- MAXIMUM 8 WORDS. Count them before you answer. 9 words is a failure, not a rounding error.",
    "- Good 8-word example: \"Astera Labs upside halved. Smart Score doubled.\" — that is 8 words, uses the company name, and uses two of the numbers you were given.",
    "- Use the company's NAME, never its ticker symbol. Say \"Astera Labs\", not \"ALAB\".",
    "- Open with the fact. No greeting, no preamble, no 'Let's dive in'.",
    "- Use the exact numbers you are given. Never invent a number.",
    "- No hashtags beyond one. No emoji. At most one exclamation mark, ideally zero.",
    "- Never give advice, never say buy or sell, never predict. Report what the data says.",
    "- No disclaimer, no 'not financial advice' line — the app adds that itself.",
    "- Output the post text only. No quotes around it, no explanation, no options list.",
  ].join("\n");

  const shots = exemplars.length
    ? `Posts in the voice to match:\n${exemplars.map((e) => `- ${e}`).join("\n")}\n\n`
    : "";

  const facts = Object.entries(hook.facts)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const prompt =
    `${shots}Angle: ${KIND_BRIEF[hook.kind] ?? "Report the fact."}\n\n` +
    `Company: ${hook.name} (${hook.ticker}), ${hook.sec}\nFacts:\n${facts}\n\n` +
    `Write the post.`;

  return { system, prompt };
}

export async function generate({ history, recent = [], provider, exemplars = [], config = {}, generateImageFor }) {
  const { postsPerRun = 1, candidates = 5, kindMemory = 4 } = config;
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
  const posts = [];
  const usedTickers = new Set();

  for (const hook of hooks) {
    if (posts.length >= postsPerRun) break;
    if (usedTickers.has(hook.ticker)) continue;

    const { system, prompt } = buildPrompt(hook, exemplars);
    let texts = [];
    try {
      texts = await provider({ system, prompt, n: candidates });
    } catch (err) {
      console.error(`  ${hook.ticker}: provider threw — ${err.message}`);
      continue;
    }

    const best = pickBest(texts, { hook, recent: [...recent, ...posts] });
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

    // THREE separate steps, deliberately: text (above), image (here), fusion (below). Image
    // generation is injected exactly like `provider` above, so `generate()` stays
    // file-I/O-free and testable offline (see the shape note up top) — writing the bytes to
    // public/post-images/ happens in main(). Only the SECTOR and the TICKER are passed in, and
    // the ticker is used for exactly one thing: seeding buildImagePrompt's deterministic
    // man/woman choice (ci/post-image.mjs). It is never concatenated into the prompt text
    // itself — ci/post-image.mjs never sees a hook fact, number, company name, or the ticker
    // AS TEXT. A declined or failed call just omits `image` and the card renders the canvas
    // fallback — the post still publishes.
    if (typeof generateImageFor === "function") {
      let photo = null;
      try {
        photo = await generateImageFor(hook.sec, hook.ticker);
      } catch (err) {
        console.error(`  ${hook.ticker}: image generation threw — ${err.message}`);
      }
      if (photo) {
        // FUSION — burn the words into the pixels so the file travels with its text when
        // posted elsewhere. Pure and local (no network, no randomness beyond what's already
        // deterministic from the hook), so unlike `provider`/`generateImageFor` this is called
        // directly rather than injected — see ci/post-compose.mjs. A composition failure
        // degrades exactly like a failed Flux call: no `image` field, canvas fallback, post
        // still ships — never lose the post over an image.
        try {
          const composed = composePost({
            photo, companyName: hook.name, sector: hook.sec, statement: best.text,
          });
          post.image = postImageFilename(id);
          post.imageBuffer = composed.png; // internal only — main() writes it to disk and strips it
        } catch (err) {
          console.error(`  ${hook.ticker}: image composition threw — ${err.message}`);
        }
      }
      if (!post.image) {
        console.log(`  ${hook.ticker}: image generation failed — shipped with canvas art`);
      }
    }

    posts.push(post);
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
  // to 2 and record/trend/steady/churn/newcomer stop firing with nothing in the log to
  // say why. That is exactly what a default `actions/checkout@v4` (fetch-depth: 1) used
  // to do to this step. MIN_WINDOW is imported from ci/hooks.mjs rather than restated
  // here, so the threshold can never drift between the detector and this warning.
  if (window.length < MIN_WINDOW) {
    console.error(
      `  WARNING: only ${window.length} snapshot(s) in the window, below MIN_WINDOW=${MIN_WINDOW} — ` +
      "the record/trend/steady/churn/newcomer rules will NOT fire this run. " +
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

  const config = {
    postsPerRun: Number(process.env.POSTS_PER_RUN ?? 1),
    candidates: Number(process.env.POST_CANDIDATES ?? 5),
  };
  const keep = Number(process.env.POSTS_KEEP ?? 200);
  // Same on/off shape as POSTS_ENABLED — a real image call can be switched off without
  // reverting code. Costs ~43 neurons against the same free 10,000/day pool the text
  // candidates already spend ~15% of.
  const imagesEnabled = String(process.env.POST_IMAGES ?? "true").toLowerCase() !== "false";

  const existing = readJson(POSTS, []);
  const exemplars = readJson(CORPUS, []);
  const history = loadWindow(Number(process.env.POST_WINDOW ?? 30));
  const curr = history[history.length - 1];

  console.log(`generate-posts — ${curr.length} rows, ${history.length} snapshots in window, ` +
              `${existing.length} existing posts, ` +
              `${config.postsPerRun} post(s) x ${config.candidates} candidates, ` +
              `images ${imagesEnabled ? "on" : "off"}`);

  const provider = makeProvider();
  const generateImageFor = imagesEnabled
    ? (sector, ticker) => generateImage({ sector, ticker, env: process.env, fetchImpl: globalThis.fetch })
    : undefined;
  const posts = await generate({ history, recent: existing.slice(0, 50), provider, exemplars, config, generateImageFor });

  if (!posts.length) {
    console.log("nothing publishable this run — leaving posts.json unchanged");
    return;
  }

  // Write the image bytes now — generate() stays file-I/O-free (see the shape note up top),
  // so this is the only place in the pipeline that touches public/post-images/.
  mkdirSync(IMAGES_DIR, { recursive: true });
  for (const post of posts) {
    if (post.imageBuffer) {
      writeFileSync(path.join(IMAGES_DIR, post.image), post.imageBuffer);
      delete post.imageBuffer;
    }
  }

  const rolling = [...posts, ...existing].slice(0, keep);
  writeFileSync(POSTS, `${JSON.stringify(rolling, null, 2)}\n`);
  console.log(`wrote ${posts.length} post(s) — ${posts.map((p) => p.ticker).join(", ")}`);

  // Prune: POSTS_KEEP bounds posts.json, but says nothing about the image files themselves —
  // at ~100KB/image that is unbounded growth in git otherwise. Anything under
  // public/post-images/ whose post fell out of the rolling window this write produced gets
  // deleted right here.
  const keptImages = new Set(rolling.filter((p) => p.image).map((p) => p.image));
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
