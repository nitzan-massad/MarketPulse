// THE WIRING — hooks -> N candidates -> deterministic judge -> one post.
//
// Shape note: generate() takes its provider as an argument and does no file I/O, so
// ci/test-generate-posts.mjs can drive the whole pipeline offline with a fake provider.
// All reading and writing lives in main(), behind the entry guard at the bottom.
//
// Cadence is env config, not code — POSTS_PER_RUN=3 in site.yml is the only edit needed
// to go from one post per run to three.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { detectHooks, MIN_WINDOW } from "./hooks.mjs";
import { pickBest } from "./post-score.mjs";
import { makeProvider } from "./provider.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const STOCKS = path.join(ROOT, "src", "data", "stocks.json");
const POSTS = path.join(ROOT, "src", "data", "posts.json");
const CORPUS = path.join(ROOT, "ci", "style-corpus.json");

const KIND_BRIEF = {
  surprise: "The number is the story. Lead with it.",
  contrarian: "Two models disagree. Name the disagreement, do not resolve it.",
  list: "A short ranked list. No preamble before the first name.",
  movement: "Something changed since five hours ago. Say what, and from what to what.",
};

export function buildPrompt(hook, exemplars = []) {
  const system = [
    "You write short posts for a stock-data feed, in the voice of a finance person on X.",
    "Rules, all of them hard:",
    "- ONE sentence. Under 110 characters. Aim for 50 to 70. Shorter always wins.",
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

export async function generate({ history, recent = [], provider, exemplars = [], config = {} }) {
  const { postsPerRun = 1, candidates = 5, kindMemory = 4 } = config;
  // Task 0, Finding 2: feed the last few posts' KINDS back into the detector so the top
  // hook rotates shape instead of being "big upside number" every single run.
  const recentKinds = recent.slice(0, kindMemory).map((p) => p.kind).filter(Boolean);
  const hooks = detectHooks(history, { recentKinds });
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
    posts.push({
      id: `${hook.ticker}-${ts}`,
      ts,
      kind: hook.kind,
      ticker: hook.ticker,
      name: hook.name,
      sector: hook.sec,
      text: best.text,
      score: best.score,
      reasons: best.reasons,
      facts: hook.facts,
    });
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

  const existing = readJson(POSTS, []);
  const exemplars = readJson(CORPUS, []);
  const history = loadWindow(Number(process.env.POST_WINDOW ?? 30));
  const curr = history[history.length - 1];

  console.log(`generate-posts — ${curr.length} rows, ${history.length} snapshots in window, ` +
              `${existing.length} existing posts, ` +
              `${config.postsPerRun} post(s) x ${config.candidates} candidates`);

  const provider = makeProvider();
  const posts = await generate({ history, recent: existing.slice(0, 50), provider, exemplars, config });

  if (!posts.length) {
    console.log("nothing publishable this run — leaving posts.json unchanged");
    return;
  }

  writeFileSync(POSTS, `${JSON.stringify([...posts, ...existing].slice(0, keep), null, 2)}\n`);
  console.log(`wrote ${posts.length} post(s) — ${posts.map((p) => p.ticker).join(", ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
