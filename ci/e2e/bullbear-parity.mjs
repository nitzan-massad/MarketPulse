// E2E TEXT PARITY: new payload.json parser vs the bull/bear files the OLD HTML parser wrote.
// Run: node ci/e2e/bullbear-parity.mjs        (CACHE_DIR=<dir> reuses/stores raw bodies; OFFLINE=1 = cache only)
//
// Baseline = public/bullbear/<T>.json as of BASE (default dfc2000d6^, the last old-parser commit), so later
// scrapes by the new parser can't make this pass trivially. Per point: exact | norm (equal after case/space/
// quote folding) | changed. A changed ticker is "updated" (TipRanks re-generated the AI thesis since asOf:
// same counts, full-length well-formed rewrites) unless it shows a parser-LOSS signature: fewer points, a
// body that is a truncated piece of the old one / much shorter, a missing thesis, or HTML residue -> exit 1.
// (No live-HTML arbiter: Cloudflare 403s the /stocks/<t> page from this Mac too, 2026-11-23.)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractJson, parseBullBearPayload } from "../bullbear-payload.mjs";
import { BROWSER_UA } from "../../worker/cnbc.js";

const BASE = process.env.BASE || "dfc2000d6^";
const CACHE = process.env.CACHE_DIR || "/private/tmp/claude-501/-Users-nitzanmassad-Desktop-Nitzan/dfa54ae0-71e5-4ed3-b0b5-d9cf9c9f36b6/scratchpad/aianalyst-cache";
const MAX_REQ = Number(process.env.MAX_REQ || 40);
// 10 mega caps, 10 mid caps, 10 micro caps (by mc in src/data/stocks.json, all asOf 2026-11-20/21 at BASE)
const TICKERS = (process.env.TICKERS || "AAPL,MSFT,NVDA,GOOGL,AMZN,AVGO,TSM,META,LLY,WMT," +
  "SPCX,CIFR,DNLI,QBTS,RGTI,ONDS,PHVS,XELB,TRNR,KPTIQ," +
  "CRIS,SNES,IMNN,DFLI,OPTT,NXXT,ALGS,BCDA,COSM,BLRX").split(",");

const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64e6 });

mkdirSync(CACHE, { recursive: true });
let req = 0, last = 0;
async function cached(file, url) {
  try { return readFileSync(`${CACHE}/${file}`, "utf8"); } catch { /* miss */ }
  if (process.env.OFFLINE === "1") throw new Error("not cached (OFFLINE)");
  if (++req > MAX_REQ) throw new Error(`request budget ${MAX_REQ} spent`);
  await new Promise((r) => setTimeout(r, Math.max(0, last + 1600 - Date.now())));
  last = Date.now();
  const res = await fetch(url, { headers: { "user-agent": BROWSER_UA } });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync(`${CACHE}/${file}`, body);
  return body;
}

const fold = (s) => s.normalize("NFKC").replace(/[‘’ʼ′]/g, "'").replace(/[“”″]/g, '"')
  .replace(/[‐‑–—]/g, "-").replace(/\s+/g, " ").trim();
const kind = (o, n) => o.t === n.t && o.b === n.b ? "exact"
  : fold(o.t).toLowerCase() === fold(n.t).toLowerCase() && fold(o.b) === fold(n.b) ? "norm" : "changed";
const residue = (p) => /<\/?[a-z][^>]*>|&(#x?[0-9a-f]+|[a-z]+);/i.test(p.t + p.b);

const pts = { exact: 0, norm: 0, changed: 0 };
const rows = [], bad = [];
for (const t of TICKERS) {
  let old;
  try { old = JSON.parse(git("show", `${BASE}:public/bullbear/${t}.json`)); } catch { rows.push([t, "no-baseline"]); continue; }
  let nu;
  try { nu = parseBullBearPayload(extractJson(await cached(`${t}.json`, `https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-aianalyst/payload.json`)), t); }
  catch (e) { rows.push([t, `fetch-fail (${e.message})`]); bad.push(`${t}: payload unusable: ${e.message}`); continue; }

  for (const p of [...nu.bull, ...nu.bear]) if (residue(p) || !p.t || !p.b) bad.push(`${t}: dirty point "${p.t}"`);
  const k = { exact: 0, norm: 0, changed: 0 };
  for (const s of ["bull", "bear"]) old[s].forEach((p, i) => k[nu[s][i] ? kind(p, nu[s][i]) : "changed"]++);
  for (const x in k) pts[x] += k[x];
  const counts = `${old.bull.length}/${old.bear.length}->${nu.bull.length}/${nu.bear.length}`;
  const loss = [];
  if (!nu.bull.length && !nu.bear.length) loss.push("thesis missing");
  for (const s of ["bull", "bear"]) {
    if (nu[s].length < old[s].length) loss.push(`${s} ${old[s].length}->${nu[s].length}`);
    old[s].forEach((o, i) => {
      const n = nu[s][i]; if (!n) return;
      const ob = fold(o.b), nb = fold(n.b);
      if (ob !== nb && (ob.includes(nb) || nb.length < 0.6 * ob.length)) loss.push(`${s}[${i}] body truncated ${ob.length}->${nb.length}`);
    });
  }
  const cat = loss.length ? "PARSER-LOSS" : k.changed ? "updated-since-asOf" : k.norm ? "case/ws-only" : "exact";
  for (const l of loss) bad.push(`${t}: ${l}`);
  rows.push([t, cat, counts, `exact ${k.exact} norm ${k.norm} chg ${k.changed}`]);
}

for (const r of rows) console.log(`  ${r[0].padEnd(6)} ${r[1].padEnd(22)} ${r[2] || ""}  ${r[3] || ""}`);
const by = rows.reduce((m, r) => ((m[r[1].split(" ")[0]] = (m[r[1].split(" ")[0]] || 0) + 1), m), {});
console.log(`\ntickers ${rows.length}: ${JSON.stringify(by)}  | points: ${JSON.stringify(pts)}  | network requests: ${req}`);
if (bad.length) console.log("DEGRADATION:\n  " + bad.join("\n  "));
assert.equal(bad.length, 0, `${bad.length} degradation(s)`);
console.log("PASS: no parser loss vs the old HTML parser output");
