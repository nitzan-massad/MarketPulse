// "Track this stock" rows that are live before they are bundled. The lite run
// (track-requests.yml) writes RTDB `trackedRows/<KEY>` = { row, forecast, bullbear, pe, trackedAt,
// asOf }, each payload the JSON TEXT of the file CI would commit (RTDB drops nulls and turns arrays
// into objects, and `ss: null` is data). site.yml later folds them into stocks.json and clears
// them. Pure and dependency-free, so trackedRows.check.ts runs without React or Firebase; the
// one-time RTDB read and the store live in stocks.ts.
import type { Stock } from "./types";

export type TrackedKind = "forecast" | "bullbear" | "pe";
export interface TrackedStock {
  row: Stock;
  forecast: unknown;
  bullbear: unknown;
  pe: unknown;
}

const parse = (v: unknown): unknown => {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** RTDB `trackedRows` snapshot → ticker → row + parsed payloads. The bundle wins: a ticker already
 *  in stocks.json is skipped (folded, and its public/ files are the deployed truth). Junk — a row
 *  that doesn't parse or names another ticker than its key — is skipped too. Keys hold "_" for ".". */
export function parseTracked(raw: unknown, bundled: ReadonlySet<string>): Map<string, TrackedStock> {
  const out = new Map<string, TrackedStock>();
  if (!raw || typeof raw !== "object") return out;
  for (const [k, e] of Object.entries(raw as Record<string, Record<string, unknown> | null>)) {
    const t = k.replace(/_/g, ".");
    const row = parse(e?.row) as Stock | null;
    if (!row || typeof row !== "object" || row.t !== t || bundled.has(t)) continue;
    out.set(t, { row, forecast: parse(e!.forecast), bullbear: parse(e!.bullbear), pe: parse(e!.pe) });
  }
  return out;
}

/** The list every section reads: the bundle, then tracked rows it doesn't have. Same array back
 *  when there are none, so a no-op merge doesn't re-render anything. */
export function mergeTracked(bundled: Stock[], tracked: Map<string, TrackedStock>): Stock[] {
  return tracked.size ? [...bundled, ...[...tracked.values()].map((e) => e.row)] : bundled;
}
