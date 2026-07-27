// Refresh src/data/sectors.json — average trailing + forward P/E per sector, from
// Finviz's sector groups table. One unauthenticated GET per run (~60KB), no key.
// Finviz's sector names normalize onto the app's own vocab via keep.mjs's sectorName(),
// so no mapping table is needed. TipRanks' "General" catch-all has no Finviz counterpart
// and simply gets no entry — the UI renders "—".
// ponytail: HTML scrape, not an API — columns are located via the header row rather than
// fixed offsets, and a run that returns too few sectors is discarded rather than written.
// Swap to FMP's stable/sector-pe-snapshot if that key ever turns out to cover it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { sectorName } from "./keep.mjs";

const URL = "https://finviz.com/groups.ashx?g=sector&v=110&o=name";
const FS_URL = process.env.FLARESOLVERR_URL; // optional: route via FlareSolverr in CI
const OUT = "src/data/sectors.json";
const MIN_SECTORS = 8; // a good run returns 11; fewer means the page changed or got truncated

async function get(url) {
  if (!FS_URL) return fetch(url).then((r) => r.text());
  const r = await fetch(FS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
  });
  const j = await r.json();
  if (j.status !== "ok" || !j.solution) throw new Error(j.message || "flaresolverr status != ok");
  return j.solution.response || "";
}

// tags -> \x01 so cell text survives as discrete tokens regardless of table markup
const cellsOf = (html) =>
  html.replace(/<[^>]+>/g, "\x01").replace(/&amp;/g, "&")
    .split("\x01").map((s) => s.trim()).filter(Boolean);

const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parseSectors(html) {
  const cells = cellsOf(html);

  // Locate the columns off the header row instead of hardcoding offsets, so a Finviz
  // column reshuffle shifts the reads with it rather than silently mis-reading.
  // Anchor on the "No." + "Name" + "Stocks" run — the page's filter dropdowns also
  // contain lone "Name" / "P/E" options that a bare indexOf() would hit first.
  const hdr = cells.findIndex(
    (c, i) => c === "No." && cells[i + 1] === "Name" && cells[i + 2] === "Stocks",
  );
  if (hdr < 0) throw new Error("header row not found — Finviz layout changed");
  const nameIdx = hdr + 1;
  const colOff = (label) => {
    const j = cells.indexOf(label, hdr);
    if (j < 0 || j - hdr > 12) throw new Error(`column "${label}" not found — Finviz layout changed`);
    return j - nameIdx;
  };
  const peOff = colOff("P/E");
  const fwdOff = colOff("Fwd P/E");

  const sectors = {};
  for (let i = hdr; i < cells.length; i++) {
    // a data row is <sector name><stock count>; the count guard also rejects the
    // filter dropdowns, whose sector <option>s aren't followed by a number
    if (!/^\d+$/.test(cells[i + 1] || "") || Number(cells[i + 1]) < 20) continue;
    const sec = sectorName(cells[i]);
    if (!sec || sectors[sec]) continue;
    const pe = num(cells[i + peOff]);
    const fpe = num(cells[i + fwdOff]);
    if (pe == null && fpe == null) continue;
    sectors[sec] = { pe, fpe };
  }
  return sectors;
}

// ponytail: self-check — `CHECK=1 node ci/scrape-sectors.mjs`. Guards the parse, which
// is the only fragile part (HTML, not an API). No test framework, same as ci/keep.mjs.
if (process.env.CHECK === "1") {
  const { strict: assert } = await import("node:assert");
  const row = (no, name, stocks, mcap, div, pe, fwd, peg) =>
    `<tr><td>${no}</td><td><a>${name}</a></td><td>${stocks}</td><td>${mcap}</td>` +
    `<td>${div}</td><td>${pe}</td><td>${fwd}</td><td>${peg}</td></tr>`;
  const page =
    // decoys: the filter dropdowns carry bare "Name" / "P/E" / sector options
    `<select><option>Name</option><option>P/E</option><option>Fwd P/E</option>` +
    `<option>Industry (Basic Materials)</option><option>Technology</option></select>` +
    `<table><tr><td>No.</td><td>Name</td><td>Stocks</td><td>Market Cap</td>` +
    `<td>Dividend</td><td>P/E</td><td>Fwd P/E</td><td>PEG</td></tr>` +
    row(1, "Basic Materials", 284, "2732.35B", "2.05%", "21.09", "13.62", "1.30") +
    row(2, "Consumer Cyclical", 534, "8730.40B", "0.83%", "28.16", "19.90", "1.49") +
    row(3, "Real Estate", 253, "1830.45B", "3.70%", "32.35", "30.11", "2.92") +
    row(4, "Utilities", 109, "1987.37B", "2.84%", "20.76", "-", "1.75") +
    `</table>`;

  const s = parseSectors(page);
  assert.deepEqual(s.BasicMaterials, { pe: 21.09, fpe: 13.62 }, "reads P/E + Fwd P/E off the header offsets");
  assert.deepEqual(s.ConsumerCyclical, { pe: 28.16, fpe: 19.9 }, "multi-word sector normalizes to the app's vocab");
  assert.deepEqual(s.RealEstate, { pe: 32.35, fpe: 30.11 }, "'Real Estate' -> 'RealEstate'");
  assert.deepEqual(s.Utilities, { pe: 20.76, fpe: null }, "'-' becomes null, not NaN");
  assert.equal(Object.keys(s).length, 4, "dropdown decoys are not parsed as rows");

  // a reshuffled table must follow the header, not fixed offsets
  const swapped = page.replace("<td>P/E</td><td>Fwd P/E</td>", "<td>Fwd P/E</td><td>P/E</td>");
  assert.deepEqual(parseSectors(swapped).BasicMaterials, { pe: 13.62, fpe: 21.09 }, "columns tracked by header");

  assert.throws(() => parseSectors("<table><tr><td>nope</td></tr></table>"), /header row not found/, "loud on layout change");

  console.log("scrape-sectors self-check OK");
} else {
  const sectors = parseSectors(await get(URL));
  const found = Object.keys(sectors).length;
  if (found < MIN_SECTORS) throw new Error(`only ${found} sectors parsed (need ${MIN_SECTORS}) — not writing`);

  // Merge over the previous file so one flaky run can't drop a sector that was there.
  // (Observed: a fetch occasionally comes back missing the first data row.)
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).sectors || {} : {};
  const merged = { ...prev, ...sectors };

  writeFileSync(OUT, JSON.stringify({ asOf: new Date().toISOString().slice(0, 10), sectors: merged }, null, 1) + "\n");
  console.log(`sectors.json: ${found} parsed, ${Object.keys(merged).length} total`);
}
