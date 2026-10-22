// CNBC-first quotes with a Finnhub fallback — the pure half (no React, no fetch), unit-checked
// in quotes.check.ts. The Worker (worker/cnbc.js) does the CNBC string parsing; this module
// decides when CNBC is trusted, when to fall back, and how the two sources merge so a symbol
// is only ever priced by ONE of them at a time (two sources flip-flopping around the ±5%
// alert band would fire false alerts). No `import.meta` here: the check compiles to CommonJS.

/** One CNBC quote as the Worker serves it (see worker/cnbc.js parseQuote). */
export interface CnbcQuote {
  px: number; // regular-session last (off-hours: the last close)
  chg: number | null; // $ change vs prior close
  pct: number | null; // Day %
  pc: number | null; // prior close (px - chg)
  day: string | null; // YYYY-MM-DD of px
  o: number | null;
  h: number | null;
  l: number | null;
  ext: { type: "pre" | "post"; px: number; chg: number | null; pct: number | null; t: number | null } | null;
  name: string | null;
  mc: number | null; // $ millions
  hi52: number | null;
  lo52: number | null;
  pe: number | null;
  fpe: number | null;
  eps: number | null;
  beta: number | null;
  vol10: number | null;
}
export type CnbcMap = Record<string, CnbcQuote | null>;

// Same canon as worker/cnbc.js normSym: BRK-B / brk_b -> BRK.B. null = not a US ticker.
export function normSym(s: string): string | null {
  const t = s.trim().toUpperCase().replace(/[-/_]/g, ".");
  return /^[A-Z][A-Z0-9]{0,5}(\.[A-Z]{1,2})?$/.test(t) ? t : null;
}

// ---- US session clock (America/New_York) --------------------------------------

export type Session = "pre" | "regular" | "post" | "closed";
export interface EtClock {
  ymd: string; // YYYY-MM-DD in New York
  mins: number; // minutes since NY midnight
  weekend: boolean;
}

export function etClock(d: Date = new Date()): EtClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    mins: (parseInt(get("hour"), 10) % 24) * 60 + parseInt(get("minute"), 10),
    weekend: wd === "Sat" || wd === "Sun",
  };
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
// ponytail: no market-holiday calendar (same ceiling as useLiveQuotes' marketOpen) — a holiday
// reads as a session whose quotes never move; the staleness probe below then hands it to
// Finnhub, which is equally quiet. Add a holiday list if that ever matters.
export function sessionOf(c: EtClock): Session {
  if (c.weekend) return "closed";
  if (c.mins >= 4 * 60 && c.mins < OPEN) return "pre";
  if (c.mins >= OPEN && c.mins < CLOSE) return "regular";
  if (c.mins >= CLOSE && c.mins < 20 * 60) return "post";
  return "closed";
}

/** Poll cadence: fast in the session, slow around it, one fetch (null) when closed. */
export function pollMs(s: Session): number | null {
  return s === "regular" ? 20_000 : s === "pre" || s === "post" ? 60_000 : null;
}
// While closed, CNBC is still asked now and then — cheap (the Worker caches) and it catches
// the pre-market open without a separate clock.
export const CLOSED_POLL_MS = 30 * 60_000;

// ---- trusting CNBC -----------------------------------------------------------

// Every poll also asks for SENTINEL: it trades every second of the session, so its date is
// the staleness probe. Judging the batch instead misfires on a small one — a watchlist of
// two sub-$1 names that haven't traded by 9:45 looks exactly like a frozen CNBC.
export const SENTINEL = "SPY";

// A response is stale when, well into the regular session, CNBC's quote is not dated today —
// it is serving a frozen cache. Judged on the sentinel; without one (CNBC lacks it), on the
// batch: stale only if no quote at all is dated today.
export const STALE_GRACE_MIN = 15;
export function batchStale(quotes: CnbcMap, c: EtClock): boolean {
  if (sessionOf(c) !== "regular" || c.mins < OPEN + STALE_GRACE_MIN) return false;
  const ref = quotes[SENTINEL];
  const qs = ref ? [ref] : Object.values(quotes).filter((q): q is CnbcQuote => q != null);
  return qs.length > 0 && !qs.some((q) => q.day === c.ymd);
}

// Source switch. Two failed polls in a row hand everything to Finnhub; while there, CNBC is
// re-probed every PROBE_MS and one good answer switches back.
export const FAILS_TO_SWITCH = 2;
export const PROBE_MS = 5 * 60_000;
export interface SourceState {
  source: "cnbc" | "finnhub";
  fails: number;
}
export const INITIAL_SOURCE: SourceState = { source: "cnbc", fails: 0 };

/** May a poll run ahead of the cadence (new symbol, request queued behind an in-flight one)?
 *  Only while CNBC is healthy: after a failure the Worker answers 502 from memory for its
 *  TTL, so an early poll would turn ONE failure into the second strike that flips to Finnhub. */
