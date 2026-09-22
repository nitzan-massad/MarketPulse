// A cross-file invariant no single module can hold: every hook kind the generator knows
// about must reach the reader as its own thing at BOTH ends of the pipeline.
//
// This exists because six of the nine kinds once shipped with no accent rule of their own
// and inherited the default navy pill, so `record`, `trend`, `steady`, `churn`, `newcomer`
// and `list` were visually indistinguishable in the feed. Nothing could catch that: hooks.mjs
// does not know about CSS, and index.css does not know about hooks.mjs.
//
// KIND_BRIEF is the registry — ci/test-generate-posts.mjs already pins it to the nine kinds
// ci/hooks.mjs emits, so this check reads the list from there rather than restating it.

import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KIND_BRIEF } from "./generate-posts.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const css = readFileSync(path.join(ROOT, "src", "index.css"), "utf8");

const kinds = Object.keys(KIND_BRIEF);
assert.ok(kinds.length >= 9, `the kind registry is populated (${kinds.length} kinds)`);

const accents = new Map();
for (const kind of kinds) {
  const re = new RegExp(`\\.feed-card\\.k-${kind}\\s*\\{[^}]*--acc:\\s*([^;}]+)`);
  const m = css.match(re);
  assert.ok(m, `src/index.css sets --acc for .feed-card.k-${kind}`);
  accents.set(kind, m[1].trim());
}

// Distinct, or the rule is there but the pill still looks the same.
const seen = new Map();
for (const [kind, acc] of accents) {
  assert.equal(seen.has(acc), false,
    `${kind} reuses the accent already given to ${seen.get(acc)} (${acc})`);
  seen.set(acc, kind);
}

// Every accent must be a token that already exists in :root — no hardcoded hex in the feed.
const root = css.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
for (const [kind, acc] of accents) {
  const token = acc.match(/^var\((--[\w-]+)\)$/)?.[1];
  assert.ok(token, `${kind}'s accent is a var(), not a literal colour (${acc})`);
  assert.ok(new RegExp(`${token}\\s*:`).test(root), `${token} (used by ${kind}) is defined on :root`);
}

// The two lightest tokens are unusable as 9px uppercase pill text on a near-white card.
for (const [kind, acc] of accents) {
  assert.equal(/var\(--(faint|fg-nu)\)/.test(acc), false,
    `${kind} uses ${acc}, which is too light for the pill`);
}

console.log(`feed-kinds OK — ${kinds.length} kinds, each with its own :root-defined accent ` +
            `(${[...accents].map(([k, a]) => `${k}=${a}`).join(", ")})`);
