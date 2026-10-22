// "Track this stock" → start .github/workflows/track-requests.yml right away.
// No auth by design: the app only shows the button to signed-in users, and the lite run
// acts only on pending RTDB requests (which need sign-in to write), so a stray POST costs
// one ~30s no-op run. GH_TOKEN: fine-grained PAT, this repo only, Actions: read & write.
const DISPATCH =
  "https://api.github.com/repos/nitzan-massad/MarketPulse/actions/workflows/track-requests.yml/dispatches";

import { BROWSER_UA, CHUNK, CNBC_QUOTE, parseQuote, parseSymbols, rowsBySymbol } from "./cnbc.js";

// Finnhub free tier: 50 symbols on the one connection a key may hold.
const SYMBOL_CAP = 50;
const BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15_000;

// Each symbol is fetched from CNBC at most once per TTL per isolate, however many browsers
// that isolate serves, and concurrent misses share one CNBC call (`inflight`).
// ponytail: per-isolate, not global — busy traffic spread over many colos multiplies CNBC
// calls by the isolate count. caches.default keyed per symbol is the upgrade if CNBC ever
// pushes back; at this app's traffic one or two isolates serve everyone.
const QUOTE_TTL_MS = 20_000; // = the client's regular-session poll (src/quotes.ts pollMs)
const QUOTE_CACHE_MAX = 5_000; // bound memory against junk symbol lists
const quoteCache = new Map(); // SYMBOL -> { q: quote | null, at: ms }
const inflight = new Map(); // SYMBOL -> Promise of the CNBC call currently fetching it
// While CNBC is failing, answer 502 from memory for a TTL instead of retrying per request —
// hammering a CNBC that is blocking us would only deepen the block.
let failedUntil = 0;
const CNBC_TIMEOUT_MS = 5_000;

