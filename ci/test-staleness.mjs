// Self-check for the forecast/bullbear refresh queue. The bug this guards against:
// selection keyed off file mtime, which actions/checkout resets on every run, so every
// file looked fresh, nothing was ever refreshed, and only brand-new tickers got fetched
// (public/forecasts sat frozen 2026-07-24 -> 2026-08-02). Run: node ci/test-staleness.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const STALE_DAYS = 3;
const staleBefore = Date.now() - STALE_DAYS * 864e5;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();

// --- the selection logic, mirrored from the two scrapers -------------------
const select = (tickers, asOf, limit) =>
  tickers
    .filter((t) => (Date.parse(asOf[t]) || 0) < staleBefore)
    .sort((a, b) => (Date.parse(asOf[a]) || 0) - (Date.parse(asOf[b]) || 0))
    .slice(0, limit);

// a never-fetched ticker goes first; a fetched-today one is not selected at all
{
  const asOf = { FRESH: iso(0), OLD: iso(10), OLDER: iso(30) };
  assert.deepEqual(select(["FRESH", "OLD", "NEW", "OLDER"], asOf, 9), ["NEW", "OLDER", "OLD"]);
}

// LIMIT rotates: run N's picks are stamped, so run N+1 picks the next batch
{
  const asOf = {};
  const universe = ["A", "B", "C", "D", "E"];
  const first = select(universe, asOf, 2);
  for (const t of first) asOf[t] = iso(0);
  const second = select(universe, asOf, 2);
  assert.equal(first.length, 2);
  assert.deepEqual(second, universe.filter((t) => !first.includes(t)).slice(0, 2));
  assert.equal(first.some((t) => second.includes(t)), false, "batches must not overlap");
  for (const t of second) asOf[t] = iso(0);
  const third = select(universe, asOf, 2);
  assert.deepEqual(third, ["E"], "whole universe covered in ceil(5/2) runs");
}

// THE REGRESSION: a fresh git checkout must not reset staleness.
// mtime does; the committed asOf sidecar does not.
{
  const dir = mkdtempSync(join(tmpdir(), "mp-stale-"));
  try {
    const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@t"); git("config", "user.name", "t");
    writeFileSync(join(dir, "AAPL.json"), "[]");
    writeFileSync(join(dir, "_asOf.json"), JSON.stringify({ AAPL: iso(10) }));
    git("add", "-A"); git("commit", "-qm", "data");

    // age the working copy, then simulate actions/checkout (fresh worktree, new mtimes)
    const old = (Date.now() - 10 * 864e5) / 1000;
    utimesSync(join(dir, "AAPL.json"), old, old);
    git("worktree", "add", "-q", join(dir, "co"), "HEAD");
    const co = join(dir, "co");

    const { statSync } = await import("node:fs");
    assert.ok(statSync(join(co, "AAPL.json")).mtimeMs > staleBefore,
      "mtime survived checkout — the original bug would not reproduce, rewrite this test");
    const asOf = JSON.parse(readFileSync(join(co, "_asOf.json"), "utf8"));
    assert.deepEqual(select(["AAPL"], asOf, 9), ["AAPL"],
      "sidecar-aged ticker must still be selected after a fresh checkout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("staleness queue: ok");
