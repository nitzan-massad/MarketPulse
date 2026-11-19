// N1: an accepted data-loss run, exercised the way site.yml runs it — THROUGH ci/run-tests.mjs, which
// prints a passing check's output nowhere. The DATA LOSS lines must still end up where the Health
// gate reads them ($RUNNER_TEMP/health); running test-no-data-loss.mjs directly hid this gap.
// Spawns the runner with SKIP_CHECKS limited to test-no-data-loss.mjs (so no recursion into this file),
// a PREV_DIR holding one extra ticker, and a temp RUNNER_TEMP. No network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "accept-"));
try {
  const rows = JSON.parse(readFileSync(join(root, "src/data/stocks.json"), "utf8"));
  writeFileSync(join(dir, "prev-stocks.json"), JSON.stringify([...rows, { t: "ZZZZ", n: "Gone Co" }]));
  cpSync(join(root, "src/data/seen.json"), join(dir, "prev-seen.json"));
  cpSync(join(root, "public/forecasts"), join(dir, "prev-forecasts"), { recursive: true });
  const run = (accept) => {
    rmSync(join(dir, "health"), { force: true });
    const r = spawnSync(process.execPath, ["ci/run-tests.mjs"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, SKIP_CHECKS: "^(?!ci/test-no-data-loss\\.mjs$)", PREV_DIR: dir, RUNNER_TEMP: dir, ACCEPT_DATA_LOSS: accept, DROPPED: "" },
    });
    const health = existsSync(join(dir, "health")) ? readFileSync(join(dir, "health"), "utf8") : "";
    return { status: r.status, out: r.stdout + r.stderr, health };
  };

  const acc = run("1");
  console.log(`accepted via runner: exit ${acc.status}; health file:\n${acc.health.trimEnd().replace(/^/gm, "  | ")}`);
  assert.equal(acc.status, 0, "accepted: the gate passes through the runner");
  assert.match(acc.out, /PASS\s+ci\/test-no-data-loss\.mjs/, "and it is the data-loss check that ran");
  assert.match(acc.health, /data-loss gate overridden \(accept_data_loss\): 1 violation\(s\) shipped/, "count line");
  assert.match(acc.health, /^DATA LOSS: 1 ticker\(s\) vanished without being expired: ZZZZ$/m, "the violation itself reaches the health file");

  const no = run("");
  console.log(`not accepted via runner: exit ${no.status}; DATA LOSS in runner output: ${/DATA LOSS: .*ZZZZ/.test(no.out)}; health file empty: ${no.health === ""}`);
  assert.notEqual(no.status, 0, "not accepted: the gate fails");
  assert.match(no.out, /DATA LOSS: 1 ticker\(s\) vanished without being expired: ZZZZ/, "a failing check's lines are printed by the runner");
  assert.equal(no.health, "", "and nothing is written to health (the run is already red by the gate)");
  console.log("data-loss accept via runner: ok");
} finally { rmSync(dir, { recursive: true, force: true }); }
