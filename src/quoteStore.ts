// Every CNBC quote the page already holds, by normalized symbol — so the stock modal opens on
// data the table's live poll (or a search prefetch) fetched moments ago instead of asking the
// Worker again (a cold CNBC answer is 0.3-1.6 s). Plain module state, shared by both chunks.
import { etClock, INITIAL_SOURCE, nextPollMs, normSym, sessionOf, type CnbcMap, type CnbcQuote } from "./quotes";

const store = new Map<string, { q: CnbcQuote; at: number }>();

/** Record a poll's quotes (nulls — symbols CNBC lacks — are skipped). */
export function putQuotes(quotes: CnbcMap, at = Date.now()): void {
  for (const [k, q] of Object.entries(quotes)) if (q) store.set(k, { q, at });
}

/** A held quote still fresh for the current session's cadence (20 s in the session, 60 s
 *  around it, 30 min closed — the table's own poll interval, plus a little slack), or null. */
export function freshQuote(ticker: string, now = Date.now()): CnbcQuote | null {
  const k = normSym(ticker);
  const e = k ? store.get(k) : undefined;
  if (!e) return null;
  return now - e.at <= nextPollMs(INITIAL_SOURCE, sessionOf(etClock(new Date(now)))) + 5_000 ? e.q : null;
}
