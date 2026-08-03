// The one command that runs every check in this repo: `npm test`.
//
// There is no test framework here by design (see ci/README.md → Tests). Every check is a
// plain script that asserts with `node:assert` (or a local `eq()` helper) and exits
// non-zero when it is unhappy. This runner's whole job is to FIND them, run each one in
// its own child process, and turn "one of them exited 1" into "the CI job is red".
//
// Discovery is by pattern, never a hardcoded list — drop in `ci/test-foo.mjs` or
// `src/bar.check.ts` and it is picked up with no edit here:
//   • ci/test-*.mjs      run directly on this Node
//   • src/*.check.ts     compiled first with the repo's own `typescript` devDependency
//   • ci/keep.mjs        module with a built-in self-check behind an `import.meta.url` guard
//
// Two rules it enforces beyond pass/fail:
//   1. A check that exits 0 having produced no output, or whose source contains no
//      assertion at all, is reported as FAIL — a silently-vacuous test is worse than no
//      test, because it reads green forever.
//   2. `.ts` imports from a `.mjs` check need native type stripping (Node >= 22.18).
//      On an older Node the runner says so in one line instead of leaking
//      ERR_UNKNOWN_FILE_EXTENSION. See ci/README.md for why the workflows pin Node 24.
//
// No network access, no writes outside node_modules/.tmp/.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const CI_DIR = path.join(ROOT, "ci");
const SRC_DIR = path.join(ROOT, "src");
/** tsc output lands under node_modules (already gitignored, and `require("react")`
 *  resolves naturally from there — no NODE_PATH needed). */
const TS_OUT = path.join(ROOT, "node_modules", ".tmp", "checks");
const TSC = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const TIMEOUT_MS = 120_000;
const rel = (p) => path.relative(ROOT, p) || p;

// ---------------------------------------------------------------- discovery --

const list = (dir, re) =>
  (existsSync(dir) ? readdirSync(dir) : []).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));

const mjsChecks = list(CI_DIR, /^test-.+\.mjs$/);
const tsChecks = list(SRC_DIR, /\.check\.ts$/);
const selfChecks = [path.join(CI_DIR, "keep.mjs")].filter(existsSync);

// -------------------------------------------------------- vacuity heuristics --

/** Drop block comments and whole-line `//` comments so commented-out assertions don't
 *  count. Inline `//` is left alone on purpose — stripping it would eat "https://…". */
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

