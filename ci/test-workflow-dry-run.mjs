// Guards site.yml's dry_run contract: "scrape and run the gates, but do not commit, deploy or mark
// requests tracked" — and nothing else outside the runner either. Every step that WRITES somewhere
// other than the runner's disk (git push, Firebase Hosting, GitHub Pages, RTDB) must be skipped
// when `inputs.dry_run` is set. The pin step was the leak: it PATCHes RTDB trackRequests
// (planUnrequest), so a "read-only" dry run deleted live requests.
// No YAML dependency: steps are split on `- name:` / `- uses:` / `- run:` at the steps indent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yml = readFileSync(new URL("../.github/workflows/site.yml", import.meta.url), "utf8");
const body = yml.slice(yml.indexOf("    steps:\n") + "    steps:\n".length);
const steps = body.split(/\n(?=      - )/).map((s) => s.trim()).filter((s) => s.startsWith("- "));
// a step is named by `name:`, else its `uses:`, else its first `run:` line (e.g. `- id: deployment` + `uses:`)
const nameOf = (s) => (s.match(/^-?\s*name:\s*(.+)$/m) || s.match(/^-?\s*uses:\s*(.+)$/m) || s.match(/^-?\s*run:\s*(.+)$/m) || [, s.split("\n")[0]])[1].trim();
const ifOf = (s) => (s.match(/^\s*if:\s*(.+)$/m) || [])[1] || "";
const find = (re) => {
  const hit = steps.filter((s) => re.test(nameOf(s)));
  assert.equal(hit.length, 1, `exactly one step matching ${re} (found ${hit.map(nameOf).join(", ") || "none"})`);
  return hit[0];
};
assert(steps.length >= 20, `parsed ${steps.length} steps — the splitter no longer matches site.yml's layout`);

// the external writers: each must be skipped on a dry run
const writers = [
  [/^Pin requested tickers$/, "RTDB PATCH (planUnrequest) + keepalive"],
  [/^Commit refreshed data$/, "git push"],
  [/^Deploy to Firebase Hosting$/, "Firebase Hosting"],
  [/^actions\/upload-pages-artifact/, "Pages artifact"],
  [/^actions\/deploy-pages/, "Pages deploy"],
  [/^Mark requests tracked$/, "RTDB PATCH trackRequests"],
  [/^Clear folded tracked rows$/, "RTDB DELETE trackedRows"],
];
for (const [re, what] of writers) {
  const cond = ifOf(find(re));
  assert(/!\s*inputs\.dry_run/.test(cond), `${re} writes to ${what}: its if: must include !inputs.dry_run (got "${cond}")`);
}

// the steps a dry run is FOR still run on it (a dry run that skips the scrape proves nothing)
for (const re of [/^Refresh TipRanks snapshot/, /^Backfill forecasts/, /THE DATA GATE/, /^Health gate$/, /^Snapshot previous data/]) {
  assert(!/inputs\.dry_run/.test(ifOf(find(re))), `${re} must not be skipped on a dry run`);
}

// Fold stays ungated on purpose (the snapshot + gate must see what a real run would): that is only
// safe while fold READS RTDB. Its branch in ci/track-requests.mjs may only GET.
const tr = readFileSync(new URL("./track-requests.mjs", import.meta.url), "utf8");
const fold = tr.slice(tr.indexOf('if (mode === "fold")'), tr.indexOf('if (mode === "clear")'));
assert(fold.length > 200, "found the fold branch");
assert(/rtdb\(token, "GET"/.test(fold), "fold reads trackedRows");
assert(!/"(PATCH|PUT|POST|DELETE)"/.test(fold), "fold must never write RTDB — it runs on dry runs");
assert(!/inputs\.dry_run/.test(ifOf(find(/^Fold lite-run tracked rows$/))), "fold runs on dry runs (read-only)");
console.log(`site.yml dry_run: ${writers.length} external writers gated, fold read-only (${steps.length} steps)`);
