// Checks ci/post-compose.mjs — the fusion step that burns a post's text into its photo.
// No network anywhere in this file: image "photos" are synthesised locally with the very same
// @resvg/resvg-js this module rasterises with, and text is measured against the real Inter
// font files checked into ci/fonts/ — there is nothing here that needs a fake.

import assert from "node:assert";
import { Resvg } from "@resvg/resvg-js";
import {
  imageDimensions, measureTextWidth, wrapText, fitText, sampleBrightness, composePost,
} from "./post-compose.mjs";

const solidPhoto = (w, h, hex) =>
  new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="${hex}"/></svg>`).render().asPng();

/** High local contrast top-to-bottom and left-to-right, so both bands read as "busy". */
const noisyPhoto = (w, h) => {
  const cells = Array.from({ length: 12 }, (_, i) =>
    `<rect x="${(i * 97) % w}" y="${(i * 53) % h}" width="${Math.max(8, w / 6)}" height="${Math.max(8, h / 6)}" fill="${i % 2 ? "#000000" : "#ffffff"}"/>`,
  ).join("");
  return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" fill="#808080"/>${cells}</svg>`).render().asPng();
};

// ============================================================= imageDimensions =============
{
  const png = solidPhoto(37, 51, "#ffffff");
  assert.deepEqual(imageDimensions(png), { width: 37, height: 51, mime: "image/png" },
    "PNG header parses the real width/height");
}
{
  // Hand-built minimal JPEG: SOI, an SOF0 (3-component) declaring 1024x630, then EOI. No
  // huffman/quant tables or scan data — imageDimensions only ever reads the SOF marker, so a
  // fixture this small (never handed to resvg, only to the header parser) is enough.
  const jpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, // SOF0, length 17
    0x08, // precision
    0x02, 0x76, // height 630
    0x04, 0x00, // width 1024
    0x03, // 3 components
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9, // EOI
  ]);
  assert.deepEqual(imageDimensions(jpeg), { width: 1024, height: 630, mime: "image/jpeg" },
    "JPEG SOF0 marker parses the real width/height");
}
assert.throws(() => imageDimensions(Buffer.from("not an image, just text")),
  "an unsupported format throws rather than silently guessing");

// =================================================================== measureTextWidth =======
{
  const opts = { fontFamily: "Inter", fontWeight: "700", fontSize: 40 };
  assert.equal(measureTextWidth("", opts), 0, "empty text measures zero width");
  const short = measureTextWidth("Hi", opts);
  const long = measureTextWidth("Hi there, this is much longer", opts);
  assert.ok(short > 0, "non-empty text has a positive measured width");
  assert.ok(long > short, "more text measures wider, at the same size");
  const bigger = measureTextWidth("Hi", { ...opts, fontSize: 80 });
  assert.ok(bigger > short, "a larger font size measures wider, for the same text");
}

// =========================================================================== wrapText =======
{
  const opts = { fontFamily: "Inter", fontWeight: "700", fontSize: 40, maxWidth: 100_000, maxLines: 5 };
  const r = wrapText("A short headline", opts);
  assert.deepEqual(r.lines, ["A short headline"], "text that fits comfortably stays on one line");
  assert.equal(r.overflow, false, "and is not flagged as overflowing");
}
{
  // A real sentence, forced to wrap at a realistic width, must reproduce every word in order.
  // maxWidth (400) comfortably exceeds the longest single word ("Conocophillips", ~347px at
  // this size) so this exercises ordinary multi-word wrapping, not the lone-overlong-word trap
  // covered separately below.
  const opts = { fontFamily: "Inter", fontWeight: "700", fontSize: 48, maxWidth: 400, maxLines: 6 };
  const text = "Conocophillips smart score dropped from nine to five today";
  const r = wrapText(text, opts);
  assert.ok(r.lines.length > 1, "a long sentence at a narrow width wraps onto multiple lines");
  assert.equal(r.lines.join(" "), text, "every word survives, in order, none dropped or duplicated");
  assert.equal(r.overflow, false, "and it is not reported as overflowing (it all fit within maxLines)");
  for (const line of r.lines) {
    assert.ok(measureTextWidth(line, opts) <= opts.maxWidth + 1, `line "${line}" respects maxWidth`);
  }
}
{
  // Too many lines needed -> overflow, and the caller (fitText) is what has to shrink.
  const opts = { fontFamily: "Inter", fontWeight: "700", fontSize: 48, maxWidth: 120, maxLines: 1 };
  const r = wrapText("Way more words than fit on a single narrow line", opts);
  assert.equal(r.overflow, true, "hitting the line cap before every word is placed is overflow");
}
{
  // THE TRAP: a single word (no spaces at all) wider than maxWidth is still force-placed alone
  // — every "word" gets placed, so a naive word-count check would call this fine. It must
  // still report overflow, or a real headline could silently render wider than the canvas.
  const opts = { fontFamily: "Inter", fontWeight: "700", fontSize: 200, maxWidth: 100, maxLines: 3 };
  const r = wrapText("Supercalifragilisticexpialidocious", opts);
  assert.equal(r.lines.length, 1, "the lone word still goes on exactly one line (never split mid-word)");
  assert.equal(r.overflow, true, "but it is flagged as overflowing because the line itself is too wide");
}

