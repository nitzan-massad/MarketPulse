import { normSym } from "./quotes";
import { WORKER_URL } from "./workerUrl";

// Hovering a row for a moment warms its 1D chart in the Worker's cache (60 s), so the click
// that follows finds it ready instead of waiting ~0.5-1 s on a cold CNBC call. Intent-gated
// (HOVER_MS) so a mouse sweeping across the table doesn't fire a request per row; once per
// ticker per minute. Fire-and-forget: a failure only means the click does the work.
const HOVER_MS = 150;
const WARM_TTL_MS = 60_000;
const warmedAt = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;

function warm(ticker: string): void {
  const sym = normSym(ticker);
  if (!sym || Date.now() - (warmedAt.get(sym) ?? 0) < WARM_TTL_MS) return;
  warmedAt.set(sym, Date.now());
  void fetch(`${WORKER_URL}/bars?symbol=${encodeURIComponent(sym)}&range=1D`).catch(() => {});
}

/** Spread onto a row/card: `<tr {...warmChart(s.t)}>`. */
export function warmChart(ticker: string) {
  return {
    onMouseEnter: () => {
      clearTimeout(timer);
      timer = setTimeout(() => warm(ticker), HOVER_MS);
    },
    onMouseLeave: () => clearTimeout(timer),
  };
}
