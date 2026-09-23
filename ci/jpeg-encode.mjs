// A MINIMAL BASELINE JPEG ENCODER, from raw RGBA pixels — the one piece @resvg/resvg-js does
// not provide. resvg rasterises SVG to either a PNG (`RenderedImage.asPng()`) or raw RGBA
// pixels (`.pixels`); there is no JPEG output anywhere in it, and this repo carries no other
// image library (no sharp, no jpeg-js, no mozjpeg — check package.json). Rather than add one,
// this writes the ~350 lines ITU-T.81 (the JPEG spec) actually requires for a baseline
// (non-progressive, Huffman-coded) encoder — the same call already made for the hand-rolled
// PNG/JPEG *header* parsers in ci/post-compose.mjs, one level deeper.
//
// WHY THIS EXISTS: a composed post card was a ~900KB PNG at Flux's 1024x1024 output size —
// mostly photographic detail PNG's lossless deflate cannot touch. At POSTS_KEEP=200 that is
// ~180MB accumulating in git. JPEG's DCT+quantisation is built for exactly this content and
// gets the same pixels down an order of magnitude, which is the entire point of this file.
//
// SCOPE, DELIBERATELY NARROW: baseline sequential DCT only (the one every decoder on earth
// reads), no chroma subsampling (every component — Y, Cb, Cr — gets its own full-resolution
// 8x8 block; 4:2:0 subsampling would shrink the file further but doubles the MCU bookkeeping
// and is where a hand-rolled encoder is most likely to hide a subtle bug), and the STANDARD
// Huffman tables ITU-T.81 Annex K.3 publishes as example tables rather than per-image-optimised
// ones — this is what most baseline encoders that skip Huffman optimisation ship, and every
// baseline decoder is built to read them.
//
// VERIFIED how a from-scratch codec like this has to be, absent a second decoder in this repo
// to round-trip against: ci/test-jpeg-encode.mjs checks the marker structure directly (SOI/EOI,
// a correctly-round-tripped SOF0 width/height via ci/post-compose.mjs's OWN JPEG header parser)
// and the compression ratio; the actual pixel fidelity was eyeballed once by hand, encoding a
// real composed card and opening it in a real decoder (macOS Preview / `sips`) outside this
// repo — not something a committed test can assert, but worth recording here for the next
// person who touches this file and wonders whether it was ever actually looked at.

// ---------------------------------------------------------------- standard tables (Annex K) --

/** Maps a zig-zag scan position (0-63) to its natural (row-major, `row*8+col`) index. Both the
 *  quantisation tables below and the DCT output are natural-order; DQT segments and the AC/DC
 *  scan itself are zig-zag order — this table is the translation between the two, in both
 *  directions (encode reads `natural[ZIGZAG[i]]` to produce zig-zag order). */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

/** ITU-T.81 Annex K.1 example luminance/chrominance quantisation tables, at their published
 *  "quality 50" baseline — `scaledQuantTable` below scales them the same way IJG's libjpeg
 *  does for any other quality. Natural (row-major) order, NOT zig-zag. */
const BASE_LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const BASE_CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

/** The IJG quality->scale mapping (quality 1-100, higher is better/bigger): below 50 the base
 *  table is scaled UP (coarser), above 50 scaled down (finer), 50 itself is the base table
 *  unchanged. Every general-purpose JPEG encoder that exposes a 1-100 "quality" knob computes
 *  this the same way, which is why it reproduces expected file sizes for a given quality. */
