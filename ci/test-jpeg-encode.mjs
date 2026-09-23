// Checks ci/jpeg-encode.mjs — the hand-rolled baseline JPEG encoder ci/post-compose.mjs uses
// to shrink composed post cards from ~900KB PNGs to a "couple hundred KB" JPEG. No network,
// no fixtures from disk: every "photo" here is rendered locally via the same @resvg/resvg-js
// this repo already depends on.
//
// What this file CANNOT do: fully verify pixel-for-pixel fidelity, since there is no JPEG
// *decoder* anywhere in this repo (that would be the second dependency the task explicitly
// ruled out). What it verifies instead: the byte structure is a real, well-formed JPEG (right
// markers, dimensions round-trip through ci/post-compose.mjs's OWN independent JPEG header
// parser), encoding is deterministic, and quality/size behave the way a JPEG encoder should.
// The actual decode was checked once by hand, outside this repo, against a real decoder
// (macOS's `sips`) — see ci/jpeg-encode.mjs's header comment.

import assert from "node:assert";
import { Resvg } from "@resvg/resvg-js";
import { encodeJpeg } from "./jpeg-encode.mjs";
import { imageDimensions } from "./post-compose.mjs";

const render = (svg) => new Resvg(svg, { font: { loadSystemFonts: false } }).render();

/** A photographic-ish test image: a smooth gradient plus a few shapes, not a flat fill — a
 *  flat colour compresses to almost nothing under ANY codec and would prove nothing about
 *  whether the DCT/quantisation/Huffman path actually works. */
function photoLike(w, h) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#ffdd55"/><stop offset="0.5" stop-color="#ff5599"/>` +
    `<stop offset="1" stop-color="#5566ff"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<circle cx="${w * 0.3}" cy="${h * 0.35}" r="${Math.min(w, h) * 0.2}" fill="#20cc80"/>` +
    `<circle cx="${w * 0.7}" cy="${h * 0.55}" r="${Math.min(w, h) * 0.15}" fill="#ffffff" opacity="0.7"/>` +
    `</svg>`;
  return render(svg);
}

// ============================================================================ basic structure
{
  const { pixels, width, height } = photoLike(256, 256);
  const jpeg = encodeJpeg({ rgba: pixels, width, height, quality: 82 });
  assert.ok(Buffer.isBuffer(jpeg), "returns a Buffer");
  assert.equal(jpeg[0], 0xff, "starts with a marker byte");
  assert.equal(jpeg[1], 0xd8, "starts with SOI (FFD8)");
  assert.equal(jpeg[jpeg.length - 2], 0xff, "ends with a marker byte");
  assert.equal(jpeg[jpeg.length - 1], 0xd9, "ends with EOI (FFD9)");
}

// ================================================================== dimensions round-trip ====
// ci/post-compose.mjs's OWN header parser (imageDimensions) is the independent check here: it
// was written and tested against real Flux JPEGs before this encoder existed, so a mismatch
// between what this encoder claims in SOF0 and what that parser reads back would be a real bug,
// not a self-fulfilling one.
{
  for (const [w, h] of [[256, 256], [512, 384], [1024, 1024], [37, 51], [900, 1200], [1, 1]]) {
    const { pixels, width, height } = photoLike(w, h);
    const jpeg = encodeJpeg({ rgba: pixels, width, height, quality: 80 });
    const dims = imageDimensions(jpeg);
    assert.deepEqual(dims, { width: w, height: h, mime: "image/jpeg" },
      `SOF0 reports the true ${w}x${h}, not the internal 8x8-padded size`);
  }
}

