import { useEffect, useRef, useState } from "react";

export type LiveStatus = "off" | "closed" | "live" | "error" | "throttled";

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

const WATCH_CAP = 40; // top-N rows polled per cycle (watchlist-first, see App.tsx)
const CYCLE_MS = 60_000;
// 1.2s between requests => 60000/1200 = 50 req/min, comfortably under Finnhub's
// free-tier 60/min. A clean cycle polls WATCH_CAP=40 symbols in ~48s then idles
// ~60s before repeating, so the sustained rate never reaches the limit (the old
// 250ms => 240/min burst is what tripped the 429s past ~symbol 25).
const STAGGER_MS = 1_200;
// 429 (rate-limit) recovery: back off instead of skipping. Honor Retry-After when
// present, else this fixed pause; give up on a symbol after MAX_429_STRIKES
// consecutive 429s and surface a truthful "throttled" status.
const BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15_000; // clamp so a hostile/huge Retry-After can't freeze the loop
const MAX_429_STRIKES = 3;

// Retry-After -> milliseconds to wait. Finnhub sends integer seconds. Exported for
// the check. ponytail: HTTP-date form of Retry-After is unsupported (Finnhub never
// sends it) and falls back to the fixed backoff.
export function backoffMsFromHeader(retryAfter: string | null): number {
  const secs = retryAfter ? parseInt(retryAfter, 10) : NaN;
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
  return BACKOFF_MS;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Polls Finnhub /quote for the first WATCH_CAP tickers, returns a ticker -> day%
// map. Live only during market hours; degrades to the snapshot otherwise.
export function useLiveQuotes(tickers: string[], apiKey: string | null, enabled: boolean) {
  const [live, setLive] = useState<Record<string, number>>({});
  const [price, setPrice] = useState<Record<string, number>>({}); // absolute last price (Finnhub `c`)
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
      // Optimistic each cycle: a transient throttle from last cycle recovers here.
      setStatus("live");
      const syms = watchRef.current; // already watchlist-first (App.tsx) — never reordered
      let i = 0;
      let strikes = 0; // consecutive 429s on syms[i]
      while (i < syms.length) {
        if (cancelled) return;
        const sym = syms[i];
        try {
          const r = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${apiKey}`,
          );
          if (r.status === 401 || r.status === 403) {
            if (!cancelled) setStatus("error");
            return;
          }
          if (r.status === 429) {
            // Rate-limited: back off instead of treating it as a normal miss.
            // Sustained 429s on one symbol mean the key is exhausted — stop
            // hammering, tell the truth, and let the next cycle retry.
            if (++strikes >= MAX_429_STRIKES) {
              if (!cancelled) setStatus("throttled");
              break;
            }
            await sleep(backoffMsFromHeader(r.headers.get("Retry-After")));
            continue; // retry the SAME symbol — don't advance past a watched ticker
          }
          const j = await r.json();
          if (j && !cancelled) {
            if (typeof j.dp === "number") setLive((prev) => ({ ...prev, [sym]: j.dp }));
            if (typeof j.c === "number") setPrice((prev) => ({ ...prev, [sym]: j.c }));
          }
        } catch {
          /* transient network — skip this symbol this cycle */
        }
        strikes = 0;
        i++;
        await sleep(STAGGER_MS);
      }
      if (!cancelled) timer = setTimeout(cycle, CYCLE_MS);
    }

    cycle();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, apiKey, watchKey]);

  return { live, price, status };
}