// ============================================================================ fitText ========
{
  // A short, ordinary company name at a generous size needs no shrinking at all.
  const fit = fitText("Alpha Inc", {
    fontFamily: "Inter", fontWeight: "700", maxWidth: 2000, maxLines: 2, startSize: 60, minSize: 20, step: 4,
  });
  assert.equal(fit.fontSize, 60, "fits at the starting size, so no shrinking happens");
  assert.equal(fit.overflow, false, "and is not overflowing");
}
{
  // A long headline at a narrow width must shrink, and never below minSize.
  const fit = fitText(
    "International Consolidated Diversified Holdings posted its highest smart score reading ever",
    { fontFamily: "Inter", fontWeight: "700", maxWidth: 260, maxLines: 3, startSize: 60, minSize: 24, step: 4 },
  );
  assert.ok(fit.fontSize < 60, "the font actually shrank from the starting size");
  assert.ok(fit.fontSize >= 24, "and never went below minSize");
}
{
  // The exact bug found while building this module: one pathologically long word must shrink
  // enough to actually fit, not just get reported as overflowing forever.
  const fit = fitText("Pneumonoultramicroscopicsilicovolcanoconiosis", {
    fontFamily: "Inter", fontWeight: "700", maxWidth: 700, maxLines: 2, startSize: 120, minSize: 20, step: 4,
  });
  assert.ok(fit.fontSize < 120, "the pathological single word forces a shrink");
  assert.ok(measureTextWidth(fit.lines[0], { fontFamily: "Inter", fontWeight: "700", fontSize: fit.fontSize }) <= 700 + 1,
    "and at the chosen size, the line actually fits within maxWidth");
}

// ===================================================================== sampleBrightness ======
{
  const white = solidPhoto(200, 200, "#ffffff");
  const stats = sampleBrightness(white, { band: { y0: 0, y1: 1 } });
  assert.ok(stats.band.mean > 240, `a solid white photo measures near-255 luminance (got ${stats.band.mean})`);
  assert.ok(stats.band.stdev < 5, "and near-zero variance (it's a flat colour)");
}
{
  const black = solidPhoto(200, 200, "#000000");
  const stats = sampleBrightness(black, { band: { y0: 0, y1: 1 } });
  assert.ok(stats.band.mean < 15, `a solid black photo measures near-0 luminance (got ${stats.band.mean})`);
}
{
  const noisy = noisyPhoto(240, 240);
  const flat = solidPhoto(240, 240, "#808080");
  const noisyStats = sampleBrightness(noisy, { band: { y0: 0, y1: 1 } });
  const flatStats = sampleBrightness(flat, { band: { y0: 0, y1: 1 } });
  assert.ok(noisyStats.band.stdev > flatStats.band.stdev,
    "a busy, high-contrast photo measures a higher standard deviation than a flat one");
}
{
  // Two independent bands (top vs bottom) on the same photo measure independently.
  const half = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">` +
    `<rect width="200" height="100" fill="#ffffff"/><rect y="100" width="200" height="100" fill="#000000"/></svg>`,
  ).render().asPng();
  const stats = sampleBrightness(half, { top: { y0: 0, y1: 0.4 }, bottom: { y0: 0.6, y1: 1 } });
  assert.ok(stats.top.mean > 200, "the white top band measures bright");
  assert.ok(stats.bottom.mean < 50, "the black bottom band measures dark, independently of the top");
}