const ASSERT_PATTERNS = [
  /\bassert\s*\(/g, // assert(cond, "msg")            — ci/keep.mjs
  /\bassert\s*\.\s*\w+\s*\(/g, // assert.equal(...)   — ci/test-*.mjs
  /\beq\s*\(/g, // eq("label", got, want)             — src/*.check.ts
  /\bexpect\s*\(/g, // in case a framework ever lands
  /\bthrow new \w*Error\b/g, // the `if (failed) throw` tail
];

function countAssertions(file) {
  let src;
  try {
    src = stripComments(readFileSync(file, "utf8"));
  } catch {
    return 0;
  }
  return ASSERT_PATTERNS.reduce((n, re) => n + (src.match(re)?.length ?? 0), 0);
}

/** Lines that look like a check reporting a satisfied expectation. */
const EVIDENCE_RE = /\b(ok|OK|pass|PASS|passed)\b|✓/;

/** A `.mjs` check that imports a `.ts` module needs Node's native type stripping. */
const TS_IMPORT_RE = /(?:from|import\s*\(?)\s*["'][^"']+\.ts["']/;
const CAN_STRIP_TYPES = Boolean(process.features.typescript);

// ------------------------------------------------------------------ running --

/** @returns {{name:string, ok:boolean, ms:number, notes:string[], out:string}} */
function runCheck(name, argv, { source, needsTypeStripping = false }) {
  const notes = [];
  const assertions = countAssertions(source);
  if (assertions === 0) {
    return { name, ok: false, ms: 0, out: "", notes: ["no assertion found in the source — vacuous check"] };
  }
  if (needsTypeStripping && !CAN_STRIP_TYPES) {
    return {
      name,
      ok: false,
      ms: 0,
      out: "",
      notes: [
        `imports a .ts module, which needs Node >= 22.18 native type stripping — this is ${process.version}`,
        "the CI workflows pin Node 24; upgrade locally (nvm install 24) or run this check on 24+",
      ],
    };
  }

  const t0 = Date.now();
  const r = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  const ms = Date.now() - t0;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

  if (r.error?.code === "ETIMEDOUT" || r.signal) {
    notes.push(r.signal ? `killed by ${r.signal} after ${TIMEOUT_MS / 1000}s` : String(r.error));
    return { name, ok: false, ms, out, notes };
  }
  if (r.status !== 0) {
    notes.push(`exited ${r.status}`);
    return { name, ok: false, ms, out, notes };
  }
  // exit 0 from here on — now look for signs it actually did something
  if (out.trim() === "") {
    notes.push("exited 0 without printing anything — cannot tell it ran; make it say so");
    return { name, ok: false, ms, out, notes };
  }
  if (!EVIDENCE_RE.test(out)) {
    notes.push("exited 0 but printed no ok/pass line — verify it is not short-circuiting");
  }
  notes.push(`${assertions} assertion${assertions === 1 ? "" : "s"}`);
  return { name, ok: true, ms, out, notes };
}

// ------------------------------------------------------------------- report --

const results = [];
const t0 = Date.now();
const total = selfChecks.length + mjsChecks.length + tsChecks.length;

console.log(`MarketPulse checks — ${process.version} on ${process.platform}, ${total} discovered`);
console.log(
  `  ci/keep.mjs self-check: ${selfChecks.length}   ci/test-*.mjs: ${mjsChecks.length}   src/*.check.ts: ${tsChecks.length}`,
);
if (!CAN_STRIP_TYPES) {
  console.log(`  note: ${process.version} cannot import .ts (native type stripping needs >= 22.18)`);
}
console.log("");

// src/*.check.ts import their subjects without a file extension ("./lib") and one pulls in
// React + JSX, so Node cannot load them directly even with type stripping — they get one
// tsc pass into a CommonJS out-dir. Flags mirror the `npx tsc …` lines in each file's header.
if (tsChecks.length) {
  if (!existsSync(TSC)) {
    console.error(`cannot compile src/*.check.ts: ${rel(TSC)} is missing — run \`npm ci\`\n`);
    process.exit(1);
  }
  rmSync(TS_OUT, { recursive: true, force: true });
  mkdirSync(TS_OUT, { recursive: true });
  // The repo root is "type": "module"; tsc emits CommonJS here, so mark the out-dir
  // explicitly or Node parses the emitted .js as ESM and dies on `exports`.
  writeFileSync(path.join(TS_OUT, "package.json"), '{ "type": "commonjs" }\n');

  const ct0 = Date.now();
  const c = spawnSync(
    process.execPath,
    [
      TSC, ...tsChecks,
      "--outDir", TS_OUT,
      "--rootDir", SRC_DIR,
      "--module", "commonjs",
      "--target", "es2020",
      "--lib", "es2020,dom",
      "--jsx", "react",
      "--esModuleInterop",
      "--resolveJsonModule",
      "--skipLibCheck",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  const cms = Date.now() - ct0;
  if (c.status === 0) {
    console.log(`tsc  ${tsChecks.length} TypeScript check(s) compiled  ${(cms / 1000).toFixed(1)}s\n`);
  } else {
    // Record as its own failure but keep going: tsc emits despite type errors, so the
    // checks it did produce can still report real regressions in the same run.
    results.push({
      name: `tsc (${tsChecks.length} x src/*.check.ts)`,
      ok: false,
      ms: cms,
      out: `${c.stdout ?? ""}${c.stderr ?? ""}`,
      notes: [`tsc exited ${c.status}`],
    });
    console.log(`tsc  FAILED (exit ${c.status}) — running whatever it emitted anyway\n`);
  }
}

for (const f of selfChecks) {
  results.push(runCheck(rel(f), [f], { source: f }));
}
for (const f of mjsChecks) {
  const needsTypeStripping = TS_IMPORT_RE.test(readFileSync(f, "utf8"));
  results.push(runCheck(rel(f), [f], { source: f, needsTypeStripping }));
}
for (const f of tsChecks) {
  const js = path.join(TS_OUT, path.basename(f).replace(/\.ts$/, ".js"));
  if (!existsSync(js)) {
    results.push({ name: rel(f), ok: false, ms: 0, out: "", notes: ["tsc emitted no JavaScript for this file"] });
    continue;
  }
  results.push(runCheck(rel(f), [js], { source: f }));
}

const width = Math.max(0, ...results.map((r) => r.name.length));
for (const r of results) {
  const secs = `${(r.ms / 1000).toFixed(1)}s`.padStart(6);
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)} ${secs}  ${r.notes.join("; ")}`);
  if (!r.ok && r.out.trim()) {
    for (const line of r.out.trimEnd().split("\n")) console.log(`        | ${line}`);
  }
}

const failed = results.filter((r) => !r.ok);
const suspicious = results.filter((r) => r.ok && r.notes.some((n) => n.startsWith("exited 0 but")));
console.log("");
console.log(
  `${results.length} check(s): ${results.length - failed.length} passed, ${failed.length} failed` +
    ` in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
if (suspicious.length) console.log(`suspicious (passed, but prove it): ${suspicious.map((r) => r.name).join(", ")}`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
if (!results.length) {
  console.error("no checks discovered at all — ci/test-*.mjs and src/*.check.ts are both empty?");
  process.exit(1);
}
console.log("all checks passed");
