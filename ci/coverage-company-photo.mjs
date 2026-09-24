// MANUAL COVERAGE TOOL — NOT part of `npm test` (ci/run-tests.mjs only discovers
// `ci/test-*.mjs`, and this file is deliberately named outside that pattern) and the ONLY
// script in this repo that is EXPECTED to touch the real network on every run: it calls the
// real commons.wikimedia.org API for a handful of named companies and reports, per company,
// exactly what ci/company-photo.mjs found (or didn't) — this is the coverage EVIDENCE for that
// module, not a regression check (ci/test-company-photo.mjs is the offline one, with every
// fetch faked).
//
// Run it directly:
//   node ci/coverage-company-photo.mjs
//   node ci/coverage-company-photo.mjs "Some Other Company" "Another One"   # custom list
//
// EXPECTATION, stated up front rather than left implicit: large, well-known companies with a
// real physical headquarters/campus should hit; small or narrowly-covered companies (a small
// biotech, for instance) are EXPECTED to miss, because Commons simply has no photo of them at
// all — that is the correct, honest outcome ci/company-photo.mjs's relevance/licence gates are
// built to produce, not a bug to chase away. See ci/company-photo.mjs's own header for exactly
// what those gates check and why.

import { findCompanyPhoto } from "./company-photo.mjs";

const DEFAULT_COMPANIES = ["Alphabet", "Microsoft", "Apple", "Praxis Precision Medicines", "Opus Genetics"];

function formatBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  const companies = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_COMPANIES;
  console.log(`ci/company-photo.mjs coverage — ${companies.length} compan(ies), live commons.wikimedia.org calls\n`);

  const rows = [];
  for (const name of companies) {
    const t0 = Date.now();
    let photo = null;
    try {
      photo = await findCompanyPhoto(name);
    } catch (err) {
      // findCompanyPhoto itself never throws (see its own header) — this is a last-ditch guard
      // so ONE company's unexpected failure never kills the whole coverage run.
      console.error(`  ${name}: coverage script caught an unexpected throw — ${err?.message ?? err}`);
    }
    const ms = Date.now() - t0;
    rows.push({ name, photo, ms });
  }

  console.log("\n" + "=".repeat(100));
  console.log(
    `${"COMPANY".padEnd(28)} ${"FOUND".padEnd(6)} ${"LICENSE".padEnd(14)} ${"DIMENSIONS".padEnd(12)} ${"SIZE".padEnd(8)} ATTRIBUTION`,
  );
  console.log("=".repeat(100));
  for (const { name, photo, ms } of rows) {
    if (!photo) {
      console.log(`${name.padEnd(28)} ${"NO".padEnd(6)} ${"-".padEnd(14)} ${"-".padEnd(12)} ${"-".padEnd(8)} (no relevant, commercially-licensed Commons hit — ${ms}ms)`);
      continue;
    }
    const dims = `${photo.width}x${photo.height}`;
    console.log(
      `${name.padEnd(28)} ${"YES".padEnd(6)} ${photo.license.padEnd(14)} ${dims.padEnd(12)} ` +
      `${formatBytes(photo.bytes.length).padEnd(8)} ${photo.attribution} (${ms}ms)`,
    );
  }
  console.log("=".repeat(100));

  const hits = rows.filter((r) => r.photo).length;
  console.log(`\n${hits}/${rows.length} compan(ies) matched a usable, commercially-licensed Commons photo.`);
}

await main();
