// Build public/reviews-recent.json — the newest analyst review per ticker whose date is
// within RECENT_DAYS — by reading the already-scraped public/forecasts/<T>.json files.
// New Arrivals loads this one small file instead of fetching hundreds of forecast files.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "public/forecasts";
const OUT = "public/reviews-recent.json";
const RECENT_DAYS = Number(process.env.RECENT_DAYS || 7);
const cutoff = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString().slice(0, 10); // "YYYY-MM-DD"

const items = [];
for (const file of readdirSync(DIR)) {
  if (!file.endsWith(".json")) continue;
  const t = file.slice(0, -5);
  let arr;
  try {
    arr = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
  } catch {
    continue;
  }
  if (!Array.isArray(arr) || !arr.length) continue;
  const r0 = arr[0]; // forecasts are stored newest-first
  if (!r0 || !r0.d || r0.d < cutoff) continue; // string compare is valid for YYYY-MM-DD
  // fields match reviewAlerts.reviewKey (n|f|d|r|pt) so the modal can highlight this exact row
  items.push({ t, n: r0.n ?? null, f: r0.f ?? null, r: r0.r ?? null, pt: r0.pt ?? null, opt: r0.opt ?? null, d: r0.d });
}
items.sort((a, b) => (b.d || "").localeCompare(a.d || ""));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), days: RECENT_DAYS, items }));
console.log(`reviews-recent: ${items.length} ticker(s) with a review since ${cutoff}`);
