// The picture under every post. Drawn here, not fetched.
//
// An image model would cost money per post and, far worse, would render invented numbers and
// misspelled tickers into finance imagery. These scenes carry no text at all: the FORM says
// which industry, the seed makes a given ticker always look the same, and nothing drawn here
// can contradict the data above it.
//
// ponytail: six scenes plus a fallback, chosen off the `sec` field that is already in every
// row. If a sector deserves its own look later, add a draw function and one mapping line.

export type SceneName = "bio" | "screens" | "freight" | "grid" | "vault" | "earth" | "market";
type Rand = () => number;
type Draw = (c: CanvasRenderingContext2D, w: number, h: number, rand: Rand) => void;

/** FNV-1a over the ticker, then mulberry32. Stable across runs and browsers, which is what
 *  makes a name's picture recognisable from one post to the next. */
export function seeded(seed: string): Rand {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTOR_SCENE: Record<string, SceneName> = {
  "healthcare": "bio",
  "technology": "screens",
  "communication services": "screens",
  "communicationservices": "screens",
  "industrials": "freight",
  "general": "market", // TipRanks unclassified bucket, not an industry — fallback is honest
  "consumer cyclical": "grid",
  "consumercyclical": "grid",
  "consumer defensive": "grid",
  "consumerdefensive": "grid",
  "basic materials": "earth",
  "basicmaterials": "earth",
  "energy": "earth",
  "financial": "vault",
  "financial services": "vault",
  "real estate": "vault",
  "realestate": "vault",
  "utilities": "grid",
};

export function sceneFor(sector: string): SceneName {
  return SECTOR_SCENE[String(sector ?? "").trim().toLowerCase()] ?? "market";
}

// Mirrors src/index.css :root. Canvas cannot read CSS custom properties without extra
// plumbing, so the values a scene is allowed to draw MARKS in are restated here, literally —
// keep both in sync if the palette ever moves. Grounds (sky() gradients, terrain fills) are
// not required to be exactly one of these; they just have to be LIGHT, to match the card.
const INK = "#131a24", MUTED = "#55606f";
const BG = "#f9fafb", PANEL2 = "#e3e8ef";
const NAVY = "#1b3f73";
const GREEN = "#17864f", AMBER = "#b8860b", RED = "#c73a2b", TEAL = "#147c86";

/** "#rrggbb" -> "r,g,b", once, so a translucent version of a palette mark can be written as
 *  `rgba(${rgbOf(TEAL)},.4)` instead of a second, easy-to-drift decimal literal next to it. */
const rgbOf = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

const sky =(c: CanvasRenderingContext2D, w: number, h: number, a: string, b: string) => {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, a); g.addColorStop(1, b);
  c.fillStyle = g; c.fillRect(0, 0, w, h);
};
const rr = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  c.beginPath(); c.roundRect(x, y, w, h, r);
};

/** Molecular lattice — healthcare. Light ground (was dark navy -> near-black
 *  #0f3a52 -> #05090f); connectors and the node glow move from bright cyan-on-black to
 *  --teal, and the hex ring's dots move from pale gold to solid --amber, so both still read
 *  against the light card instead of washing out. Every shape, node count and seed use is
 *  unchanged. */
