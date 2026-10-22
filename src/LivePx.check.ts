// Server-render self-check for the two live-price UI pieces that are pure functions of props +
// context: LivePx (every Price cell) and Masthead's live badge. react-dom/server renders them
// to a string in plain Node — no DOM, no test framework (mirrors the other *.check.ts files).
//
// Guards: a live CNBC price (1270.75, parsed from "1,270.75") replaces the snapshot and is
// formatted by fmtPx — never "$1"; no live quote falls back to the snapshot; `track` is the only
// thing that registers a cell for on-screen quoting; and each LiveStatus gets its own badge
// label (backup / pre-market / after hours are new with the CNBC source).
//
// Run (from repo root):
//   npx tsc src/LivePx.check.ts --outDir /tmp/lpx --module commonjs --target es2020 \
//     --lib es2020,dom --jsx react-jsx --strict --esModuleInterop --resolveJsonModule --skipLibCheck \
//   && cp -r src/data /tmp/lpx/ 2>/dev/null; node /tmp/lpx/LivePx.check.js
//   (or just `npm test`)
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveCtx, LivePx, type LiveCtxValue } from "./LivePx";
import Masthead from "./components/Masthead";
import type { LiveStatus } from "./useLiveQuotes";

let failed = 0;
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.error(`FAIL ${label}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const text = (html: string): string => html.replace(/<[^>]+>/g, "");
function px(ctx: LiveCtxValue | null, t: string, snap: number | null | undefined, track = false): string {
  const cell = createElement(LivePx, { t, px: snap, track });
  return text(renderToStaticMarkup(ctx ? createElement(LiveCtx.Provider, { value: ctx }, cell) : cell));
}

// ---- LivePx ---------------------------------------------------------------------------------
const live: LiveCtxValue = { price: { LLY: 1270.75, AAPL: 343.99, CRIS: 0.392, SUB: 0.0034 } };
eq("live price > $1,000 (CNBC '1,270.75') replaces the snapshot, never $1", px(live, "LLY", 1000), "$1271");
eq("live price under $100 keeps cents", px(live, "CRIS", 0.5), "$0.39");
eq("live sub-penny keeps 4dp", px(live, "SUB", 0.01), "$0.0034");
eq("live price over $100 rounds to dollars", px(live, "AAPL", 300), "$344");
eq("no live quote -> snapshot price", px(live, "GETY", 0.0193), "$0.02");
eq("no live quote, no snapshot -> dash", px(live, "NONE", null), "—");
eq("undefined snapshot -> dash", px(live, "NONE", undefined), "—");
eq("no provider (live off) -> snapshot", px(null, "LLY", 1000), "$1000");
eq("live off: empty price map -> snapshot", px({ price: {} }, "LLY", 1000), "$1000");

const seen: string[] = [];
const observe = (t: string) => {
  seen.push(t);
  return () => {};
};
px({ price: {}, observe }, "TRK", 5, true);
px({ price: {}, observe }, "NOTRK", 5, false);
eq("track=true registers the ticker with observe; track=false does not", seen, ["TRK"]);
eq("track=true without an observe (provider-less) still renders", px({ price: {} }, "X", 5, true), "$5.00");

// ---- Masthead live badge ------------------------------------------------------------------------
function badge(liveStatus: LiveStatus, hasKey = true): { label: string; cls: string; title: string } {
  const html = renderToStaticMarkup(createElement(Masthead, { poolN: 10, liveStatus, hasKey, onLive: () => {} }));
  const m = /<button[^>]*class="([^"]*)"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/button>/.exec(html);
  return m ? { cls: m[1], title: m[2], label: m[3] } : { cls: "", title: "", label: `no badge in: ${html}` };
}
const labels: Array<[LiveStatus, boolean, string]> = [
  ["live", true, "● Live"],
  ["backup", true, "● Live (backup)"],
  ["pre", true, "◐ Pre-market"],
  ["post", true, "◐ After hours"],
  ["closed", true, "● Market closed"],
  ["connecting", true, "◐ Connecting…"],
  ["error", true, "⚠ Live — add key"],
  ["error", false, "⚠ Live — add key"],
  ["off", true, "○ Live off"],
  ["off", false, "⚡ Go live"],
];
for (const [s, k, want] of labels) eq(`badge ${s}${k ? "" : " (no key)"} -> ${want}`, badge(s, k).label, want);
eq("CNBC statuses need no key: live/pre/post/closed identical without one", (["live", "pre", "post", "closed"] as LiveStatus[]).map((s) => badge(s, false).label), ["● Live", "◐ Pre-market", "◐ After hours", "● Market closed"]);
eq("badge class carries the status (CSS hooks on it)", ["live", "backup", "pre", "post", "error"].map((s) => badge(s as LiveStatus).cls), [
  "livebadge live", "livebadge backup", "livebadge pre", "livebadge post", "livebadge error",
]);
eq("error title explains the Finnhub key", /Finnhub backup needs a free API key/.test(badge("error").title), true);
eq("non-error title names CNBC + Finnhub backup", /via CNBC, with Finnhub as the backup/.test(badge("live").title), true);

if (failed) throw new Error(`${failed} LivePx/Masthead check(s) failed`);
console.log("\nall LivePx/Masthead checks passed");
