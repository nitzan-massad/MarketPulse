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

const sky = (c: CanvasRenderingContext2D, w: number, h: number, a: string, b: string) => {
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, a); g.addColorStop(1, b);
  c.fillStyle = g; c.fillRect(0, 0, w, h);
};
const rr = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  c.beginPath(); c.roundRect(x, y, w, h, r);
};

/** Molecular lattice — healthcare. */
const bio: Draw = (c, w, h, r) => {
  sky(c, w, h, "#0f3a52", "#05090f");
  const cx = w * 0.56, cy = h * 0.46, R = Math.min(w, h) * 0.3;
  const glow = c.createRadialGradient(cx, cy, 0, cx, cy, R * 2.3);
  glow.addColorStop(0, "rgba(58,174,184,.42)"); glow.addColorStop(1, "rgba(58,174,184,0)");
  c.fillStyle = glow; c.fillRect(0, 0, w, h);
  const N: { x: number; y: number; s: number }[] = [];
  const reach = Math.min(w, h) * 0.45;
  for (let i = 0; i < 16; i++) N.push({ x: r() * w, y: h * 0.08 + r() * h * 0.84, s: 1.8 + r() * 3 });
  c.lineWidth = 1.2;
  for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) {
    const d = Math.hypot(N[i].x - N[j].x, N[i].y - N[j].y);
    if (d >= reach) continue;
    c.globalAlpha = 0.5 * (1 - d / reach); c.strokeStyle = "#5fd6e0";
    c.beginPath(); c.moveTo(N[i].x, N[i].y); c.lineTo(N[j].x, N[j].y); c.stroke();
  }
  c.globalAlpha = 1;
  const pts: [number, number][] = [];
  for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i - Math.PI / 6; pts.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]); }
  c.lineJoin = "round";
  c.strokeStyle = "rgba(240,185,60,.3)"; c.lineWidth = Math.max(5, R * 0.22);
  c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.stroke();
  c.strokeStyle = "#f0b93c"; c.lineWidth = Math.max(1.8, R * 0.055); c.stroke();
  for (const [x, y] of pts) { c.beginPath(); c.arc(x, y, Math.max(2.4, R * 0.075), 0, 7); c.fillStyle = "#ffd98a"; c.fill(); }
  for (const q of N) {
    const g = c.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.s * 5);
    g.addColorStop(0, "rgba(150,240,250,.95)"); g.addColorStop(1, "rgba(150,240,250,0)");
    c.fillStyle = g; c.beginPath(); c.arc(q.x, q.y, q.s * 5, 0, 7); c.fill();
    c.fillStyle = "#dbf7fb"; c.beginPath(); c.arc(q.x, q.y, q.s * 0.7, 0, 7); c.fill();
  }
};

/** Wall of screens — technology and communications. */
const screens: Draw = (c, w, h, r) => {
  sky(c, w, h, "#1a2030", "#05070b");
  const cols = w > h ? 4 : 3, rows = Math.max(2, Math.round((cols * h) / w));
  const pad = Math.min(w, h) * 0.05, gw = (w - pad * (cols + 1)) / cols, gh = (h - pad * (rows + 1)) / rows;
  const hx = Math.floor(r() * cols), hy = Math.floor(r() * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const px = pad + x * (gw + pad), py = pad + y * (gh + pad);
    const hero = x === hx && y === hy, lum = hero ? 1 : 0.14 + r() * 0.5;
    const g = c.createLinearGradient(px, py, px, py + gh);
    if (hero) { g.addColorStop(0, "#ef4a36"); g.addColorStop(1, "#8c2117"); }
    else { g.addColorStop(0, `rgba(59,111,189,${lum})`); g.addColorStop(1, `rgba(18,34,58,${lum})`); }
    rr(c, px, py, gw, gh, 5); c.fillStyle = g; c.fill();
    c.globalAlpha = hero ? 0.95 : 0.34; c.strokeStyle = "rgba(190,215,250,.55)"; c.lineWidth = 1;
    rr(c, px, py, gw, gh, 5); c.stroke(); c.globalAlpha = 1;
    if (hero && Math.min(gw, gh) > 16) {
      const s = Math.min(gw, gh) * 0.3, mx = px + gw / 2, my = py + gh / 2;
      c.beginPath(); c.moveTo(mx - s * 0.42, my - s * 0.66); c.lineTo(mx + s * 0.7, my);
      c.lineTo(mx - s * 0.42, my + s * 0.66); c.closePath();
      c.fillStyle = "rgba(255,255,255,.96)"; c.fill();
    }
  }
};