const bio: Draw = (c, w, h, r) => {
  sky(c, w, h, BG, "#dceef0");
  const cx = w * 0.56, cy = h * 0.46, R = Math.min(w, h) * 0.3;
  const glow = c.createRadialGradient(cx, cy, 0, cx, cy, R * 2.3);
  glow.addColorStop(0, `rgba(${rgbOf(TEAL)},.18)`); glow.addColorStop(1, `rgba(${rgbOf(TEAL)},0)`);
  c.fillStyle = glow; c.fillRect(0, 0, w, h);
  const N: { x: number; y: number; s: number }[] = [];
  const reach = Math.min(w, h) * 0.45;
  for (let i = 0; i < 16; i++) N.push({ x: r() * w, y: h * 0.08 + r() * h * 0.84, s: 1.8 + r() * 3 });
  c.lineWidth = 1.2;
  for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
    const d = Math.hypot(N[i].x - N[j].x, N[i].y - N[j].y);
    if (d >= reach) continue;
    c.globalAlpha = 0.55 * (1 - d / reach); c.strokeStyle = TEAL;
    c.beginPath(); c.moveTo(N[i].x, N[i].y); c.lineTo(N[j].x, N[j].y); c.stroke();
  }
  c.globalAlpha = 1;
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i - Math.PI / 6; pts.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]); }
  c.lineJoin = "round";
  c.strokeStyle = `rgba(${rgbOf(AMBER)},.32)`; c.lineWidth = Math.max(5, R * 0.22);
  c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.stroke();
  c.strokeStyle = AMBER; c.lineWidth = Math.max(1.8, R * 0.055); c.stroke();
  for (const [x, y] of pts) { c.beginPath(); c.arc(x, y, Math.max(2.4, R * 0.075), 0, 7); c.fillStyle = AMBER; c.fill(); }
  for (const q of N) {
    const g = c.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.s * 5);
    g.addColorStop(0, `rgba(${rgbOf(TEAL)},.5)`); g.addColorStop(1, `rgba(${rgbOf(TEAL)},0)`);
    c.fillStyle = g; c.beginPath(); c.arc(q.x, q.y, q.s * 5, 0, 7); c.fill();
    c.fillStyle = TEAL; c.beginPath(); c.arc(q.x, q.y, q.s * 0.7, 0, 7); c.fill();
  }
};

/** Wall of screens — technology and communications. Light ground (was dark slate -> near-
 *  black #1a2030 -> #05070b); non-hero tiles shade from --navy to --ink instead of a blue
 *  glow-on-black, and their border darkens to --ink instead of a pale blue-white line that
 *  would vanish on a light wall. The hero tile keeps its own strong red gradient (now built
 *  from --red, same pairing freight() uses) since that already read on either ground. */
const screens: Draw = (c, w, h, r) => {
  sky(c, w, h, BG, PANEL2);
  const cols = w > h ? 4 : 3, rows = Math.max(2, Math.round((cols * h) / w));
  const pad = Math.min(w, h) * 0.05, gw = (w - pad * (cols + 1)) / cols, gh = (h - pad * (rows + 1)) / rows;
  const hx = Math.floor(r() * cols), hy = Math.floor(r() * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const px = pad + x * (gw + pad), py = pad + y * (gh + pad);
    const hero = x === hx && y === hy, lum = hero ? 1 : 0.28 + r() * 0.5;
    const g = c.createLinearGradient(px, py, px, py + gh);
    if (hero) { g.addColorStop(0, RED); g.addColorStop(1, "#7d1f15"); }
    else { g.addColorStop(0, `rgba(${rgbOf(NAVY)},${lum})`); g.addColorStop(1, `rgba(${rgbOf(INK)},${lum})`); }
    rr(c, px, py, gw, gh, 5); c.fillStyle = g; c.fill();
    c.globalAlpha = hero ? 0.95 : 0.45; c.strokeStyle = `rgba(${rgbOf(INK)},.4)`; c.lineWidth = 1;
    rr(c, px, py, gw, gh, 5); c.stroke(); c.globalAlpha = 1;
    if (hero && Math.min(gw, gh) > 16) {
      const s = Math.min(gw, gh) * 0.3, mx = px + gw / 2, my = py + gh / 2;
      c.beginPath(); c.moveTo(mx - s * 0.42, my - s * 0.66); c.lineTo(mx + s * 0.7, my);
      c.lineTo(mx - s * 0.42, my + s * 0.66); c.closePath();
      c.fillStyle = "rgba(255,255,255,.96)"; c.fill();
    }
  }
};

/** Container yard, daytime — industrials and logistics. Light ground (was a dusk gradient
 *  #24518f -> #080d15, and a near-black yard-floor fill); the yard floor becomes a light
 *  warm concrete tone and the container palette moves onto the exact --red/--teal/--amber/
 *  --navy/--green tokens (each already dark/saturated enough to read on a light ground) in
 *  place of the old bespoke hexes. Same stacking, same jitter, same row logic. */
