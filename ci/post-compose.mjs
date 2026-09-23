// THE FUSION — burns the post's text into the Flux photo's pixels, as one PNG.
//
// This is the whole point of generating a real photo at all: a post shipped as a photo NEXT
// TO some HTML text only looks right inside this app. Shared to X or Instagram, the photo
// travels alone — so the words have to be part of the file, not part of the page. This module
// is the third of three deliberately separate steps (text -> ci/provider.mjs, photo ->
// ci/post-image.mjs, fusion -> here), called directly (not injected) from
// ci/generate-posts.mjs because, unlike those two, it touches no network and needs no fake to
// stay testable offline — it is pure, deterministic Node + a native rasteriser.
//
// APPROACH: build an SVG containing the photo as a base64 `<image>` plus `<text>` elements,
// then rasterise with @resvg/resvg-js (Rust, via a native binary — no system font engine
// needed) to PNG.
//
// FONTS ARE THE TRAP HERE. resvg needs real font data, and `loadSystemFonts` is explicitly
// left OFF — a GitHub Actions `ubuntu-latest` runner's system fonts are whatever that image
// happens to ship this month, which is nondeterministic and near-certainly different from a
// dev machine's. Two Inter weights are checked into ci/fonts/ instead (Bold for the two big
// headline blocks, Medium for the small descriptor) and loaded EXPLICITLY via `fontFiles`, so
// the exact same glyphs render everywhere this ever runs. Both are subset to the Latin range
// this app's data actually produces (ci/fonts/README below the exports) to keep them small —
// 72KB each, not the ~410KB the unsubset static weights ship at.
//
// SVG <text> DOES NOT WRAP. `wrapText`/`fitText` below do it by hand: greedy word-wrap, using
// resvg ITSELF to measure each candidate line's real rendered width (not a hand-tuned
// per-character advance-width guess — the exact font is already loaded, so asking it directly
// is both more accurate and no more code). A line that still doesn't fit within the line cap
// shrinks the font size step-wise and re-wraps, until it fits or hits a floor.
//
// NO PLATES. This used to sit each text block on a semi-transparent white/black rectangle —
// legible, but it reads as a caption box pasted onto a photo, not text on the photo. Legibility
// now comes from the type itself: a `stroke` halo with `paint-order="stroke fill"` (a clean
// outline resvg renders correctly, unlike a CSS text-shadow/blur filter, which it does not
// support), sized and coloured by `haloStyle` below from the same per-band brightness sample
// the old plate logic used. Never reintroduce a plate as the fix for a legibility complaint —
// see haloStyle's own comment for the busy-photo case a stroke alone has to cover.
//
// OUTPUT IS JPEG, NOT PNG. resvg only rasterises to PNG or raw RGBA pixels (see
// @resvg/resvg-js's RenderedImage) — there is no JPEG encoder in it, and this repo carries no
// other image library, so ci/jpeg-encode.mjs is a from-scratch baseline JPEG encoder over the
// raw pixels. A composed card was a ~900KB PNG at Flux's 1024x1024 output (mostly photographic
// detail PNG's lossless deflate cannot touch); JPEG's DCT+quantisation is built for exactly
// that content. See ci/jpeg-encode.mjs for why writing one was preferred over a new dependency.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { descriptorFor } from "./post-image.mjs";
import { encodeJpeg } from "./jpeg-encode.mjs";

/** IJG-style 1-100 quality for the final JPEG (see ci/jpeg-encode.mjs). High enough that DCT
 *  blockiness never shows at feed-card size, low enough to land Flux's 1024x1024 output in the
 *  tens of KB rather than the hundreds — see ci/generate-posts.mjs's real-run report for the
 *  measured before/after. */
const JPEG_QUALITY = 82;

const CI_DIR = fileURLToPath(new URL(".", import.meta.url));
const FONT_BOLD = path.join(CI_DIR, "fonts", "Inter-Bold.ttf");
const FONT_MEDIUM = path.join(CI_DIR, "fonts", "Inter-Medium.ttf");
const FONT_FILES = [FONT_BOLD, FONT_MEDIUM];

