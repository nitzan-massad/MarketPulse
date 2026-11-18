// DEV TOOL (not a test — the name deliberately does not match ci/test-*.mjs): walks the last N
// data commits and runs lossReport on each consecutive pair, to tune LIMITS in ci/data-loss.mjs
// and to prove the gate would not have gone false-red on history. Read-only (git show / ls-tree).
//   node ci/replay-data-loss.mjs [N=60]
import { execFileSync } from "node:child_process";
import { lossReport, LIMITS, countRows } from "./data-loss.mjs";

const N = Number(process.argv[2] || 60);
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 28 });
const show = (sha, p, dflt) => { try { return JSON.parse(git("show", `${sha}:${p}`)); } catch { return dflt; } };
// forecast rows (raw arrays) at a commit: one `git cat-file --batch` over every per-ticker blob
function fcCounts(sha) {
  const files = git("ls-tree", "-r", sha, "--", "public/forecasts").trim().split("\n").filter(Boolean)
    .map((l) => { const [meta, name] = l.split("\t"); return { blob: meta.split(" ")[2], name: name.slice("public/forecasts/".length) }; })
    .filter((f) => f.name.endsWith(".json") && !f.name.startsWith("_"));
  const out = execFileSync("git", ["cat-file", "--batch"], { input: files.map((f) => f.blob).join("\n") + "\n", maxBuffer: 1 << 30 }); // Buffer: sizes are bytes
  const counts = {}; let pos = 0;
  for (const f of files) {
    const nl = out.indexOf(10, pos); const size = Number(out.subarray(pos, nl).toString().split(" ")[2]);
    const body = out.subarray(nl + 1, nl + 1 + size).toString("utf8"); pos = nl + 1 + size + 1;
    try { const j = JSON.parse(body); if (Array.isArray(j)) counts[f.name.slice(0, -5)] = j; } catch { /* not a per-ticker array */ }
  }
  return counts;
}
const shas = git("log", `-${N + 1}`, "--format=%H", "--", "src/data/stocks.json").trim().split("\n").reverse();
const snap = (sha) => ({ rows: show(sha, "src/data/stocks.json", []), seen: show(sha, "src/data/seen.json", {}), fc: fcCounts(sha) });
const cDate = (sha) => Date.parse(git("log", "-1", "--format=%cI", sha).trim());
const counts = (raw, now) => Object.fromEntries(Object.entries(raw).map(([t, r]) => [t, countRows(r, now)]));
const t0 = Date.now();
let prev = snap(shas[0]), bad = 0;
const maxLost = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, 0]));
for (let i = 1; i < shas.length; i++) {
  const next = snap(shas[i]); const now = cDate(shas[i]); // newer snapshot's commit date = "now"
  const nm = new Map(next.rows.map((r) => [r.t, r]));
  for (const k of Object.keys(LIMITS))
    maxLost[k] = Math.max(maxLost[k], prev.rows.filter((p) => nm.has(p.t) && p[k] != null && nm.get(p.t)[k] == null).length);
  // computeKeep's expiry list is not in git: treat ticker/seen-key removals as "expired" so only
  // the other violation kinds are scored; the removals themselves are printed for a manual look.
  const removed = prev.rows.filter((p) => !nm.has(p.t)).map((p) => p.t);
  const seenGone = Object.keys(prev.seen).filter((t) => !(t in next.seen));
  const r = lossReport({ prevRows: prev.rows, nextRows: next.rows, prevSeen: prev.seen, nextSeen: next.seen, prevFc: counts(prev.fc, now), nextFc: counts(next.fc, now), dropped: [...removed, ...seenGone] });
  console.log(`${shas[i].slice(0, 9)} rows ${prev.rows.length}->${next.rows.length} removed ${removed.length} seenGone ${seenGone.length} violations ${r.length}`);
  for (const l of r) console.log("    " + l);
  bad += r.length; prev = next;
}
console.log(`pairs ${shas.length - 1}, violations ${bad}, max rows lost per field ${JSON.stringify(maxLost)}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