const freight: Draw = (c, w, h, r) => {
  sky(c, w, h, "#fdf4e3", PANEL2);
  const hz = h * 0.4;
  const sun = c.createRadialGradient(w * 0.72, hz, 0, w * 0.72, hz, Math.max(w, h) * 0.7);
  sun.addColorStop(0, "rgba(230,160,60,.4)"); sun.addColorStop(1, "rgba(230,160,60,0)");
  c.fillStyle = sun; c.fillRect(0, 0, w, h);
  c.fillStyle = "rgba(210,203,188,.85)"; c.fillRect(0, hz, w, h - hz);
  const cols: [string, string][] = [[RED, "#7d1f15"], [TEAL, "#0d454c"],
    [AMBER, "#7d5c08"], [NAVY, "#122c50"], [GREEN, "#0f5c37"]];
  for (let row = 0; row < 3; row++) {
    const d = row / 2, bw = w * (0.24 + d * 0.22), bh = h * (0.072 + d * 0.055);
    const y = hz + (h - hz) * Math.pow(d, 1.25) * 0.9;
    for (let x = -bw * 0.4; x < w + bw; x += bw * 1.05) {
      const stack = 1 + Math.floor(r() * (2 + row * 1.6));
      for (let s = 0; s < stack; s++) {
        const [f, sd] = cols[Math.floor(r() * cols.length)];
        const px = x + r() * 5, py = y - s * bh * 1.05;
        c.globalAlpha = 0.55 + d * 0.45;
        c.fillStyle = f; c.fillRect(px, py - bh, bw * 0.95, bh);
        c.fillStyle = sd; c.fillRect(px, py - bh, bw * 0.95, bh * 0.22);
        c.fillStyle = "rgba(0,0,0,.34)"; c.fillRect(px, py - bh * 0.18, bw * 0.95, bh * 0.18);
      }
    }
  }
  c.globalAlpha = 1;
};

/** Isometric shelving — consumer and utilities. Light ground (was dark navy -> near-black
 *  #1d3550 -> #070c13); the shelf line moves from a pale blue-on-black to --muted, and the
 *  box palette moves onto --navy/--teal/--amber/--red so it reads as saturated colour on a
 *  light shelf instead of glowing marks on a dark one. Same 6x7 grid, same per-box jitter. */
const grid: Draw = (c, w, h, r) => {
  sky(c, w, h, BG, PANEL2);
  const rows = 6, cell = h / rows;
  for (let y = 0; y < rows; y++) {
    const yy = y * cell + cell * 0.2;
    c.fillStyle = `rgba(${rgbOf(MUTED)},.3)`; c.fillRect(0, yy + cell * 0.62, w, 2);
    for (let x = 0; x < 7; x++) {
      const bw = w * (0.06 + r() * 0.07), bh = cell * (0.2 + r() * 0.38);
      const px = x * (w / 7) + r() * 8;
      c.globalAlpha = 0.55 + r() * 0.4;
      c.fillStyle = [NAVY, TEAL, AMBER, RED][Math.floor(r() * 4)];
      rr(c, px, yy + cell * 0.62 - bh, bw, bh, 2); c.fill();
    }
  }
  c.globalAlpha = 1;
};

/** Concentric vault rings — financials and real estate. Light ground (was dark navy ->
 *  near-black #152a44 -> #05080d); the rings and spokes move from pale blue-on-black to
 *  --navy, the highlighted ring stays --amber, and the centre dot moves from pale gold to
 *  solid --navy so it anchors the composition instead of washing out. Same ring count,
 *  same spoke count and jitter. */