/** Container yard at dusk — industrials and logistics. */
const freight: Draw = (c, w, h, r) => {
  sky(c, w, h, "#24518f", "#080d15");
  const hz = h * 0.4;
  const sun = c.createRadialGradient(w * 0.72, hz, 0, w * 0.72, hz, Math.max(w, h) * 0.7);
  sun.addColorStop(0, "rgba(230,160,60,.55)"); sun.addColorStop(1, "rgba(230,160,60,0)");
  c.fillStyle = sun; c.fillRect(0, 0, w, h);
  c.fillStyle = "rgba(5,9,15,.8)"; c.fillRect(0, hz, w, h - hz);
  const cols: [string, string][] = [["#d8402f", "#7d1f15"], ["#1fa3b0", "#0d555c"],
    ["#e0a41a", "#7d5c08"], ["#3b6fbd", "#1b3f73"], ["#1ea45f", "#0f5c37"]];
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

/** Isometric shelving — consumer and utilities. */
const grid: Draw = (c, w, h, r) => {
  sky(c, w, h, "#1d3550", "#070c13");
  const rows = 6, cell = h / rows;
  for (let y = 0; y < rows; y++) {
    const yy = y * cell + cell * 0.2;
    c.fillStyle = "rgba(120,160,215,.16)"; c.fillRect(0, yy + cell * 0.62, w, 2);
    for (let x = 0; x < 7; x++) {
      const bw = w * (0.06 + r() * 0.07), bh = cell * (0.2 + r() * 0.38);
      const px = x * (w / 7) + r() * 8;
      c.globalAlpha = 0.3 + r() * 0.6;
      c.fillStyle = ["#3b6fbd", "#1fa3b0", "#e0a41a", "#d8402f"][Math.floor(r() * 4)];
      rr(c, px, yy + cell * 0.62 - bh, bw, bh, 2); c.fill();
    }
  }
  c.globalAlpha = 1;
};

/** Concentric vault rings — financials and real estate. */
const vault: Draw = (c, w, h, r) => {
  sky(c, w, h, "#152a44", "#05080d");
  const cx = w * 0.5, cy = h * 0.5, R = Math.min(w, h) * 0.42;
  for (let i = 6; i >= 1; i--) {
    c.beginPath(); c.arc(cx, cy, (R * i) / 6, 0, Math.PI * 2);
    c.strokeStyle = i === 3 ? "#e0a41a" : "rgba(120,170,230,.42)";
    c.lineWidth = i === 3 ? 3 : 1.2; c.globalAlpha = 0.35 + i / 12; c.stroke();
  }
  c.globalAlpha = 1;
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + r() * 0.2;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * R * 0.2, cy + Math.sin(a) * R * 0.2);
    c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    c.strokeStyle = "rgba(160,200,245,.3)"; c.lineWidth = 1.4; c.stroke();
  }
  c.beginPath(); c.arc(cx, cy, R * 0.14, 0, Math.PI * 2); c.fillStyle = "#ffd98a"; c.fill();
};

/** Strata and a seam — energy and materials. */
const earth: Draw = (c, w, h, r) => {
  sky(c, w, h, "#3a2a1c", "#080605");
  const bands = 9;
  for (let i = 0; i < bands; i++) {
    const y = (i / bands) * h;
    const phase = r() * Math.PI * 2, ampMult = 0.8 + r() * 0.4;
    c.beginPath(); c.moveTo(0, y);
    for (let x = 0; x <= w; x += 8) c.lineTo(x, y + Math.sin(x / (30 + i * 9) + i + phase) * (4 + i) * ampMult);
    c.lineTo(w, h); c.lineTo(0, h); c.closePath();
    c.fillStyle = ["#6b4a2a", "#4a3220", "#8a5c2e", "#2f2015"][i % 4];
    c.globalAlpha = 0.45 + (i / bands) * 0.5; c.fill();
  }
  c.globalAlpha = 1;
  const seamY = h * (0.48 + r() * 0.2), seamWave = 5 + r() * 9, seamFreq = 30 + r() * 10;
  c.beginPath(); c.moveTo(0, seamY);
  for (let x = 0; x <= w; x += 10) c.lineTo(x, seamY + Math.sin(x / seamFreq) * seamWave);
  c.strokeStyle = "#e0a41a"; c.lineWidth = 2.4; c.stroke();
};

/** Candlestick skyline — the fallback for any sector without its own look. */
const market: Draw = (c, w, h, r) => {
  sky(c, w, h, "#16263d", "#05080d");
  const n = 16, cw = w / n;
  let y = h * 0.62;
  for (let i = 0; i < n; i++) {
    const move = (r() - 0.45) * h * 0.13;
    const top = Math.min(y, y + move), bot = Math.max(y, y + move);
    const up = move < 0, x = i * cw + cw * 0.28;
    c.strokeStyle = up ? "rgba(63,190,128,.75)" : "rgba(232,112,95,.75)";
    c.lineWidth = 1.2;
    c.beginPath(); c.moveTo(x + cw * 0.22, top - r() * 10); c.lineTo(x + cw * 0.22, bot + r() * 10); c.stroke();
    c.fillStyle = up ? "#3fbe80" : "#e8705f"; c.globalAlpha = 0.85;
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
