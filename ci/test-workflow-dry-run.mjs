// Guards site.yml's dry_run contract: "scrape and run the gates, but do not commit, deploy or mark
// requests tracked" — and nothing else outside the runner either. Every step that WRITES somewhere
// other than the runner's disk (git push, Firebase Hosting, RTDB) must be skipped
// when `inputs.dry_run` is set. The pin step was the leak: it PATCHes RTDB trackRequests
// (planUnrequest), so a "read-only" dry run deleted live requests.
// No YAML dependency: steps are split on `- name:` / `- uses:` / `- run:` at the steps indent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const yml = readFileSync(new URL("../.github/workflows/site.yml", import.meta.url), "utf8");
const body = yml.slice(yml.indexOf("    steps:\n") + "    steps:\n".length);
const steps = body.split(/\n(?=      - )/).map((s) => s.trim()).filter((s) => s.startsWith("- "));
// a step is named by `name:`, else its `uses:`, else its first `run:` line (e.g. `- uses: actions/checkout@v4`)
const nameOf = (s) => (s.match(/^-?\s*name:\s*(.+)$/m) || s.match(/^-?\s*uses:\s*(.+)$/m) || s.match(/^-?\s*run:\s*(.+)$/m) || [, s.split("\n")[0]])[1].trim();
const ifOf = (s) => (s.match(/^\s*if:\s*(.+)$/m) || [])[1] || "";
const find = (re) => {
  const hit = steps.filter((s) => re.test(nameOf(s)));
  assert.equal(hit.length, 1, `exactly one step matching ${re} (found ${hit.map(nameOf).join(", ") || "none"})`);
  return hit[0];
};
// The github.io redirect is deployed by redirect.yml only when it changes; a per-run Pages deploy
// here failed on GitHub artifact-API flakes and skipped mark/clear.
assert(!/deploy-pages|upload-pages-artifact|configure-pages/.test(yml), "site.yml must not deploy GitHub Pages (redirect.yml does)");
assert(steps.length >= 20, `parsed ${steps.length} steps — the splitter no longer matches site.yml's layout`);

// the external writers: each must be skipped on a dry run
const writers = [
  [/^Pin requested tickers$/, "RTDB PATCH (planUnrequest) + keepalive"],
  [/^Commit refreshed data$/, "git push"],
  [/^Deploy to Firebase Hosting$/, "Firebase Hosting"],
  [/^Mark requests tracked$/, "RTDB PATCH trackRequests"],
  [/^Clear folded tracked rows$/, "RTDB DELETE trackedRows"],
];
for (const [re, what] of writers) {
  const cond = ifOf(find(re));
  assert(/!\s*inputs\.dry_run/.test(cond), `${re} writes to ${what}: its if: must include !inputs.dry_run (got "${cond}")`);
}

// Quota spenders (M5): post + themes call the free Cloudflare model. A dry run commits nothing, so
// whatever it spends the next scheduled run spends again, and an exhausted daily tier turns that
// real run red. Neither feeds the gates, so a dry run skips both.
const spenders = [/^Generate social post$/, /^Classify sector themes$/];
for (const re of spenders) {
  const cond = ifOf(find(re));
  assert(/!\s*inputs\.dry_run/.test(cond), `${re} spends the Cloudflare neuron budget: its if: must include !inputs.dry_run (got "${cond}")`);
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
// accept_data_loss (I1): a manual-only input that relaxes the data-loss gate for ONE run. It must
// default to false, reach only the DATA GATE step, and be unreachable from a schedule/push run
// (inputs are empty there, but the event check makes that explicit rather than incidental).
const inputs = yml.slice(yml.indexOf("    inputs:\n"), yml.indexOf("\n  push:"));
const acc = inputs.slice(inputs.indexOf("      accept_data_loss:"));
assert(inputs.includes("      accept_data_loss:"), "workflow_dispatch declares accept_data_loss");
assert.match(acc, /^\s+type:\s*boolean$/m, "accept_data_loss is a boolean");
assert.match(acc, /^\s+default:\s*false$/m, "accept_data_loss defaults to false");
const gate = find(/THE DATA GATE/);
const accEnv = (gate.match(/^\s*ACCEPT_DATA_LOSS:\s*(.+)$/m) || [])[1] || "";
assert(/github\.event_name\s*==\s*'workflow_dispatch'/.test(accEnv) && /inputs\.accept_data_loss/.test(accEnv),
  `the DATA GATE's ACCEPT_DATA_LOSS must require a workflow_dispatch AND the input (got "${accEnv}")`);
const code = (s) => s.replace(/^\s*#.*$/gm, ""); // the splitter hangs each step's leading comments on the step before it
const accUsers = steps.filter((s) => /accept_data_loss|ACCEPT_DATA_LOSS/.test(code(s))).map(nameOf);
assert.deepEqual(accUsers, [nameOf(gate)], `only the DATA GATE may see accept_data_loss (found in: ${accUsers.join(", ")})`);
// the gate reads exactly "1": "true"/"false" strings from a hand-edited expression must not accept
const nl = readFileSync(new URL("./test-no-data-loss.mjs", import.meta.url), "utf8");
assert(/gateVerdict\(report, process\.env\.ACCEPT_DATA_LOSS\)/.test(nl), "test-no-data-loss.mjs decides through gateVerdict(report, ACCEPT_DATA_LOSS)");

// Step timeouts (M4): every continue-on-error step has its own timeout-minutes, and the job limit
// covers all of those BEFORE the commit plus a margin for the uncapped steps (npm ci/test, gate, commit).
// A hang in any one scrape step then ends that step, never the job before "Commit refreshed data".
const tmo = (s) => Number((s.match(/^\s*timeout-minutes:\s*(\d+)/m) || [])[1]);
const soft = steps.filter((s) => /^\s*continue-on-error:\s*true/m.test(s));
for (const s of soft) assert(tmo(s) > 0, `continue-on-error step "${nameOf(s)}" has no timeout-minutes`);
const jobTmo = Number((yml.match(/^    timeout-minutes:\s*(\d+)/m) || [])[1]);
const commitAt = steps.indexOf(find(/^Commit refreshed data$/));
const budget = soft.filter((s) => steps.indexOf(s) < commitAt).reduce((a, s) => a + tmo(s), 0);
const MARGIN = 15;
assert(jobTmo >= budget + MARGIN, `job timeout-minutes ${jobTmo} < sum of step timeouts ${budget} + ${MARGIN} margin: a run of slow steps would be killed before the commit`);
console.log(`site.yml: ${spenders.length} quota spenders skipped on dry_run; accept_data_loss reaches only the gate; ${soft.length} soft steps capped (${budget} min before the commit) under the job's ${jobTmo} — ok`);

console.log(`site.yml dry_run: ${writers.length} external writers gated, fold read-only (${steps.length} steps) — ok`);
