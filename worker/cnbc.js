// CNBC's public quote service: the app's primary price source (Finnhub is the fallback).
// Undocumented — the same endpoint cnbc.com's own pages call — so every field arrives as a
// display string ("1,270.75", "+1.32%", "UNCH", "4.06M", "0.00" for an empty open) and is
// parsed here, once, into plain numbers. Anything that fails to parse is null, and a quote
// without a usable price is null as a whole: the client treats null as "use Finnhub".
// Pure (no Workers globals), so ci/test-cnbc-worker.mjs imports it straight into Node.

export const CNBC_QUOTE =
  "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol" +
  "?requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1&symbols=";
// CNBC answers 403 to non-browser user agents.
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
export const MAX_SYMBOLS = 300; // per /quotes request
export const CHUNK = 100; // symbols per CNBC call (keeps the URL short)

// "1,270.75" / "+1.32%" / "$4" -> number; anything else (incl. "UNCH", "", "N/A") -> null.
export function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,%+$\s]/g, "");
  if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Change fields say "UNCH" for an unchanged day — that is 0, not missing.
export const toChg = (v) => (typeof v === "string" && v.trim().toUpperCase() === "UNCH" ? 0 : toNum(v));

// "4.06M" / "890.997B" / "5.02T" / "61.1K" / "1,234" -> number.
export function toScaled(v) {
  if (typeof v !== "string") return toNum(v);
  const m = /^([-+]?[\d,]*\.?\d+)\s*([KMBT])?$/i.exec(v.trim());
  if (!m) return null;
  const n = toNum(m[1]);
  if (n == null) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || "").toUpperCase()] ?? 1;
  return n * mult;
}

// A placeholder 0 ("0.00" open/high/low outside the session) is not a price.
const pos = (v) => {
  const n = toNum(v);
  return n != null && n > 0 ? n : null;
};

// Cents are enough below 4dp of noise: px - change re-derives the prior close exactly.
const round4 = (n) => Math.round(n * 1e4) / 1e4;

// Request-side symbol canon: upper case, class-share separators as a dot (BRK-B, BRK/B,
// BRK_B -> BRK.B) — CNBC only knows the dotted form. Returns null for anything that is
// not plausibly a US ticker, so junk never reaches CNBC.
export function normSym(s) {
  if (typeof s !== "string") return null;
  const t = s.trim().toUpperCase().replace(/[-/_]/g, ".");
  return /^[A-Z][A-Z0-9]{0,5}(\.[A-Z]{1,2})?$/.test(t) ? t : null;
}

// "A,b,BRK-B,A" -> ["A","B","BRK.B"]; null when empty, malformed or over the cap.
export function parseSymbols(param) {
  if (typeof param !== "string" || !param) return null;
  const out = [];
  for (const raw of param.split(",")) {
    const s = normSym(raw);
    if (!s) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out.length && out.length <= MAX_SYMBOLS ? out : null;
}

// One raw CNBC row -> the app's quote, or null when CNBC has no usable real-time price.
//   px    regular-session last trade (off-hours: the last close)
//   chg   $ change vs the prior close; pct its %; pc = px - chg, the true prior close.
//         NOT `previous_day_closing`: outside the session CNBC sets that equal to `last`.
//   day   YYYY-MM-DD (ET) of `last` — the staleness probe
//   o/h/l null outside the session (CNBC sends "0.00")
//   ext   pre/after-hours trade, display only (CNBC rounds it to cents); `t` lets the client
//         drop a stale one (yesterday's after-hours is still attached next morning)
export function parseQuote(row) {
  if (!row || row.code !== 0) return null;
  if (row.realTime !== "true") return null; // delayed / OTC-mapped (GETY -> GETYQ) -> Finnhub
  if (row.currencyCode && row.currencyCode !== "USD") return null;
  const px = pos(row.last);
  if (px == null) return null;
  const chg = toChg(row.change);
  const pct = toChg(row.change_pct);
  const pc = chg != null && px - chg > 0 ? round4(px - chg) : null;
  // Off-hours `last_time` is a bare date; in the session it is a full ET timestamp
  // ("2026-10-22T09:32:54.175-0400"). Either way the date is its first 10 characters.
  const day = typeof row.last_time === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(row.last_time)?.[1] ?? null : null;
  let ext = null;
  const x = row.ExtendedMktQuote;
  const extType = x?.type === "PRE_MKT" ? "pre" : x?.type === "POST_MKT" ? "post" : null;
  if (extType && pos(x.last) != null) {
    const t = Date.parse(x.last_time);
    ext = { type: extType, px: pos(x.last), chg: toChg(x.change), pct: toChg(x.change_pct), t: Number.isFinite(t) ? t : null };
  }
  const mcap = toScaled(row.mktcapView);
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : null;
  return {
    px,
    chg,
    pct,
    pc,
    day,
    o: pos(row.open),
    h: pos(row.high),
    l: pos(row.low),
    ext,
    name,
    mc: mcap != null && mcap > 0 ? round4(mcap / 1e6) : null, // $ millions, like the DB `mc`
    hi52: pos(row.yrhiprice),
    lo52: pos(row.yrloprice),
    pe: toNum(row.pe),
    fpe: toNum(row.fpe),
    eps: toNum(row.eps),
    beta: toNum(row.beta),
    vol10: toScaled(row.tendayavgvol),
  };
}

// CNBC response body -> { SYMBOL: rawRow }. Throws on a reshaped envelope so the caller
// answers 502 and the client falls back, instead of reporting every symbol missing.
export function rowsBySymbol(body) {
  const rows = body?.FormattedQuoteResult?.FormattedQuote;
  if (!Array.isArray(rows)) throw new Error("cnbc: unexpected envelope");
  const out = {};
  for (const r of rows) if (typeof r?.symbol === "string") out[r.symbol.toUpperCase()] = r;
  return out;
}