export const earlyPollOk = (s: SourceState): boolean => s.source === "cnbc" && s.fails === 0;

/** Delay to the next CNBC poll: the slow re-probe while Finnhub carries, else the cadence. */
export function nextPollMs(s: SourceState, sess: Session): number {
  return s.source === "finnhub" ? PROBE_MS : pollMs(sess) ?? CLOSED_POLL_MS;
}

// Most symbols CNBC is asked for per poll (the Worker caps a request at 300).
export const CNBC_MAX = 300;
/** Wanted tickers (watchlist first) -> the CNBC request: normalized, deduped, capped, plus
 *  the staleness SENTINEL (inside the cap). Nothing wanted -> nothing to ask. */
export function cnbcRequest(wanted: string[]): string[] {
  const out: string[] = [];
  for (const t of wanted) {
    const k = normSym(t);
    if (k != null && !out.includes(k)) out.push(k);
    if (out.length >= CNBC_MAX - 1) break;
  }
  if (out.length && !out.includes(SENTINEL)) out.push(SENTINEL);
  return out;
}

/** True when every quote in `next` already equals `prev`'s — the poll changed nothing. */
export function sameQuotes(prev: CnbcMap, next: CnbcMap): boolean {
  return Object.keys(next).every((k) => k in prev && JSON.stringify(prev[k]) === JSON.stringify(next[k]));
}

/** A /quotes response body -> its quotes, or null when this poll counts as a failure
 *  (no/garbled body, or a stale batch — see batchStale). */
export function readQuotes(body: unknown, c: EtClock): CnbcMap | null {
  const q = (body as { quotes?: unknown } | null)?.quotes;
  if (!q || typeof q !== "object" || Array.isArray(q)) return null;
  return batchStale(q as CnbcMap, c) ? null : (q as CnbcMap);
}
// Returns `s` itself when nothing changed, so a healthy poll doesn't re-render the app.
export function nextSource(s: SourceState, ok: boolean): SourceState {
  if (ok) return s.source === "cnbc" && s.fails === 0 ? s : { source: "cnbc", fails: 0 };
  const fails = s.fails + 1;
  return { source: fails >= FAILS_TO_SWITCH ? "finnhub" : s.source, fails };
}

/** Symbols Finnhub must cover: everything once CNBC is down, else only what CNBC lacks. */
export function finnhubSymbols(wanted: string[], cnbc: CnbcMap, s: SourceState): string[] {
  if (s.source === "finnhub") return wanted;
  return wanted.filter((t) => {
    const k = normSym(t);
    return k == null || (k in cnbc && cnbc[k] == null);
  });
}

/** CNBC quote for an app ticker (keys are normalized), or null. */
export function cnbcFor(cnbc: CnbcMap, t: string): CnbcQuote | null {
  const k = normSym(t);
  return k ? cnbc[k] ?? null : null;
}

// Final per-symbol price + Day%: CNBC when it is the active source and has the symbol, else
// Finnhub's — and while Finnhub has not priced a symbol yet (seeding takes ~1.2s a symbol,
// and Finnhub never runs off-hours) CNBC's last-known quote stands in rather than the hours-
// old snapshot, whose jump could cross the ±5% alert band. Price and Day% always come from
// the same source for a symbol. `last` holds each symbol's last NON-null CNBC quote, so a
// symbol CNBC stops pricing (realTime flip, dropped row) keeps its last price as the stand-in
// too, instead of falling to the snapshot.
export function mergeQuotes(
  tickers: Iterable<string>,
  cnbc: CnbcMap,
  s: SourceState,
  fhPrice: Record<string, number>,
  fhPct: Record<string, number>,
  last: CnbcMap = {},
): { price: Record<string, number>; pct: Record<string, number> } {
  const price: Record<string, number> = {};
  const pct: Record<string, number> = {};
  for (const t of tickers) {
    const cur = cnbcFor(cnbc, t);
    const q = cur && s.source === "cnbc" ? cur : fhPrice[t] == null ? cur ?? cnbcFor(last, t) : null;
    if (q) {
      price[t] = q.px;
      if (q.pct != null) pct[t] = q.pct;
    } else if (fhPrice[t] != null) {
      price[t] = fhPrice[t];
      if (fhPct[t] != null) pct[t] = fhPct[t];
    }
  }
  return { price, pct };
}

/** The extended-hours trade worth showing now: only one from TODAY's pre-market during the
 *  pre-market, or today's after-hours during after-hours. CNBC keeps yesterday's after-hours
 *  attached into the next morning (and the next session's open), which must not read as current. */
export function extNow(ext: CnbcQuote["ext"], c: EtClock): CnbcQuote["ext"] {
  if (!ext || ext.t == null || ext.type !== sessionOf(c)) return null;
  return etClock(new Date(ext.t)).ymd === c.ymd ? ext : null;
}

// ---- stock modal: CNBC fields first, Finnhub per field ---------------------------

