import { useEffect, useRef, useState } from "react";

export type LiveStatus = "off" | "closed" | "live" | "error";

// US equities regular session: Mon–Fri 9:30–16:00 America/New_York.
// ponytail: market-holiday calendar omitted — on a holiday it reads "live" but
// Finnhub just returns the last close, so Day% matches the snapshot. Add a
// holiday list here if false "open" readings ever matter.
function marketOpen(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (get("weekday") === "Sat" || get("weekday") === "Sun") return false;
  const mins = parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

const WATCH_CAP = 40; // top-N rows polled per cycle (60/min Finnhub limit; ~50-symbol practical ceiling)
const CYCLE_MS = 60_000;
const STAGGER_MS = 250;

// Polls Finnhub /quote for the first WATCH_CAP tickers, returns a ticker -> day%
// map. Live only during market hours; degrades to the snapshot otherwise.
export function useLiveQuotes(tickers: string[], apiKey: string | null, enabled: boolean) {
  const [live, setLive] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<LiveStatus>("off");
  const watch = tickers.slice(0, WATCH_CAP);
  const watchKey = watch.join(",");
  const watchRef = useRef<string[]>(watch);
  watchRef.current = watch;

  useEffect(() => {
    if (!enabled || !apiKey) {
      setStatus("off");
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function cycle() {
      if (cancelled) return;
      if (!marketOpen()) {
        setStatus("closed");
        timer = setTimeout(cycle, CYCLE_MS);
        return;
      }
      setStatus("live");
      for (const sym of watchRef.current) {
        if (cancelled) return;
        try {
          const r = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`,
          );
          if (r.status === 401 || r.status === 403) {
            if (!cancelled) setStatus("error");
            return;
          }
          const j = await r.json();
          if (j && typeof j.dp === "number" && !cancelled) {
            setLive((prev) => ({ ...prev, [sym]: j.dp }));
          }
        } catch {
          /* transient network — skip this symbol this cycle */
        }
        await new Promise((res) => setTimeout(res, STAGGER_MS));
      }
      if (!cancelled) timer = setTimeout(cycle, CYCLE_MS);
    }

    cycle();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, apiKey, watchKey]);

  return { live, status };
}