function scaledQuantTable(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** Standard Huffman tables, ITU-T.81 Annex K.3 (tables K.3-K.6) — `BITS` is a count of codes
 *  per code length 1-16, `VALS` lists the symbols in the order those code-length groups are
 *  assigned (shortest codes first), exactly as the spec publishes them. */
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
  0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
  0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
  0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
  0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
  0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
  0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
  0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
  0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
  0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
  0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
  0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
  0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
  0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/** ITU-T.81 Annex C's "generate_size_table" + "generate_code_table": expand BITS/VALS into a
 *  Map from symbol -> canonical Huffman {code, length}, shortest codes assigned first, exactly
 *  as every JPEG decoder on earth reconstructs the same tables from the same BITS/VALS bytes. */
function buildHuffmanTable(bits, vals) {
  const codeLengths = [];
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) codeLengths.push(len);
  }
  const huffCode = new Array(codeLengths.length);
  let code = 0;
  let k = 0;
  let si = codeLengths[0];
  while (k < codeLengths.length) {
    while (k < codeLengths.length && codeLengths[k] === si) {
      huffCode[k] = code;
      code++;
      k++;
    }
    code <<= 1;
    si++;
  }
  const table = new Map();
  for (let i = 0; i < vals.length; i++) table.set(vals[i], { code: huffCode[i], length: codeLengths[i] });
  return table;
}

// --------------------------------------------------------------------- forward DCT (8x8) -----
//
// The textbook, orthonormal-basis separable DCT-II (ITU-T.81 Annex A.3.3's own formula,
// factored into a basis matrix applied twice — once per dimension — rather than the AAN fast
// algorithm real encoders use for speed): F[v][u] = sum_y sum_x basis[v][y]*basis[u][x]*f[y][x],
// where basis[k][n] = 0.5 * (k===0 ? 1/sqrt(2) : 1) * cos((2n+1)*k*PI/16). Slower (~1000
// mul-adds per 8x8 block instead of the AAN algorithm's ~30) but there is exactly one place a
// scaling-constant transcription error could hide, instead of several — worth the trade in code
// nobody has verified against a second implementation.

const DCT_BASIS = (() => {
  const basis = new Float64Array(64); // basis[k*8+n]
  for (let k = 0; k < 8; k++) {
    const ck = k === 0 ? 1 / Math.sqrt(2) : 1;
    for (let n = 0; n < 8; n++) basis[k * 8 + n] = 0.5 * ck * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  }
  return basis;
})();

/** @param f Float64Array(64), level-shifted (sample - 128) pixels, `f[y*8+x]`.
 *  @returns Float64Array(64) DCT coefficients, natural order, `F[v*8+u]`. */
function fdct(f) {
  const g = new Float64Array(64); // g[y*8+u] — 1D DCT along x (horizontal)
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += DCT_BASIS[u * 8 + x] * f[y * 8 + x];
      g[y * 8 + u] = sum;
    }
  }
  const F = new Float64Array(64); // F[v*8+u] — 1D DCT along y (vertical) of the above
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += DCT_BASIS[v * 8 + y] * g[y * 8 + u];
      F[v * 8 + u] = sum;
    }
  }
  return F;
}

// ------------------------------------------------------------------------- bit-level output --

/** MSB-first bit packer with JPEG's mandatory entropy-stream byte-stuffing (an emitted 0xFF
 *  byte is always followed by a stuffed 0x00, so the decoder can tell it apart from a marker)
 *  and end-of-scan padding (remaining bits before EOI are 1-bits, per convention). */
class BitWriter {
  constructor() {
    this.bytes = [];
    this.buf = 0;
    this.n = 0;
  }

  writeBits(code, length) {
    if (length === 0) return;
    this.buf = (this.buf << length) | (code & ((1 << length) - 1));
    this.n += length;
    while (this.n >= 8) {
      const byte = (this.buf >> (this.n - 8)) & 0xff;
      this.bytes.push(byte);
      if (byte === 0xff) this.bytes.push(0x00);
      this.n -= 8;
    }
    this.buf &= (1 << this.n) - 1;
  }

  flush() {
    if (this.n > 0) {
      const pad = 8 - this.n;
      const byte = ((this.buf << pad) | ((1 << pad) - 1)) & 0xff;
      this.bytes.push(byte);
      if (byte === 0xff) this.bytes.push(0x00);
      this.buf = 0;
      this.n = 0;
    }
  }
}

/** Number of bits needed to represent `Math.abs(v)` — JPEG's "SSSS"/category. 0 has category 0
 *  (no additional bits at all: an unchanged DC, or the value that never reaches this function
 *  for AC since a zero AC coefficient is run-length coded, never emitted with its own symbol). */
