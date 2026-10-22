// "Track this stock" → start .github/workflows/track-requests.yml right away.
// No auth by design: the app only shows the button to signed-in users, and the lite run
// acts only on pending RTDB requests (which need sign-in to write), so a stray POST costs
// one ~30s no-op run. GH_TOKEN: fine-grained PAT, this repo only, Actions: read & write.
const DISPATCH =
  "https://api.github.com/repos/nitzan-massad/MarketPulse/actions/workflows/track-requests.yml/dispatches";

// Finnhub free tier: 50 symbols on the one connection a key may hold.
const SYMBOL_CAP = 50;
const BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 15_000;

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/live") {
      if (req.headers.get("upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
      const origin = req.headers.get("origin") ?? "";
      if (origin !== env.ORIGIN && !origin.startsWith("http://localhost:")) {
        return new Response("forbidden", { status: 403 });
      }
      return env.LIVE.get(env.LIVE.idFromName("main")).fetch(req);
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
    this.retry = null;
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
      clearTimeout(this.retry);
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
    if (this.up || this.retry || !this.clients.size) return;
    this.retry = true; // in-flight guard
    let ws;
    try {
      const r = await fetch(`https://ws.finnhub.io?token=${this.env.FINNHUB_KEY}`, {
        headers: { upgrade: "websocket" },
      });
      ws = r.webSocket;
      if (!ws) throw new Error(`upstream ${r.status}`);
      ws.accept();
    } catch {
      this.retry = null;
      this.scheduleReconnect();
      return;
    }
    this.retry = null;
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