/** Must match the `name` table `family` records baked into ci/fonts/*.ttf exactly — resvg
 *  matches loaded faces by family name, not by file path. (`Inter-Bold.ttf`'s family is
 *  "Inter"; `Inter-Medium.ttf`'s is "Inter Medium" — a static Medium instance carries its
 *  weight in the family name, not the subfamily, which is "Regular".) */
const FONT_FAMILY_BOLD = "Inter";
const FONT_FAMILY_MEDIUM = "Inter Medium";

const escapeXml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// ---------------------------------------------------------- image dimensions --
//
// resvg needs the photo's pixel size to lay the canvas out at 1:1 (no stretching), and Node
// has no built-in decoder for either format. Rather than add a dependency for this one fact,
// both header formats are trivial to read directly: PNG's IHDR chunk is fixed-offset, and a
// JPEG's SOF marker is a short linear scan. This never decodes pixel data, only headers.

function pngDimensions(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: "image/png" };
}

function jpegDimensions(buf) {
  let offset = 2; // past the SOI marker (FF D8)
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // Markers with no length-prefixed payload: standalone markers and RST0-7.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI — no SOF found
    const length = buf.readUInt16BE(offset + 2);
    // SOF0-SOF15 except the DHT/JPG/DAC markers (0xC4, 0xC8, 0xCC) carry the frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5), mime: "image/jpeg" };
    }
    offset += 2 + length;
  }
  throw new Error("jpegDimensions: no SOF marker found");
}

/** PNG or JPEG header only — never decodes pixels. Throws on anything else, which
 *  `composePost` lets propagate (ci/generate-posts.mjs treats a compose failure exactly like
 *  a failed Flux call: no `image` field, canvas fallback, the post still ships). */
export function imageDimensions(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return pngDimensions(buf);
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    return jpegDimensions(buf);
  }
  throw new Error("imageDimensions: unsupported image format (expected PNG or JPEG)");
}

// --------------------------------------------------------------- text fitting --

/** Real rendered width of `text` at this exact size/family/weight, in the exact fonts
 *  ci/fonts/ ships — asking resvg directly, rather than estimating per-character advance from
 *  a table, since the font is already loaded for the real render anyway. */