// ============================================================ non-multiple-of-8 dimensions ===
// Flux's own output is square (1024x1024, already a multiple of 8), but ci/post-compose.mjs
// preserves whatever aspect ratio the source photo has — this must not assume block-aligned
// input. 37x51 and 900x1200 above already cover this; this block also checks the file still
// decodes as a sane size (not zero, not absurdly larger than a same-size aligned image).
{
  const aligned = photoLike(256, 256);
  const unaligned = photoLike(251, 253); // neither dimension is a multiple of 8
  const jAligned = encodeJpeg({ rgba: aligned.pixels, width: 256, height: 256, quality: 82 });
  const jUnaligned = encodeJpeg({ rgba: unaligned.pixels, width: 251, height: 253, quality: 82 });
  assert.ok(jUnaligned.length > 0, "an unaligned size still encodes");
  assert.ok(jUnaligned.length < jAligned.length * 2,
    "padding to the next block boundary doesn't blow up the file size");
}

// ============================================================================== compression ==
// The whole point (task G): a photo-sized PNG at ~80-150KB (this test's fixture, not the real
// ~900KB 1024x1024 Flux card) should come down by several times over at a sane quality.
{
  const rendered = photoLike(1024, 1024);
  const { pixels, width, height } = rendered;
  const pngBytes = rendered.asPng();
  const jpeg = encodeJpeg({ rgba: pixels, width, height, quality: 82 });
  assert.ok(jpeg.length < pngBytes.length / 3,
    `a quality-82 JPEG is well under a third of the equivalent PNG's size ` +
    `(png ${pngBytes.length}B, jpeg ${jpeg.length}B)`);
}

// =========================================================================== quality knob ====
{
  const { pixels, width, height } = photoLike(400, 400);
  const low = encodeJpeg({ rgba: pixels, width, height, quality: 40 });
  const mid = encodeJpeg({ rgba: pixels, width, height, quality: 80 });
  const high = encodeJpeg({ rgba: pixels, width, height, quality: 95 });
  assert.ok(low.length < mid.length, "lower quality encodes smaller");
  assert.ok(mid.length < high.length, "higher quality encodes larger");
  // Quality is clamped, not thrown on, for an out-of-range caller.
  const clampedLow = encodeJpeg({ rgba: pixels, width, height, quality: -5 });
  const clampedHigh = encodeJpeg({ rgba: pixels, width, height, quality: 500 });
  assert.ok(clampedLow.length > 0 && clampedHigh.length > 0, "out-of-range quality is clamped, not fatal");
}

// ============================================================================ determinism ====
{
  const { pixels, width, height } = photoLike(128, 128);
  const a = encodeJpeg({ rgba: pixels, width, height, quality: 82 });
  const b = encodeJpeg({ rgba: pixels, width, height, quality: 82 });
  assert.ok(a.equals(b), "the same pixels at the same quality encode to identical bytes");
}

// ======================================================================== alpha is ignored ===
// A composed card is fully opaque, but the encoder must not choke on (or leak) an alpha byte
// that isn't 255 — resvg's raw pixel buffer is always RGBA regardless.
{
  const w = 16, h = 16;
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 7) % 256;
    rgba[i * 4 + 1] = (i * 13) % 256;
    rgba[i * 4 + 2] = (i * 29) % 256;
    rgba[i * 4 + 3] = 0; // fully "transparent" alpha, which must simply be ignored
  }
  const jpeg = encodeJpeg({ rgba, width: w, height: h, quality: 82 });
  assert.deepEqual(imageDimensions(jpeg), { width: w, height: h, mime: "image/jpeg" },
    "an arbitrary alpha channel doesn't break encoding or the reported dimensions");
}

// =============================================================================== bad input ===
{
  assert.throws(() => encodeJpeg({ rgba: Buffer.alloc(4), width: 0, height: 1 }),
    "zero width is rejected rather than producing a bogus file");
  assert.throws(() => encodeJpeg({ rgba: Buffer.alloc(4), width: 1, height: 0 }),
    "zero height is rejected rather than producing a bogus file");
}

console.log("jpeg-encode OK — well-formed SOI/EOI, SOF0 dimensions round-trip through post-compose's " +
            "own parser at aligned and unaligned sizes, several-times compression vs PNG, a monotonic " +
            "quality knob, determinism, alpha ignored safely, and zero-size input rejected");