function categoryOf(v) {
  let a = Math.abs(v);
  let cat = 0;
  while (a > 0) {
    cat++;
    a >>= 1;
  }
  return cat;
}

/** The category's "additional bits": `v` itself when non-negative, or the one's-complement of
 *  `|v|` within `cat` bits when negative (`v + (1<<cat) - 1`) — the standard JPEG magnitude
 *  encoding (ITU-T.81 F.1.2.1), needed because Huffman only encodes the *category*, not the
 *  sign or exact value. */
function amplitude(v, cat) {
  if (cat === 0) return 0;
  return v >= 0 ? v : v + (1 << cat) - 1;
}

/** One 8x8 block's DC (differential from `prevDc`, same component) + AC (run-length + category,
 *  zig-zag order, ZRL for 16-zero runs, EOB for a trailing run of zeros) — ITU-T.81 F.1.2. */
function encodeBlock(writer, zz, prevDc, dcTable, acTable) {
  const diff = zz[0] - prevDc;
  const dcCat = categoryOf(diff);
  const dc = dcTable.get(dcCat);
  writer.writeBits(dc.code, dc.length);
  if (dcCat > 0) writer.writeBits(amplitude(diff, dcCat), dcCat);

  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = zz[k];
    if (v === 0) {
      run++;
      continue;
    }
    while (run > 15) {
      const zrl = acTable.get(0xf0);
      writer.writeBits(zrl.code, zrl.length);
      run -= 16;
    }
    const cat = categoryOf(v);
    const sym = acTable.get((run << 4) | cat);
    writer.writeBits(sym.code, sym.length);
    writer.writeBits(amplitude(v, cat), cat);
    run = 0;
  }
  if (run > 0) {
    const eob = acTable.get(0x00);
    writer.writeBits(eob.code, eob.length);
  }
  return zz[0];
}

// ------------------------------------------------------------------------- pixels -> planes --

/** BT.601 full-range RGB -> YCbCr, built directly into PADDED planes (padded up to a multiple
 *  of 8 in each dimension, since every component is a whole number of 8x8 blocks and Flux's
 *  1024x1024 output is not guaranteed to be the only size this ever sees — ci/post-compose.mjs
 *  preserves the source photo's aspect ratio verbatim). Padding edge-extends the last real row
 *  and column rather than zero-filling, which is what keeps the padding invisible: a hard edge
 *  into black would otherwise inject high-frequency energy the DCT has to spend bits encoding,
 *  right at the border no viewer ever sees anyway (JPEG dimensions in SOF0 are the true
 *  width/height; decoders crop the padding away). */
function buildPlanes(rgba, width, height, padW, padH) {
  const Y = new Float64Array(padW * padH);
  const Cb = new Float64Array(padW * padH);
  const Cr = new Float64Array(padW * padH);
  for (let y = 0; y < padH; y++) {
    const sy = Math.min(y, height - 1);
    for (let x = 0; x < padW; x++) {
      const sx = Math.min(x, width - 1);
      const i = (sy * width + sx) * 4;
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const o = y * padW + x;
      Y[o] = 0.299 * r + 0.587 * g + 0.114 * b;
      Cb[o] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      Cr[o] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    }
  }
  return { Y, Cb, Cr };
}

function extractBlock(plane, padW, bx, by) {
  const block = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    const row = (by * 8 + y) * padW + bx * 8;
    for (let x = 0; x < 8; x++) block[y * 8 + x] = plane[row + x] - 128;
  }
  return block;
}

// --------------------------------------------------------------------- marker segments -------

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];

function jfifApp0() {
  return [0xff, 0xe0, ...u16(16), 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, ...u16(1), ...u16(1), 0, 0];
}

function dqtSegment(id, quant) {
  const zz = ZIGZAG.map((n) => quant[n]);
  return [0xff, 0xdb, ...u16(2 + 1 + 64), id & 0x0f, ...zz];
}

function sof0Segment(width, height) {
  return [
    0xff, 0xc0, ...u16(8 + 3 * 3),
    8, ...u16(height), ...u16(width),
    3,
    1, 0x11, 0, // Y — no subsampling, quant table 0
    2, 0x11, 1, // Cb — quant table 1
    3, 0x11, 1, // Cr — quant table 1
  ];
}

