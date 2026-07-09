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
  consensus: string;
  cap: number;
}

export function passes(s: Stock, state: FilterState): boolean {
  if (state.q) {
    const q = state.q.toLowerCase();
    if (!((s.t || "").toLowerCase().includes(q) || (s.n || "").toLowerCase().includes(q))) return false;
  }
  if (state.sector && s.sec !== state.sector) return false;
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
const SEEN = seenData as Record<string, string>;
export const NEW_WINDOW_DAYS = 30;

export function addedInfo(t: string): { date: string; daysAgo: number } | null {
  const d = SEEN[t];
  if (!d || d === "baseline") return null;
  const days = Math.floor((Date.now() - new Date(d + "T00:00:00").getTime()) / 86400000);
  if (days < 0 || days > NEW_WINDOW_DAYS) return null;
  return { date: d, daysAgo: days };
}
export const isNew = (t: string): boolean => addedInfo(t) != null;
export const agoLabel = (days: number): string =>
  days <= 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;

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
