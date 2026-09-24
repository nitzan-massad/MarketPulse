// Checks ci/company-photo.mjs — strictly offline, per the ground rules: every network call goes
// through an injected `fetchImpl`, and this file never touches commons.wikimedia.org for real
// (that live exercise is `node ci/coverage-company-photo.mjs`, a separate manual tool, not part
// of `npm test`). The point of these checks is the CONTRACT: license filtering, the two
// relevance gates (token match + building-word match), size/format filtering, tier fallthrough,
// and "never throws" — not any particular live Commons result.

import assert from "node:assert";
import { classifyLicense, significantTokens, findCompanyPhoto } from "./company-photo.mjs";

// --------------------------------------------------------------- classifyLicense --

assert.equal(classifyLicense("CC0 1.0").ok, true, "CC0 is accepted");
assert.equal(classifyLicense("Public domain").ok, true, "public domain is accepted");
assert.equal(classifyLicense("PD-US").ok, true, "a PD-* short name is accepted");
assert.equal(classifyLicense("CC BY 4.0").ok, true, "CC BY is accepted");
assert.equal(classifyLicense("CC BY-SA 3.0").ok, true, "CC BY-SA is accepted");
assert.equal(classifyLicense("cc by-sa 2.0").ok, true, "license matching is case-insensitive");

assert.equal(classifyLicense("CC BY-NC 4.0").ok, false, "CC BY-NC is rejected (non-commercial)");
assert.equal(classifyLicense("CC BY-NC-SA 4.0").ok, false, "CC BY-NC-SA is rejected (non-commercial)");
assert.equal(classifyLicense("CC BY-ND 4.0").ok, false, "CC BY-ND is rejected (no-derivatives)");
assert.ok(/no-derivatives/.test(classifyLicense("CC BY-ND 4.0").reason), "the ND rejection reason names the real cause");
assert.equal(classifyLicense("All rights reserved").ok, false, "an explicit non-free license is rejected");
assert.equal(classifyLicense("").ok, false, "no license metadata at all is rejected");
assert.equal(classifyLicense(null).ok, false, "a null license is rejected without throwing");
assert.equal(classifyLicense("GFDL").ok, false, "an unrecognised license is rejected, not guessed at");

console.log("classifyLicense OK — CC0/PD/BY/BY-SA accepted, NC/ND/unknown/missing rejected");

// ------------------------------------------------------------ significantTokens --

assert.deepEqual(significantTokens("Apple Inc."), ["Apple"], "a generic corporate suffix is stripped");
assert.deepEqual(
  significantTokens("Praxis Precision Medicines, Inc."),
  ["Praxis", "Precision", "Medicines"],
  "a multi-word name keeps every non-generic word",
);
assert.deepEqual(significantTokens("Alphabet Inc. Class A"), ["Alphabet"], "a share-class suffix is stripped too");
assert.deepEqual(significantTokens(""), [], "an empty name yields no tokens");
assert.deepEqual(significantTokens("The Co. Ltd"), [], "a name that is entirely generic words yields no tokens");

console.log("significantTokens OK — corporate suffixes and share classes stripped, real words kept");

// ------------------------------------------------------------------ test fixtures --

/** One `query.pages` entry shaped like the real MediaWiki API (verified live against
 *  commons.wikimedia.org while building this module — see the module header). */
function page(id, { title, width = 2000, height = 1400, mime = "image/jpeg", license = "CC BY-SA 4.0", description = "", artist = "A Photographer" }) {
  const file = `https://upload.wikimedia.org/x/${id}.jpg`;
  return [
    String(id),
    {
      pageid: id,
      ns: 6,
      title: `File:${title}`,
      imageinfo: [
        {
          url: file,
          width,
          height,
          mime,
          descriptionurl: `https://commons.wikimedia.org/wiki/File:${title}`,
          extmetadata: {
            LicenseShortName: { value: license },
            ImageDescription: { value: description },
            Artist: { value: `<a href="//commons.wikimedia.org/wiki/User:x">${artist}</a>` },
          },
        },
      ],
    },
  ];
}

