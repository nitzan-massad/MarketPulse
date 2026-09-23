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

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { descriptorFor } from "./post-image.mjs";

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

/** Dark ink on a light plate is the default (the photos are high-key by construction — see
 *  ci/post-image.mjs), inverted when the sampled band is actually dark, and given a stronger
 *  plate when the band is high-variance ("busy") regardless of which way the mean falls —
 *  a busy background needs more backing either way. */
function bandStyle({ mean, stdev }) {
  const dark = mean >= 150;
  const busy = stdev >= 55;
  return {
    textFill: dark ? "#10151f" : "#f7f9fc",
    plateFill: dark ? "#ffffff" : "#0b0f16",
    plateOpacity: busy ? 0.82 : 0.6,
  };
}

// ------------------------------------------------------------------- compose --

const textLines = (lines, { x, firstBaseline, lineHeight, fontFamily, fontWeight, fontSize, fill }) =>
  lines
    .map((line, i) => {
      const y = firstBaseline + i * lineHeight;
      return (
        `<text x="${x}" y="${y.toFixed(1)}" text-anchor="middle" font-family="${escapeXml(fontFamily)}" ` +
        `font-weight="${fontWeight}" font-size="${fontSize}" fill="${fill}">${escapeXml(line)}</text>`
      );
    })
    .join("");

/**
 * Fuse one photo + the post's text into a single PNG.
 *
 * Layout, top to bottom (inverts the old browser-overlay layout, which put the hook at the
 * top): the COMPANY NAME large at the top, a two/three-word SECTOR DESCRIPTOR directly beneath
 * it at half the company-name size, and the STATEMENT (the post's own text) large at the
 * bottom.
 *
 * @param photo Buffer — the raw Flux JPEG (or any PNG/JPEG).
 * @param companyName hook.name.
 * @param sector hook.sec — used ONLY to look up `descriptorFor` (ci/post-image.mjs); no other
 *   fact reaches this module.
 * @param statement the post's own text (`best.text`) — this is the "hook", unmodified.
 * @returns `{ png: Buffer, width: number, height: number, layout }` — `layout` is debug/test
 *   metadata (chosen font sizes and line counts), not needed by the one real caller
 *   (ci/generate-posts.mjs, which only reads `.png`) but is what ci/test-post-compose.mjs
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
  const topStyle = bandStyle(stats.top);
  const bottomStyle = bandStyle(stats.bottom);

  // --- top block: company name, then the descriptor directly beneath it ---
  const topPad = height * 0.06;
  const nameLineHeight = nameFit.fontSize * 1.08;
  const nameBlockHeight = nameFit.lines.length * nameLineHeight;
  const nameDescGap = nameFit.fontSize * 0.34;
  const descLineHeight = descFit.fontSize * 1.15;
  const descBlockHeight = descFit.lines.length * descLineHeight;
  const topBlockHeight = nameBlockHeight + nameDescGap + descBlockHeight;

  const nameFirstBaseline = topPad + nameFit.fontSize * 0.86;
  const descFirstBaseline = topPad + nameBlockHeight + nameDescGap + descFit.fontSize * 0.86;

  const topPlateY = Math.max(0, topPad - height * 0.025);
  const topPlateH = Math.min(height - topPlateY, topBlockHeight + height * 0.06);

  // --- bottom block: the statement, bottom-anchored ---
  const bottomPad = height * 0.07;
  const stmtLineHeight = stmtFit.fontSize * 1.2;
  const stmtBlockHeight = stmtFit.lines.length * stmtLineHeight;
  const stmtBlockTop = height - bottomPad - stmtBlockHeight;
  const stmtFirstBaseline = stmtBlockTop + stmtFit.fontSize * 0.86;

  const bottomPlateY = Math.max(0, stmtBlockTop - height * 0.035);
  const bottomPlateH = Math.min(height - bottomPlateY, height - bottomPlateY);

  const b64 = photo.toString("base64");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" href="data:${mime};base64,${b64}"/>
    <rect x="0" y="${topPlateY.toFixed(1)}" width="${width}" height="${topPlateH.toFixed(1)}" fill="${topStyle.plateFill}" opacity="${topStyle.plateOpacity}"/>
    <rect x="0" y="${bottomPlateY.toFixed(1)}" width="${width}" height="${bottomPlateH.toFixed(1)}" fill="${bottomStyle.plateFill}" opacity="${bottomStyle.plateOpacity}"/>
    ${textLines(nameFit.lines, { x: cx, firstBaseline: nameFirstBaseline, lineHeight: nameLineHeight, fontFamily: FONT_FAMILY_BOLD, fontWeight: "700", fontSize: nameFit.fontSize, fill: topStyle.textFill })}
    ${textLines(descFit.lines, { x: cx, firstBaseline: descFirstBaseline, lineHeight: descLineHeight, fontFamily: FONT_FAMILY_MEDIUM, fontWeight: "500", fontSize: descFit.fontSize, fill: topStyle.textFill })}
    ${textLines(stmtFit.lines, { x: cx, firstBaseline: stmtFirstBaseline, lineHeight: stmtLineHeight, fontFamily: FONT_FAMILY_BOLD, fontWeight: "700", fontSize: stmtFit.fontSize, fill: bottomStyle.textFill })}
  </svg>`;

  const resvg = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: FONT_FILES } });
  const rendered = resvg.render();
  return {
    png: rendered.asPng(), width: rendered.width, height: rendered.height,
    layout: {
      nameFontSize: nameFit.fontSize, nameLines: nameFit.lines.length,
      descriptorFontSize: descFit.fontSize, descriptorLines: descFit.lines.length,
      statementFontSize: stmtFit.fontSize, statementLines: stmtFit.lines.length,
      maxTextWidth,
    },
  };
}