export function measureTextWidth(text, { fontFamily, fontWeight = "400", fontSize }) {
  const s = String(text ?? "");
  if (!s) return 0;
  const h = Math.ceil(fontSize * 2.2);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="${h}">` +
    `<text x="0" y="${Math.ceil(fontSize * 1.6)}" font-family="${escapeXml(fontFamily)}" ` +
    `font-weight="${fontWeight}" font-size="${fontSize}">${escapeXml(s)}</text></svg>`;
  const resvg = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: FONT_FILES } });
  const bbox = resvg.getBBox();
  return bbox ? bbox.width : 0;
}

/**
 * Greedy word-wrap at a fixed font size, measuring every candidate line for real. A single
 * word wider than `maxWidth` on its own is still placed alone on a line (never split mid-word)
 * — `fitText` below is what actually resolves that, by shrinking the size and re-wrapping.
 *
 * @returns {{ lines: string[], overflow: boolean }} `overflow` is true when `maxLines` was hit
 *   before every word could be placed, OR when any single line — necessarily a lone word forced
 *   onto it — is still wider than `maxWidth` at this size. That second case is the trap: with
 *   only ONE word in the whole text, every word still gets "placed" (on its own line), so a
 *   check that only compared word counts would report `overflow: false` for a headline visibly
 *   running off both edges of the canvas — exactly the bug this function exists to catch.
 */
export function wrapText(text, opts) {
  const { maxWidth, maxLines = Infinity } = opts;
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let tooWide = false;
  const pushLine = (s) => {
    lines.push(s);
    if (measureTextWidth(s, opts) > maxWidth) tooWide = true;
  };

  let current = "";
  let i = 0;
  while (i < words.length) {
    const candidate = current ? `${current} ${words[i]}` : words[i];
    if (!current || measureTextWidth(candidate, opts) <= maxWidth) {
      current = candidate;
      i++;
      continue;
    }
    pushLine(current);
    current = "";
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) pushLine(current);

  const placedWords = lines.join(" ").split(/\s+/).filter(Boolean).length;
  return { lines, overflow: tooWide || placedWords < words.length };
}

/**
 * `wrapText`, but shrinking the font size step-wise (from `startSize` down to `minSize`) until
 * the text fits within `maxLines` at `maxWidth`, or the floor is reached — a headline running
 * off the canvas is the single most likely visible bug in this module, so this is the guard
 * against it. `minSize` is a floor, not a promise: at the floor, whatever `wrapText` returns
 * ships (still capped at `maxLines`), because a smaller-than-intended headline beats no post.
 */
export function fitText(text, { fontFamily, fontWeight, maxWidth, maxLines, startSize, minSize, step = 2 }) {
  let size = startSize;
  let result = wrapText(text, { fontFamily, fontWeight, fontSize: size, maxWidth, maxLines });
  while (result.overflow && size - step >= minSize) {
    size -= step;
    result = wrapText(text, { fontFamily, fontWeight, fontSize: size, maxWidth, maxLines });
  }
  return { lines: result.lines, fontSize: size, overflow: result.overflow };
}

// ------------------------------------------------------------- contrast check --
//
// "The photos are high-key/light, so dark text is the right default — but verify contrast
// rather than assuming." Rendering the photo alone at a small analysis size and averaging
// luminance over the band each text block will actually sit in is cheap (a 64px-wide render)
// and answers the real question instead of assuming every photo came out bright: an unusually
// dark or high-contrast ("busy") region gets light text and/or a stronger plate instead.

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * @param bands `{ [name]: { y0, y1 } }`, each a FRACTION (0-1) of the photo's height.
 * @returns `{ [name]: { mean, stdev } }`, luminance 0-255.
 */
export function sampleBrightness(photo, bands) {
  const { width, height, mime } = imageDimensions(photo);
  const aw = 64;
  const ah = Math.max(1, Math.round((aw * height) / width));
  const b64 = photo.toString("base64");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${aw}" height="${ah}">` +
    `<image x="0" y="0" width="${aw}" height="${ah}" preserveAspectRatio="none" ` +
    `href="data:${mime};base64,${b64}"/></svg>`;
  const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
  const rendered = resvg.render();
  const px = rendered.pixels;
  const w = rendered.width, h = rendered.height;

  const out = {};
  for (const [name, frac] of Object.entries(bands)) {
    const y0 = Math.max(0, Math.floor(frac.y0 * h));
    const y1 = Math.min(h, Math.ceil(frac.y1 * h));
    let sum = 0, sumSq = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const l = luminance(px[i], px[i + 1], px[i + 2]);
        sum += l; sumSq += l * l; n++;
      }
    }
    const mean = n ? sum / n : 128;
    const variance = n ? Math.max(0, sumSq / n - mean * mean) : 0;
    out[name] = { mean, stdev: Math.sqrt(variance) };
  }
  return out;
}

/** No plate any more (see the module header) — legibility comes entirely from a stroke halo
 *  painted behind the glyph fill (`paint-order="stroke fill"`). Dark ink with a LIGHT halo is
 *  the default, since the photos are high-key by construction (see ci/post-image.mjs); a band
 *  that samples dark inverts to light ink with a dark halo instead — a light halo would all but
 *  disappear against a dark photo, and dark ink on it would be unreadable. A busy (high-variance)
 *  band gets a thicker halo AND a touch of opacity on the halo itself (never on the letter fill),
 *  the stroke-only equivalent of the old plate's "stronger backing either way" rule: there is no
 *  plate left to lean on when the background itself has strong local contrast, so the halo has
 *  to do more work. `haloWidth` is a FRACTION of font size, applied by the caller. */
