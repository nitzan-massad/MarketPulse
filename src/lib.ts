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
  { k: "con", l: "Consensus", cls: "c", sortable: true },
  { k: "pt", l: "Predicted Price", sortable: true },
  { k: "up", l: "Upside", sortable: true },
  { k: "ss", l: "Smart Score", sortable: true },
  { k: "ai", l: "AI Score", sortable: true },
  { k: "sec", l: "Sector", cls: "sec l", sortable: true },
  { k: "mc", l: "Mkt Cap", sortable: true },
];

// dates follow the device locale; fall back to en-GB (dd/mm/yy) when unknown
export const DATE_LOCALE: string[] =
  typeof navigator !== "undefined" && navigator.languages?.length
    ? [...navigator.languages, "en-GB"]
    : ["en-GB"];

export const fmtMc = (m: number | null): string =>
  m == null ? "—" : m >= 1e6 ? "$" + (m / 1e6).toFixed(2) + "T" : m >= 1e3 ? "$" + (m / 1e3).toFixed(1) + "B" : "$" + Math.round(m) + "M";

// Sub-cent quotes get 4dp, matching what the pipeline now STORES (ci/keep.mjs `rndPx`).
// A flat 2dp here rendered a real $0.0034 delisting-track penny stock as "$0.00" — the
// storage fix alone was invisible to the reader, which is the only place it matters.
// Guarded by src/fmtPx.check.ts.
export const fmtPx = (v: number | null): string =>
  v == null ? "—" : "$" + (v >= 100 ? v.toFixed(0) : pxDp(v));
// Decimals for a dollar amount below $100: cents normally, 4dp under a cent so a sub-penny
// quote is not annihilated. Exported because StockModal formats 14 more prices (headline,
// chart axis, targets, OHLC, 52w range, forecast rows) through its own local helpers — they
// need the same rule, and a second private copy of it is how "$0.00" survived the first fix.
export const pxDp = (v: number): string => (v >= 0.01 || v <= -0.01 ? v.toFixed(2) : v.toFixed(4));

// A missing consensus gets NO rating class — it must not fall through to "h" and
// paint as a real Hold. Callers render the neutral "—" placeholder instead (ConsPill).
export function consClass(c: string | null | undefined): string {
  if (c == null || c === "") return "";
  c = c.toLowerCase();
  if (c.includes("strongbuy")) return "sb";
  if (c.includes("strongsell")) return "ss";
  if (c.includes("buy")) return "b";
  if (c.includes("sell")) return "s";
  return "h";
}

export function consLabel(c: string | null | undefined): string {
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
  sectors: string[]; // selected sectors (empty = all)
  sectorNot: boolean; // true = exclude the selected sectors instead of only-showing them
  consensuses: string[]; // selected consensus ratings (empty = all)
  cap: number;
}

export function passes(s: Stock, state: FilterState): boolean {
  if (state.q) {
    const q = state.q.toLowerCase();
    if (!((s.t || "").toLowerCase().includes(q) || (s.n || "").toLowerCase().includes(q))) return false;
  }
  if (state.sectors.length && state.sectors.includes(s.sec) === state.sectorNot) return false;
  if (state.cap && (s.mc == null || s.mc < state.cap)) return false;
  // Consensus is a membership test over KNOWN ratings only: a row whose rating the feed
  // omitted (con null/"") is KEPT, not dropped, so it can't blink out of the table for a
  // refresh cycle. Its cell renders "—", so it never reads as a match for the selection.
  if (state.consensuses.length && s.con != null && s.con !== "" && !state.consensuses.includes(s.con)) return false;
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
  // Written by the refresh scripts on every run but previously undeclared — the same
  // "type lies about the data" class as `con: string` did. Declared so a reader can see
  // they exist; both are pipeline bookkeeping and nothing in the UI should render them.
  ls?: string; // last seen in the dynamic screener pull (ISO). FROZEN while a ticker is off-pull.
  ea?: string; // last enrich attempt (ISO) — drives the AI/chg refresh rotation, see ci/refresh-data-ci.mjs
  ba?: string; // last getData backfill attempt (ISO) — drives the keep-set rotation, same reason
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

// A metric APPEARING or DISAPPEARING is a real change. The New Arrivals change row used to
// require both sides non-null, so a stock losing its Smart Score / AI score showed nothing —
// silently, exactly when it mattered. "—" marks the missing side and the direction is null,
// because up/down against an absent value is meaningless. Two nulls, or an equal pair, is no
// change. Guarded by src/metricChange.check.ts.
export function metricChange(o: number | null | undefined, n: number | null | undefined):
  { o: string; n: string; dir: "up" | "down" | null } | null {
  const a = o ?? null;
  const b = n ?? null;
  if (a === b) return null; // includes both-null
  return {
    o: a == null ? "—" : String(a),
    n: b == null ? "—" : String(b),
    dir: a == null || b == null ? null : b > a ? "up" : "down",
  };
}

export function sortRows(rows: Stock[], sort: keyof Stock, dir: number): Stock[] {
  return [...rows].sort((a, b) => {
    // Consensus sorts on the analyst mix, not the rating string: desc = most buys,
    // then fewest holds, then fewest sells. asc mirrors all three. Never reads `con`,
    // so a null rating can't throw or skew the ordering key.
    // It does NOT follow that an unrated row sorts last: `con` and the b/h/s
    // distribution are independent fields, so a row can have con: null with a real,
    // non-zero mix (refresh-data-ci.mjs reads analystConsensus and distribution
    // separately; keep.mjs can miss CON_NAME while still copying nB/nH/nS). Such a
    // row sorts by its real mix and displays "—" — deliberate, since the analyst
    // counts are genuine data even when the label is missing. Don't "fix" this to
    // compare the rating string.
    if (sort === "con") return dir * (a.b - b.b || b.h - a.h || b.s - a.s);
    const x = a[sort];
    const y = b[sort];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "string") return dir * x.localeCompare(y as string);
    return dir * ((x as number) - (y as number));
  });
}
