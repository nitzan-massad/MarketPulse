// Every dollar amount in the UI must be formatted by ONE rule. Run: node ci/test-price-format.mjs
//
// The bug this guards against, which shipped twice: ci/keep.mjs `rndPx` was taught to STORE
// sub-dollar prices at 4dp because a flat 2dp annihilates a sub-penny quote — but the
// renderers kept their own `toFixed(2)`. Fixing src/lib.ts `fmtPx` fixed the five list
// views and missed StockModal, which had its own private `usd()`/`fcUsd()` and went on
// printing "$0.00" across 14 sites including the chart's price axis. A private copy of a
// formatting rule is invisible to a test of the shared one, so this checks the SOURCE:
// no module may invent its own money formatter.
//
// src/*.check.ts covers fmtPx's behaviour; this covers its reach.
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name) && !/\.check\.ts$/.test(e.name)) files.push(p);
  }
})(SRC);

assert.ok(files.length > 5, `expected to find the src tree, found ${files.length} files`);
const rel = (p) => "src/" + path.relative(SRC, p);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// A dollar sign glued to a toFixed/toLocaleString — i.e. a hand-rolled money formatter.
// Matches `"$" + v.toFixed(2)` and `` `$${v.toFixed(2)}` ``. A line that reaches for pxDp or
// fmtPx is fine: that IS the shared rule, wrapped for a local signature.
// A LITERAL dollar sign — `"$"` / `'$'` as a string, or `$${…}` inside a template — not a
// backtick that merely happens to be followed by an interpolation (SVG path coordinates are
// full of `${x.toFixed(1)}` and are not money).
const OWN_FORMATTER = /(["']\$["']\s*[+]?[^;\n]{0,60}|\$\$\{[^}\n]{0,60})\.to(Fixed|LocaleString)\s*\(/;
const DELEGATES = /\b(pxDp|fmtPx|fmtMc)\b/;

// src/lib.ts is where the rule LIVES; it is the only file allowed to build one.
const OWNER = "src/lib.ts";
let checked = 0;
const offenders = [];
for (const f of files) {
  const name = rel(f);
  if (name === OWNER) continue;
  checked++;
  for (const line of strip(readFileSync(f, "utf8")).split("\n")) {
    if (OWN_FORMATTER.test(line) && !DELEGATES.test(line)) offenders.push(`${name}: ${line.trim()}`);
  }
}
assert.ok(offenders.length === 0,
  `these build their own price string instead of using fmtPx (or pxDp for just the decimals) `
  + `— a private copy is how "$0.00" survived the first fix:\n  ` + offenders.join("\n  "));
assert.ok(checked > 5, `expected to scan the components, scanned ${checked}`);

// ...and the rule itself must still be the shared one. A guard that only forbids copies is
// satisfiable by deleting the feature, so pin the behaviour that matters here too.
const lib = readFileSync(path.join(SRC, "lib.ts"), "utf8");
assert.ok(/export const pxDp/.test(lib), "src/lib.ts must export pxDp — StockModal's helpers take their decimals from it");
assert.ok(/toFixed\(4\)/.test(lib), "the sub-cent branch must still exist, or every price under a cent reads $0.00");

// StockModal is the file that regressed. Assert it consumes the shared rule rather than
// merely lacking a copy of it — the modal renders more prices than every list view combined.
const modal = readFileSync(path.join(SRC, "components", "StockModal.tsx"), "utf8");
assert.ok(/import \{[^}]*\bpxDp\b[^}]*\} from "\.\.\/lib"/.test(modal), "StockModal must import pxDp from ../lib");
// its chart axis sizes its own tick precision — that is fine, but it must widen below a cent
assert.ok(/hi >= 0\.01 \? 2 : 4/.test(modal), "the chart price axis must use 4dp below a cent, or every tick reads 0.00");

console.log(`price formatting: ok — ${checked} src file(s) scanned, no private money formatter`);