export interface FhQuote {
  c: number | null;
  dp: number | null;
  o: number | null;
  h: number | null;
  l: number | null;
  pc: number | null;
}
export interface FhMetric {
  hi52: number | null;
  lo52: number | null;
  pe: number | null;
  fwdPe: number | null;
  epsTtm: number | null;
  beta: number | null;
  avgVol3M: number | null;
  avgVol10D: number | null;
}
export interface FhProfile {
  name: string | null;
  sector: string | null;
  mktCap: number | null;
}

// Does the modal still need Finnhub's /quote? Only when CNBC has no quote, or is missing
// open/high/low (always so outside the session — CNBC zeroes them).
export const needsFhQuote = (q: CnbcQuote | null): boolean => !q || q.o == null || q.h == null || q.l == null;

const pick = <T>(a: T | null | undefined, b: T | null | undefined): T | null => a ?? b ?? null;

/** A single quote CNBC is still serving from a previous day, well into the session (the
 *  modal's own staleness test — the hook's is batchStale over the poll, with the sentinel). */
export const quoteStale = (q: CnbcQuote | null, c: EtClock): boolean =>
  q != null && batchStale({ q }, c);

// `stale`: the CNBC quote is a frozen previous day — its live half (price, %, prior close,
// open/high/low) gives way to Finnhub; its fundamentals still stand.
export function mergeModal(
  q: CnbcQuote | null,
  fq: FhQuote | null,
  fm: FhMetric | null,
  fp: FhProfile | null,
  stale = false,
): { quote: FhQuote; metric: FhMetric; profile: FhProfile } {
  // Price, % and prior close travel together from one source, so the 1D baseline and the
  // headline % can never disagree.
  const lq = stale ? null : q;
  const head = lq ? { c: lq.px, dp: lq.pct, pc: lq.pc } : { c: fq?.c ?? null, dp: fq?.dp ?? null, pc: fq?.pc ?? null };
  return {
    quote: { ...head, o: pick(lq?.o, fq?.o), h: pick(lq?.h, fq?.h), l: pick(lq?.l, fq?.l) },
    metric: {
      hi52: pick(q?.hi52, fm?.hi52),
      lo52: pick(q?.lo52, fm?.lo52),
      // CNBC's P/E and EPS are USD per listed share, so ADRs (TSM) come out right where
      // Finnhub's are in the home currency. A non-positive P/E/EPS means "no earnings".
      pe: pick(q?.pe != null && q.pe > 0 ? q.pe : null, fm?.pe),
      fwdPe: pick(q?.fpe != null && q.fpe > 0 ? q.fpe : null, fm?.fwdPe),
      epsTtm: pick(q?.eps, fm?.epsTtm),
      beta: pick(q?.beta, fm?.beta),
      avgVol3M: fm?.avgVol3M ?? null, // CNBC has no 3-month average
      avgVol10D: pick(q?.vol10, fm?.avgVol10D),
    },
    profile: {
      name: pick(q?.name, fp?.name),
      sector: fp?.sector ?? null, // CNBC has no sector
      mktCap: pick(q?.mc, fp?.mktCap),
    },
  };
}

// ---- search -------------------------------------------------------------------

export interface SearchHit {
  t: string;
  n: string;
}
// CNBC's issue types worth offering: common stock, ETFs, REITs (CSRT — O, KIM, DLR…) and
// closed-end funds (CF). CNBC prices all of them through /quotes.
const SEARCH_TYPES = new Set(["STOCK", "ETF", "CSRT", "CF"]);

const searchable = (r: Record<string, unknown> | null | undefined): r is Record<string, unknown> =>
  typeof r?.symbolName === "string" && !!r.symbolName && r.countryCode === "US" && SEARCH_TYPES.has(r.issueType as string);

/** How many eligible US rows CNBC matched, BEFORE the in-set filter. 0 = CNBC found nothing
 *  usable (ask Finnhub); >0 with no hits = every match is already ranked (Finnhub won't help). */
export function cnbcSearchMatched(body: unknown): number {
  return Array.isArray(body) ? (body as Array<Record<string, unknown>>).filter(searchable).length : 0;
}

// CNBC symlookup body -> US stock/ETF/REIT/fund hits not already in the ranked set. The first array
// element is a metadata header, skipped by the shape check. Dotted class shares are left
// out, as the Finnhub path always did: RTDB keys (watchlist) cannot hold a "."
export function cnbcSearchHits(body: unknown, inSet: Set<string>, max = 5): SearchHit[] {
  if (!Array.isArray(body)) return [];
  const out: SearchHit[] = [];
  for (const r of body as Array<Record<string, unknown>>) {
    if (!searchable(r)) continue;
    const t = r.symbolName as string;
    if (t.includes(".") || inSet.has(t) || out.some((h) => h.t === t)) continue;
    out.push({ t, n: typeof r.companyName === "string" ? r.companyName : "" });
    if (out.length >= max) break;
  }
  return out;
}