const searchBody = (pages) => (pages.length ? { query: { pages: Object.fromEntries(pages) } } : { batchcomplete: "" });

/** Builds a fetchImpl whose search results depend on the `gsrsearch` query string — `byQuery`
 *  maps a PREDICATE over the raw query string to the page list it should return (first match
 *  wins); anything unmatched is a zero-hit response, exactly like the real API's
 *  `{"batchcomplete":""}` (verified live). Any request that is NOT `action=query` (i.e. the
 *  final image download) returns fixed JPEG-shaped bytes. */
function makeFetch(byQuery, { downloadOk = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.searchParams.get("action") === "query") {
      const q = u.searchParams.get("gsrsearch") ?? "";
      for (const [match, pages] of byQuery) {
        if (match(q)) return { ok: true, json: async () => searchBody(pages) };
      }
      return { ok: true, json: async () => searchBody([]) };
    }
    // Image byte download.
    if (!downloadOk) return { ok: false, status: 404 };
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  };
  return { fetchImpl, calls };
}

const isCategory = (q) => q.startsWith("incategory:");

// ------------------------------------------------------------------- findCompanyPhoto --

// --- TIER 1: a relevant hit in the company's own category short-circuits everything else -----
{
  const { fetchImpl, calls } = makeFetch([
    [isCategory, [page(1, { title: "Apple Park.jpg", description: "Apple Park headquarters" })]],
  ]);
  const result = await findCompanyPhoto("Apple Inc.", { fetchImpl });
  assert.ok(result, "a relevant, well-licensed category hit is returned");
  assert.equal(result.license, "CC BY-SA 4.0", "the license short name is carried through");
  assert.ok(result.attribution.includes("A Photographer"), "the attribution names the stripped-HTML artist");
  assert.ok(result.attribution.includes("Wikimedia Commons"), "the attribution names the source");
  assert.ok(result.bytes.length > 0, "the image bytes are returned");
  assert.equal(calls.length, 2, "one search call plus one download call — TIER 2 never runs");
}

// --- a category hit that does NOT mention the company anywhere in its own text is rejected ----
// (the real, live-verified failure mode this module exists to catch: a file mis-filed under
// Category:Apple Inc. with no mention of Apple in its title or description).
{
  const { fetchImpl } = makeFetch([
    [isCategory, [page(1, { title: "Some Politician Event.jpg", description: "Official photo by a photographer" })]],
    [(q) => q.includes("headquarters"), [page(2, { title: "Apple Headquarters in Cupertino.jpg", description: "Apple headquarters" })]],
  ]);
  const result = await findCompanyPhoto("Apple", { fetchImpl });
  assert.ok(result, "falls through to TIER 2 once the category hit fails the token-match gate");
  assert.equal(result.title, "Apple Headquarters in Cupertino.jpg", "the TIER 2 hit is the one actually returned");
}

// --- TIER 2 tries suffixes in order and stops at the first that yields a relevant hit ---------
{
  const { fetchImpl, calls } = makeFetch([
    [isCategory, []],
    [(q) => q.includes("headquarters"), []],
    [(q) => q.includes("campus"), [page(1, { title: "Microsoft Redmond Campus.jpg", description: "Microsoft campus aerial view" })]],
  ]);
  const result = await findCompanyPhoto("Microsoft", { fetchImpl });
  assert.ok(result, "the second TIER 2 suffix (campus) succeeds after headquarters comes back empty");
  assert.equal(result.title, "Microsoft Redmond Campus.jpg");
  // category + headquarters + campus = 3 search calls, + 1 download.
  assert.equal(calls.length, 4, "stops trying suffixes the moment one succeeds");
}

// --- no relevant, well-licensed hit anywhere -> null, never throws ----------------------------
{
  const { fetchImpl } = makeFetch([]);
  const result = await findCompanyPhoto("Opus Genetics", { fetchImpl });
  assert.equal(result, null, "a company with no Commons coverage at all resolves to null");
}