function dhtSegment(klass, id, bits, vals) {
  return [0xff, 0xc4, ...u16(2 + 1 + 16 + vals.length), (klass << 4) | id, ...bits, ...vals];
}

function sosSegment() {
  return [
    0xff, 0xda, ...u16(6 + 2 * 3),
    3,
    1, 0x00, // Y: DC table 0, AC table 0
    2, 0x11, // Cb: DC table 1, AC table 1
    3, 0x11, // Cr: DC table 1, AC table 1
    0x00, 0x3f, 0x00, // baseline sequential: full spectral range, no successive approximation
  ];
}

// ------------------------------------------------------------------------------ public API ----

/**
 * Encode raw RGBA pixels (as e.g. `@resvg/resvg-js`'s `RenderedImage.pixels`) as a baseline
 * JPEG. Alpha is ignored (a composed post card is fully opaque — see ci/post-compose.mjs).
 *
 * @param rgba Buffer/Uint8Array, 4 bytes/pixel, `width*height*4` long.
 * @param quality 1-100, IJG-style (50 = the standard tables unscaled; ~80-85 is a good
 *   photographic default — high enough that DCT blockiness is not visible at feed-card size,
 *   low enough to land a 1024x1024 photo in the tens, not hundreds, of KB).
 * @returns Buffer — a complete, standalone .jpg file.
 */
export function encodeJpeg({ rgba, width, height, quality = 82 }) {
  if (!width || !height) throw new Error("encodeJpeg: width and height are required");
  const padW = Math.ceil(width / 8) * 8;
  const padH = Math.ceil(height / 8) * 8;
  const { Y, Cb, Cr } = buildPlanes(rgba, width, height, padW, padH);

  const lumaQ = scaledQuantTable(BASE_LUMA_QUANT, quality);
  const chromaQ = scaledQuantTable(BASE_CHROMA_QUANT, quality);
  const dcLuma = buildHuffmanTable(DC_LUMA_BITS, DC_LUMA_VALS);
  const acLuma = buildHuffmanTable(AC_LUMA_BITS, AC_LUMA_VALS);
  const dcChroma = buildHuffmanTable(DC_CHROMA_BITS, DC_CHROMA_VALS);
  const acChroma = buildHuffmanTable(AC_CHROMA_BITS, AC_CHROMA_VALS);

  const writer = new BitWriter();
  const zz = new Int32Array(64);
  let prevY = 0;
  let prevCb = 0;
  let prevCr = 0;

  const encodeOneBlock = (plane, bx, by, quant, dcTable, acTable, prevDc) => {
    const F = fdct(extractBlock(plane, padW, bx, by));
    for (let i = 0; i < 64; i++) {
      const n = ZIGZAG[i];
      zz[i] = Math.round(F[n] / quant[n]);
    }
    return encodeBlock(writer, zz, prevDc, dcTable, acTable);
  };

  const blocksX = padW / 8;
  const blocksY = padH / 8;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      prevY = encodeOneBlock(Y, bx, by, lumaQ, dcLuma, acLuma, prevY);
      prevCb = encodeOneBlock(Cb, bx, by, chromaQ, dcChroma, acChroma, prevCb);
      prevCr = encodeOneBlock(Cr, bx, by, chromaQ, dcChroma, acChroma, prevCr);
    }
  }
  writer.flush();

  const header = [
    0xff, 0xd8, // SOI
    ...jfifApp0(),
    ...dqtSegment(0, lumaQ),
    ...dqtSegment(1, chromaQ),
    ...sof0Segment(width, height),
    ...dhtSegment(0, 0, DC_LUMA_BITS, DC_LUMA_VALS),
    ...dhtSegment(1, 0, AC_LUMA_BITS, AC_LUMA_VALS),
    ...dhtSegment(0, 1, DC_CHROMA_BITS, DC_CHROMA_VALS),
    ...dhtSegment(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS),
    ...sosSegment(),
  ];
  return Buffer.concat([Buffer.from(header), Buffer.from(writer.bytes), Buffer.from([0xff, 0xd9])]);
}
