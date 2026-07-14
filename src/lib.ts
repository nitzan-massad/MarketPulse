import type { Col, Stock, View, ViewId } from "./types";
import seenData from "./data/seen.json";

export const VIEWS: Record<ViewId, View> = {
  analyst: {
    title: 'Analyst <span class="em">Top</span>',
    dek: "The Street's highest-conviction calls — every name, price target and rating, ranked by upside to the top-analyst consensus target.",
    tab: "Analyst Top Stocks", sub: "By price-target upside", sort: "up", dir: -1, hl: "up",
  },
  smart: {
    title: 'Top <span class="em">Smart Score</span>',
    dek: "Ranked by TipRanks' Smart Score — an 8-factor quant model blending analysts, hedge funds, insiders, news and technicals into a 1–10 score.",
    tab: "Top Smart Score", sub: "By Smart Score 1–10", sort: "ss", dir: -1, hl: "ss",
  },
  ai: {
    title: 'AI Analyst <span class="em">Top</span>',
    dek: "Ranked by the TipRanks AI Analyst — a model scoring financials, earnings calls and momentum from 0–100, with its own rating and target.",
    tab: "AI Analyst Top Stocks", sub: "By AI score 0–100", sort: "ai", dir: -1, hl: "ai",
  },
};

export const COLS: Col[] = [
  { k: "_rank", l: "#", cls: "rank l", sortable: false },
  { k: "_tk", l: "Ticker / Company", cls: "l", sortable: false },
  { k: "px", l: "Price", sortable: true },
  { k: "chg", l: "Day %", sortable: true },
  { k: "con", l: "Consensus", cls: "l", sortable: true },
  { k: "pt", l: "Predicted Price", sortable: true },
  { k: "up", l: "Upside", sortable: true },
  { k: "ss", l: "Smart Score", sortable: true },
  { k: "ai", l: "AI Score", sortable: true },
  { k: "sec", l: "Sector", cls: "sec l", sortable: true },
  { k: "mc", l: "Mkt Cap", sortable: true },
];

export const fmtMc = (m: number | null): string =>
  m == null ? "—" : m >= 1e6 ? "$" + (m / 1e6).toFixed(2) + "T" : m >= 1e3 ? "$" + (m / 1e3).toFixed(1) + "B" : "$" + Math.round(m) + "M";

export const fmtPx = (v: number | null): string =>
  v == null ? "—" : "$" + (v >= 100 ? v.toFixed(0) : v.toFixed(2));

export function consClass(c: string): string {
  c = (c || "").toLowerCase();
  if (c.includes("strongbuy")) return "sb";
  if (c.includes("strongsell")) return "ss";
  if (c.includes("buy")) return "b";
  if (c.includes("sell")) return "s";
  return "h";
}

export function consLabel(c: string): string {
  return (c || "—").replace(/([a-z])([A-Z])/g, "$1 $2");
}

// v in 0..max -> red->amber->green
export function scoreColor(v: number | null, max: number): string | null {
  if (v == null) return null;
  const t = Math.max(0, Math.min(1, v / max));
  const h = 4 + t * 128; // 4(red) .. 132(green)
  return `hsl(${h} 64% 37%)`;
}

export interface FilterState {
  q: string;
  sector: string;
  sectorNot: boolean; // true = exclude the chosen sector instead of only-showing it
  consensus: string;
  cap: number;
}

export function passes(s: Stock, state: FilterState): boolean {
  if (state.q) {
    const q = state.q.toLowerCase();
    if (!((s.t || "").toLowerCase().includes(q) || (s.n || "").toLowerCase().includes(q))) return false;
  }
  if (state.sector && (s.sec === state.sector) === state.sectorNot) return false;
  if (state.cap && (s.mc == null || s.mc < state.cap)) return false;
  const c = (s.con || "").toLowerCase();
  switch (state.consensus) {
    case "StrongBuy": if (!c.includes("strongbuy")) return false; break;
    case "buyplus": if (!c.includes("buy")) return false; break;
    case "Hold": if (c.includes("buy") || c.includes("sell")) return false; break;
    case "sellany": if (!c.includes("sell")) return false; break;
  }
  return true;
}

// ---- recently-added tracking ---------------------------------------------
// first-seen dates: "baseline" = present before we started tracking; a date =
// the day the ticker first appeared in the screener. Backfilled from git
// history, maintained by the refresh scripts. "New" = added within the window.
export interface SeenEntry {
  d: string; // first-seen: ISO timestamp (or legacy "YYYY-MM-DD"), or "baseline" (present before tracking)
  ss?: number | null; // Smart Score at first sighting (baseline for the Changes column)
  ai?: number | null; // AI score at first sighting
  con?: string | null; // consensus at first sighting
  l?: string[]; // which ranking(s) it entered on: "u" upside, "s" smart score, "m" market cap
}
// human labels for the entry lists (l)
export const LIST_LABEL: Record<string, string> = { u: "Analyst", s: "Smart Score", a: "AI Top" };
const SEEN = seenData as Record<string, SeenEntry>;
export const NEW_WINDOW_DAYS = 30;

export function addedInfo(t: string): { date: string; daysAgo: number; hoursAgo: number } | null {
  const d = SEEN[t]?.d;
  if (!d || d === "baseline") return null;
  // d is either a date "YYYY-MM-DD" (legacy) or a full ISO timestamp (stamped since we track time)
  const ms = Date.now() - new Date(d.includes("T") ? d : d + "T00:00:00").getTime();
  const days = Math.floor(ms / 86400000);
  if (days < 0 || days > NEW_WINDOW_DAYS) return null;
  return { date: d.slice(0, 10), daysAgo: days, hoursAgo: Math.floor(ms / 3600000) };
}
export const isNew = (t: string): boolean => addedInfo(t) != null;
// within 2 days we show hours (24–48h as "1d Nh"); older names fall back to whole days
export const agoLabel = (days: number, hours: number): string => {
  if (days >= 2) return `${days}d ago`;
  if (days === 1) {
    const h = hours - 24;
    return h <= 0 ? "1d ago" : `1d ${h}h ago`;
  }
  return hours <= 0 ? "just now" : `${hours}h ago`;
};
// baseline metrics captured when the ticker first appeared (for the Changes column)
export const firstSeen = (t: string): SeenEntry | null => SEEN[t] ?? null;

export function sortRows(rows: Stock[], sort: keyof Stock, dir: number): Stock[] {
  return [...rows].sort((a, b) => {
    const x = a[sort];
    const y = b[sort];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string") return dir * x.localeCompare(y as string);
    return dir * ((x as number) - (y as number));
  });
}