function haloStyle({ mean, stdev }) {
  const bright = mean >= 150;
  const busy = stdev >= 55;
  return {
    textFill: bright ? "#10151f" : "#f7f9fc",
    haloColor: bright ? "#ffffff" : "#0b0f16",
    haloWidth: busy ? 0.16 : 0.1,
    haloOpacity: busy ? 0.95 : 0.85,
  };
}

// ------------------------------------------------------------------- compose --

/** A `<text>` block with a stroke halo behind the fill (`paint-order="stroke fill"` — resvg
 *  renders this correctly, which is why the spec calls it out explicitly as the legibility
 *  mechanism to use instead of a plate). `stroke-linejoin="round"` keeps the halo an even ring
 *  around each glyph instead of spiky mitred corners at sharp letterforms (a "V", a "7"). */
const textLines = (lines, { x, firstBaseline, lineHeight, fontFamily, fontWeight, fontSize, fill, halo }) =>
  lines
    .map((line, i) => {
      const y = firstBaseline + i * lineHeight;
      const strokeWidth = (fontSize * halo.haloWidth).toFixed(2);
      return (
        `<text x="${x}" y="${y.toFixed(1)}" text-anchor="middle" font-family="${escapeXml(fontFamily)}" ` +
        `font-weight="${fontWeight}" font-size="${fontSize}" fill="${fill}" stroke="${halo.haloColor}" ` +
        `stroke-width="${strokeWidth}" stroke-opacity="${halo.haloOpacity}" stroke-linejoin="round" ` +
        `paint-order="stroke fill">${escapeXml(line)}</text>`
      );
    })
    .join("");

/**
 * Fuse one photo + the post's text into a single JPEG — no plate, text sits directly on the
 * photo with a stroke halo for legibility (see the module header).
 *
 * Layout, top to bottom (inverts the old browser-overlay layout, which put the hook at the
 * top): the COMPANY NAME large at the top, a two-to-four-word SECTOR DESCRIPTOR directly
 * beneath it at half the company-name size, and the STATEMENT (the post's own text) large at
 * the bottom.
 *
 * @param photo Buffer — the raw Flux JPEG (or any PNG/JPEG).
 * @param companyName the DISPLAY name — ci/hooks.mjs's `displayCompanyName(hook.name)`, with
 *   legal-entity/share-class cruft ("Inc.", "Class A", …) already stripped by the caller
 *   (ci/generate-posts.mjs). This module has no opinion on that, same as `statement` below —
 *   it just renders whatever string it is given.
 * @param sector hook.sec — used ONLY to look up `descriptorFor` (ci/post-image.mjs); no other
 *   fact reaches this module.
 * @param statement the post's own text (`best.text`) — this is the "hook", unmodified. The
 *   caller (ci/generate-posts.mjs) is responsible for making sure this does not repeat the
 *   company name — this module has no opinion on that, it just renders whatever it is given.
 * @returns `{ jpeg: Buffer, width: number, height: number, layout }` — `layout` is debug/test
 *   metadata (chosen font sizes and line counts), not needed by the one real caller
 *   (ci/generate-posts.mjs, which only reads `.jpeg`) but is what ci/test-post-compose.mjs
 *   verifies the "half the company-name size" and "cap the number of lines" rules against,
 *   rather than re-deriving them from raw pixels.
 */