const vault: Draw = (c, w, h, r) => {
  sky(c, w, h, "#faf5ea", PANEL2);
  const cx = w * 0.5, cy = h * 0.5, R = Math.min(w, h) * 0.42;
  for (let i = 6; i >= 1; i--) {
    c.beginPath(); c.arc(cx, cy, (R * i) / 6, 0, Math.PI * 2);
    c.strokeStyle = i === 3 ? AMBER : `rgba(${rgbOf(NAVY)},.3)`;
    c.lineWidth = i === 3 ? 3 : 1.2; c.globalAlpha = 0.4 + i / 14; c.stroke();
  }
  c.globalAlpha = 1;
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + r() * 0.2;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * R * 0.2, cy + Math.sin(a) * R * 0.2);
    c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    c.strokeStyle = `rgba(${rgbOf(NAVY)},.35)`; c.lineWidth = 1.4; c.stroke();
  }
  c.beginPath(); c.arc(cx, cy, R * 0.14, 0, Math.PI * 2); c.fillStyle = NAVY; c.fill();
};

/** Strata and a seam — energy and materials. Light ground (was dark brown -> near-black
 *  #3a2a1c -> #080605); the bands move from dark umber tones to light sandstone/tan ones (a
 *  ground, not a mark, so it does not have to be a literal :root token — there is no earth-
 *  tone family in the UI palette), and the seam line — the actual "mark" here — stays
 *  --amber, already dark enough to read against the lighter bands. Same band count, same
 *  per-band wave phase/amplitude, same seam jitter. */
const earth: Draw = (c, w, h, r) => {
  sky(c, w, h, "#f7f0df", "#ecdfc2");
  const bands = 9;
  for (let i = 0; i < bands; i++) {
    const y = (i / bands) * h;
    const phase = r() * Math.PI * 2, ampMult = 0.8 + r() * 0.4;
    c.beginPath(); c.moveTo(0, y);
    for (let x = 0; x <= w; x += 8) c.lineTo(x, y + Math.sin(x / (30 + i * 9) + i + phase) * (4 + i) * ampMult);
    c.lineTo(w, h); c.lineTo(0, h); c.closePath();
    c.fillStyle = ["#c9a874", "#b8925a", "#d9bd8c", "#a67f4c"][i % 4];
    c.globalAlpha = 0.5 + (i / bands) * 0.4; c.fill();
  }
  c.globalAlpha = 1;
  const seamY = h * (0.48 + r() * 0.2), seamWave = 5 + r() * 9, seamFreq = 30 + r() * 10;
  c.beginPath(); c.moveTo(0, seamY);
  for (let x = 0; x <= w; x += 10) c.lineTo(x, seamY + Math.sin(x / seamFreq) * seamWave);
  c.strokeStyle = AMBER; c.lineWidth = 2.4; c.stroke();
};

/** Candlestick skyline — the fallback for any sector without its own look. Light ground
 *  (was dark navy -> near-black #16263d -> #05080d); wicks and bodies move onto --green /
 *  --red, dark and saturated enough to hold up against the light ground in place of the old
 *  bright-on-black tones. Same 16-candle walk, same up/down jitter and clamping. */
const market: Draw = (c, w, h, r) => {
  sky(c, w, h, BG, PANEL2);
  const n = 16, cw = w / n;
  let y = h * 0.62;
  for (let i = 0; i < n; i++) {
    const move = (r() - 0.45) * h * 0.13;
    const top = Math.min(y, y + move), bot = Math.max(y, y + move);
    const up = move < 0, x = i * cw + cw * 0.28;
    c.strokeStyle = up ? `rgba(${rgbOf(GREEN)},.8)` : `rgba(${rgbOf(RED)},.8)`;
    c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(x + cw * 0.22, top - r() * 10); c.lineTo(x + cw * 0.22, bot + r() * 10); c.stroke();
    c.fillStyle = up ? GREEN : RED; c.globalAlpha = 0.88;
    c.fillRect(x, top, cw * 0.44, Math.max(2, bot - top));
    c.globalAlpha = 1; y += move;
    y = Math.max(h * 0.22, Math.min(h * 0.82, y));
  }
};

export const SCENES: Record<SceneName, Draw> = { bio, screens, freight, grid, vault, earth, market };

/** Size for the device pixel ratio and draw. A canvas with no layout size yet is skipped —
 *  the caller repaints on resize. */
export function paint(canvas: HTMLCanvasElement, sector: string, ticker: string): void {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const c = canvas.getContext("2d");
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  SCENES[sceneFor(sector)](c, w, h, seeded(ticker));
}