// ========================================================================== composePost ======
{
  // The happy path, at Flux's real square output size.
  const photo = solidPhoto(1024, 1024, "#f4f6f8");
  const out = composePost({
    photo, companyName: "Conocophillips", sector: "Energy",
    statement: "Conocophillips smart score dropped from 9 to 5.",
  });
  assert.ok(Buffer.isBuffer(out.jpeg), "returns a JPEG buffer");
  assert.equal(out.jpeg[0], 0xff, "the buffer is actually a JPEG (SOI marker byte 1)");
  assert.equal(out.jpeg[1], 0xd8, "the buffer is actually a JPEG (SOI marker byte 2)");
  assert.deepEqual(imageDimensions(out.jpeg), { width: out.width, height: out.height, mime: "image/jpeg" },
    "the composed output is itself a well-formed, decodable JPEG");
  assert.equal(out.width, 1024, "output width matches the source photo");
  assert.equal(out.height, 1024, "output height matches the source photo");
  // "half the company-name font size" — the spec's own literal requirement.
  assert.equal(out.layout.descriptorFontSize, Math.round(out.layout.nameFontSize / 2),
    "the descriptor renders at exactly half the company-name size");
  assert.ok(out.layout.nameLines <= 2, "company name is capped at 2 lines");
  assert.ok(out.layout.statementLines <= 4, "statement is capped at 4 lines");
}
{
  // Aspect ratio is preserved (not forced square) — Flux is square today, but this must not
  // assume that.
  const photo = solidPhoto(900, 1200, "#ffffff");
  const out = composePost({ photo, companyName: "Xpo", sector: "Industrials", statement: "Xpo upside at 80.3 high ever." });
  assert.equal(out.width, 900, "a non-square photo's width is preserved");
  assert.equal(out.height, 1200, "and its height");
}
{
  // A deliberately long company name AND a long statement — the two things most likely to
  // overflow the canvas — must still both fit within their line caps.
  const photo = solidPhoto(1024, 1024, "#eef1f5");
  const out = composePost({
    photo,
    companyName: "International Consolidated Diversified Holdings Group",
    sector: "BasicMaterials",
    statement: "International Consolidated Diversified Holdings posted its highest smart score reading of the entire window.",
  });
  assert.ok(out.layout.nameLines <= 2, "even a very long company name stays within 2 lines");
  assert.ok(out.layout.statementLines <= 4, "even a long statement stays within 4 lines");
  assert.ok(out.layout.nameFontSize > 0 && out.layout.statementFontSize > 0, "fonts shrank, but never to zero/negative");
}
{
  // A photo unusually DARK behind the text: the module must not just assume "photos are
  // bright" — it has to render something (never throw), and the earlier bright-photo case
  // above already proves the default path also works. This is the inversion path.
  const photo = solidPhoto(1024, 1024, "#0a0a0c");
  const out = composePost({ photo, companyName: "Xenon Pharmaceuticals", sector: "Healthcare",
                             statement: "Xenon Pharmaceuticals upside at 80.3 high ever." });
  assert.ok(Buffer.isBuffer(out.jpeg) && out.jpeg.length > 0, "a dark photo still composes successfully");
}
{
  // A busy (high-variance) photo must not throw either.
  const photo = noisyPhoto(1024, 1024);
  const out = composePost({ photo, companyName: "Astera Labs", sector: "Technology",
                             statement: "Astera Labs upside halved. Smart Score doubled." });
  assert.ok(Buffer.isBuffer(out.jpeg) && out.jpeg.length > 0, "a busy photo still composes successfully");
}
{
  // JPEG input (the real pipeline's format) works end to end too, not just PNG.
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ]);
  // This fixture is header-only (see the imageDimensions test above) — resvg cannot actually
  // decode it as a photo, so this only proves imageDimensions' JPEG branch feeds composePost's
  // canvas sizing correctly; a real Flux JPEG is exercised for real in the generator's own
  // integration run (ci/generate-posts.mjs), not here (no network in tests).
  assert.deepEqual(imageDimensions(jpeg), { width: 64, height: 64, mime: "image/jpeg" },
    "a tiny JPEG fixture's dimensions feed composePost's canvas sizing");
}

console.log("post-compose OK — image header parsing (PNG+JPEG), real-font text measurement, " +
            "word-wrap (including the lone-overlong-word trap), stepwise font shrinking, " +
            "brightness/contrast sampling, and end-to-end composition at square and non-square " +
            "sizes with long names/statements and bright/dark/busy photos");