export function composePost({ photo, companyName, sector, statement }) {
  const { width, height, mime } = imageDimensions(photo);
  const cx = width / 2;
  const marginX = width * 0.08;
  const maxTextWidth = width - marginX * 2;

  const name = String(companyName ?? "").trim() || "—";
  const descriptor = descriptorFor(sector);
  const line = String(statement ?? "").trim();

  const nameFit = fitText(name, {
    fontFamily: FONT_FAMILY_BOLD, fontWeight: "700", maxWidth: maxTextWidth, maxLines: 2,
    startSize: Math.round(height * 0.095), minSize: Math.round(height * 0.04), step: 2,
  });
  // Exactly half the company-name size, per spec — not independently fit-shrunk, only
  // fed through wrapText's own overflow guard as a defensive floor (a fixed 2-3 word
  // descriptor should never need it in practice).
  const descStart = Math.max(10, Math.round(nameFit.fontSize / 2));
  const descFit = fitText(descriptor, {
    fontFamily: FONT_FAMILY_MEDIUM, fontWeight: "500", maxWidth: maxTextWidth, maxLines: 1,
    startSize: descStart, minSize: Math.max(8, Math.round(descStart * 0.6)), step: 1,
  });
  const stmtFit = fitText(line, {
    fontFamily: FONT_FAMILY_BOLD, fontWeight: "700", maxWidth: maxTextWidth, maxLines: 4,
    startSize: Math.round(height * 0.085), minSize: Math.round(height * 0.035), step: 2,
  });

  const stats = sampleBrightness(photo, { top: { y0: 0, y1: 0.42 }, bottom: { y0: 0.6, y1: 1 } });
  const topHalo = haloStyle(stats.top);
  const bottomHalo = haloStyle(stats.bottom);

  // --- top block: company name, then the descriptor directly beneath it ---
  const topPad = height * 0.06;
  const nameLineHeight = nameFit.fontSize * 1.08;
  const nameBlockHeight = nameFit.lines.length * nameLineHeight;
  const nameDescGap = nameFit.fontSize * 0.34;
  const descLineHeight = descFit.fontSize * 1.15;

  const nameFirstBaseline = topPad + nameFit.fontSize * 0.86;
  const descFirstBaseline = topPad + nameBlockHeight + nameDescGap + descFit.fontSize * 0.86;

  // --- bottom block: the statement, bottom-anchored ---
  const bottomPad = height * 0.07;
  const stmtLineHeight = stmtFit.fontSize * 1.2;
  const stmtBlockHeight = stmtFit.lines.length * stmtLineHeight;
  const stmtBlockTop = height - bottomPad - stmtBlockHeight;
  const stmtFirstBaseline = stmtBlockTop + stmtFit.fontSize * 0.86;

  const b64 = photo.toString("base64");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" href="data:${mime};base64,${b64}"/>
    ${textLines(nameFit.lines, { x: cx, firstBaseline: nameFirstBaseline, lineHeight: nameLineHeight, fontFamily: FONT_FAMILY_BOLD, fontWeight: "700", fontSize: nameFit.fontSize, fill: topHalo.textFill, halo: topHalo })}
    ${textLines(descFit.lines, { x: cx, firstBaseline: descFirstBaseline, lineHeight: descLineHeight, fontFamily: FONT_FAMILY_MEDIUM, fontWeight: "500", fontSize: descFit.fontSize, fill: topHalo.textFill, halo: topHalo })}
    ${textLines(stmtFit.lines, { x: cx, firstBaseline: stmtFirstBaseline, lineHeight: stmtLineHeight, fontFamily: FONT_FAMILY_BOLD, fontWeight: "700", fontSize: stmtFit.fontSize, fill: bottomHalo.textFill, halo: bottomHalo })}
  </svg>`;

  const resvg = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: FONT_FILES } });
  const rendered = resvg.render();
  const jpeg = encodeJpeg({
    rgba: rendered.pixels, width: rendered.width, height: rendered.height, quality: JPEG_QUALITY,
  });
  return {
    jpeg, width: rendered.width, height: rendered.height,
    layout: {
      nameFontSize: nameFit.fontSize, nameLines: nameFit.lines.length,
      descriptorFontSize: descFit.fontSize, descriptorLines: descFit.lines.length,
      statementFontSize: stmtFit.fontSize, statementLines: stmtFit.lines.length,
      maxTextWidth,
    },
  };
}