// Resolves to this chunk's { SYMBOL: quote | null }, also written to the cache.
async function fetchChunk(chunk, now) {
  const r = await fetch(CNBC_QUOTE + chunk.map(encodeURIComponent).join("|"), {
    headers: { "user-agent": BROWSER_UA, accept: "application/json" },
    // A stalled CNBC must fail, not hang: a hung call would pin its symbols in `inflight`
    // and never set failedUntil.
    signal: AbortSignal.timeout(CNBC_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`cnbc ${r.status}`);
  const rows = rowsBySymbol(await r.json());
  const got = {};
  for (const s of chunk) {
    got[s] = parseQuote(rows[s]);
    quoteCache.set(s, { q: got[s], at: now });
  }
  return got;
}

// The site, or a local `npm run dev` (localhost or 127.0.0.1 — the same hosts DEV_AUTH accepts).
const allowedOrigin = (origin, env) => origin === env.ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

// GET /quotes?symbols=AAPL,MSFT -> { asOf, quotes: { AAPL: {...} | null } }.
// 502 when CNBC itself fails: the client counts that toward switching to Finnhub.
async function quotes(url, cors) {
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
  const syms = parseSymbols(url.searchParams.get("symbols"));
  if (!syms) return json({ error: "bad symbols" }, 400);
  const now = Date.now();
  // Bound memory against junk symbol lists. The response is built from `out` (this request's
  // own hits + fetch results), never re-read from the cache, so a clear by a concurrent
  // request can't blank it.
  if (quoteCache.size > QUOTE_CACHE_MAX) quoteCache.clear();
  const out = {};
  const stale = [];
  for (const s of syms) {
    const c = quoteCache.get(s);
    if (c && c.at > now - QUOTE_TTL_MS) out[s] = c.q;
    else stale.push(s);
  }
  if (stale.length && now < failedUntil) return json({ error: "upstream" }, 502);
  const waits = new Set();
  const mine = [];
  for (const s of stale) {
    const p = inflight.get(s);
    if (p) waits.add(p);
    else mine.push(s);
  }
  for (let i = 0; i < mine.length; i += CHUNK) {
    const chunk = mine.slice(i, i + CHUNK);
    const p = fetchChunk(chunk, now).finally(() => {
      for (const s of chunk) if (inflight.get(s) === p) inflight.delete(s);
    });
    for (const s of chunk) inflight.set(s, p);
    waits.add(p);
  }
  try {
    for (const got of await Promise.all(waits)) Object.assign(out, got);
  } catch {
    failedUntil = Date.now() + QUOTE_TTL_MS; // from the failure, not the request start
    return json({ error: "upstream" }, 502);
  }
  return json({ asOf: now, quotes: Object.fromEntries(syms.map((s) => [s, out[s] ?? null])) });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("origin") ?? "";
    if (url.pathname === "/live") {
      if (req.headers.get("upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
      if (!allowedOrigin(origin, env)) return new Response("forbidden", { status: 403 });
      return env.LIVE.get(env.LIVE.idFromName("main")).fetch(req);
    }
    if (url.pathname === "/quotes") {
      // Keeps other sites' pages from using this as their CNBC proxy. Not an auth boundary — a
      // non-browser client can forge Origin; add a per-IP rate limit if that ever shows up.
      if (!allowedOrigin(origin, env)) return new Response("forbidden", { status: 403 });
      const cors = { "access-control-allow-origin": origin, vary: "origin" };
      if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "access-control-allow-methods": "GET" } });
      if (req.method !== "GET") return new Response("GET only", { status: 405, headers: cors });
      return quotes(url, cors);
    }

    const cors = {
      "access-control-allow-origin": env.ORIGIN,
      "access-control-allow-methods": "POST",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
    const r = await fetch(DISPATCH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "marketpulse-track",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    return new Response(null, { status: r.ok ? 204 : 502, headers: cors });
  },
};

// Live-quote relay. Finnhub allows ONE WebSocket per key, so a browser opening its own
// socket kicked every other visitor's off. This object holds the single upstream socket
// and speaks Finnhub's protocol to browsers ({type:"subscribe"|"unsubscribe", symbol} in,
// trade messages out), so the client hook only swaps its URL.
// ponytail: the union of all browsers' symbols is capped first-come at SYMBOL_CAP; past it
// a symbol just gets no live ticks (row keeps its snapshot). Demand-ranked slots + REST
// rotation is the upgrade if combined demand ever passes 50.
export class LiveRelay {
  constructor(_state, env) {
    this.env = env;
    this.clients = new Map(); // browser socket -> Set of its symbols
    this.up = null; // upstream Finnhub socket
    this.upSubs = new Set(); // what upstream currently holds
    this.backoff = BACKOFF_MS;
    this.retry = null; // pending reconnect timer
    this.connecting = false; // upstream handshake in flight
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    this.clients.set(server, new Set());
    server.addEventListener("message", (e) => this.onClient(server, e.data));
    const drop = () => {
      this.clients.delete(server);
      this.sync();
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);
    void this.connect();
    return new Response(null, { status: 101, webSocket: client });
  }

  onClient(ws, raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const subs = this.clients.get(ws);
    if (!subs || typeof m?.symbol !== "string" || m.symbol.length > 20) return;
    if (m.type === "subscribe") subs.add(m.symbol);
    else if (m.type === "unsubscribe") subs.delete(m.symbol);
    else return;
    this.sync();
  }

  desired() {
    const out = new Set();
    for (const subs of this.clients.values()) {
      for (const s of subs) {
        if (out.size >= SYMBOL_CAP) return out;
        out.add(s);
      }
    }
    return out;
  }

  // Reconcile upstream with what browsers want; drop upstream when nobody is listening.
  sync() {
    if (!this.clients.size) {
      clearTimeout(this.retry); // an in-flight connect() sees no clients and closes itself
      this.retry = null;
      const up = this.up;
      this.up = null;
      this.upSubs = new Set();
      try {
        up?.close();
      } catch {
        /* already closed */
      }
      return;
    }
    if (!this.up) return; // connect() subscribes the full set once open
    const want = this.desired();
    for (const s of want) if (!this.upSubs.has(s)) this.up.send(JSON.stringify({ type: "subscribe", symbol: s }));
    for (const s of this.upSubs) if (!want.has(s)) this.up.send(JSON.stringify({ type: "unsubscribe", symbol: s }));
    this.upSubs = want;
  }

  async connect() {
    if (this.up || this.retry || this.connecting || !this.clients.size) return;
    this.connecting = true;
    let ws;
    try {
      const r = await fetch(`https://ws.finnhub.io?token=${this.env.FINNHUB_KEY}`, {
        headers: { upgrade: "websocket" },
      });
      ws = r.webSocket;
      if (!ws) throw new Error(`upstream ${r.status}`);
      ws.accept();
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.connecting = false;
    if (!this.clients.size) {
      ws.close();
      return;
    }
    this.up = ws;
    this.upSubs = new Set();
    this.backoff = BACKOFF_MS;
    ws.addEventListener("message", (e) => this.onUpstream(e.data));
    const lost = () => {
      if (this.up !== ws) return;
      this.up = null;
      this.upSubs = new Set();
      this.scheduleReconnect();
    };
    ws.addEventListener("close", lost);
    ws.addEventListener("error", lost);
    this.sync();
  }

  scheduleReconnect() {
    if (!this.clients.size || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
  }

  // Fan each trade batch out to the browsers subscribed to those symbols.
  onUpstream(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m?.type !== "trade" || !Array.isArray(m.data)) return;
    for (const [ws, subs] of this.clients) {
      const data = m.data.filter((d) => subs.has(d?.s));
      if (!data.length) continue;
      try {
        ws.send(JSON.stringify({ type: "trade", data }));
      } catch {
        this.clients.delete(ws);
      }
    }
  }
}