// --- a real hit that fails licensing is rejected even though it is otherwise relevant ---------
{
  const { fetchImpl } = makeFetch([
    [isCategory, []],
    [(q) => q.includes("headquarters"), [page(1, {
      title: "Some Corp Headquarters.jpg", description: "Some Corp headquarters building", license: "CC BY-NC 4.0",
    })]],
  ]);
  const result = await findCompanyPhoto("Some Corp", { fetchImpl });
  assert.equal(result, null, "a non-commercial license is rejected even for an otherwise-perfect match");
}

// --- SVG and tiny images are rejected regardless of relevance/license -------------------------
{
  const { fetchImpl: svgFetch } = makeFetch([
    [isCategory, []],
    [(q) => q.includes("logo"), [page(1, { title: "Some Corp logo.svg", description: "Some Corp logo", mime: "image/svg+xml" })]],
  ]);
  assert.equal(await findCompanyPhoto("Some Corp", { fetchImpl: svgFetch }), null, "an SVG is rejected — vector logos are explicitly out of scope");

  const { fetchImpl: tinyFetch } = makeFetch([
    [isCategory, []],
    [(q) => q.includes("headquarters"), [page(1, { title: "Some Corp HQ.jpg", description: "Some Corp headquarters", width: 100, height: 80 })]],
  ]);
  assert.equal(await findCompanyPhoto("Some Corp", { fetchImpl: tinyFetch }), null, "a thumbnail-sized image is rejected");
}

// --- a bare company-name match with no building-word context is rejected at the last tier -----
// (the "Apple" == the fruit trap — a relevant-looking company-name hit that says nothing about
// what kind of place or thing it actually depicts must not win the bare-name fallback tier).
{
  const { fetchImpl } = makeFetch([
    [isCategory, []],
    [(q) => q === "Apple headquarters", []],
    [(q) => q === "Apple campus", []],
    [(q) => q === "Apple office", []],
    [(q) => q === "Apple building", []],
    [(q) => q === "Apple logo", []],
    [(q) => q === "Apple", [page(1, { title: "A red apple on a table.jpg", description: "A studio photo of a red apple" })]],
  ]);
  const result = await findCompanyPhoto("Apple", { fetchImpl });
  assert.equal(result, null, "a bare-name hit with no building/office/campus word in its own text is rejected");
}

// --- a company name that reduces to zero significant tokens never even calls the network -------
{
  const { fetchImpl, calls } = makeFetch([]);
  const result = await findCompanyPhoto("The Co. Ltd", { fetchImpl });
  assert.equal(result, null, "an unmatchable name resolves to null");
  assert.equal(calls.length, 0, "no network call is made when there is no distinctive token to search for");
}

// --- a thrown/failed network call never propagates — always null, never an exception ----------
{
  const throwingFetch = async () => {
    throw new Error("simulated DNS failure");
  };
  await assert.doesNotReject(
    async () => {
      const result = await findCompanyPhoto("Apple", { fetchImpl: throwingFetch });
      assert.equal(result, null, "a fetch that throws still resolves to null");
    },
    "a total network failure never throws out of findCompanyPhoto",
  );
}

// --- a candidate that passes search but fails to download still resolves to null (not a throw) -
{
  const { fetchImpl } = makeFetch(
    [[isCategory, [page(1, { title: "Apple Park.jpg", description: "Apple Park headquarters" })]]],
    { downloadOk: false },
  );
  const result = await findCompanyPhoto("Apple", { fetchImpl });
  assert.equal(result, null, "a failed image download degrades to null, same as no hit at all");
}

// --- multi-word names require at least two significant-word matches, not just one -------------
{
  const { fetchImpl } = makeFetch([
    [isCategory, []],
    // Only "Precision" appears — a word plenty of unrelated files could use — Medicines/Praxis
    // do not. This must NOT be enough to match a two-of-three-word requirement.
    [(q) => q.includes("headquarters"), [page(1, { title: "Precision Tools Inc headquarters.jpg", description: "Precision Tools Inc headquarters" })]],
  ]);
  const result = await findCompanyPhoto("Praxis Precision Medicines", { fetchImpl });
  assert.equal(result, null, "one matching word out of three is not enough for a multi-word company name");
}

console.log("findCompanyPhoto OK — licensing, token-match + building-word relevance gates, tier fallthrough, never throws");
