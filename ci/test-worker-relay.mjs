// worker/index.js LiveRelay — the Durable Object that holds the ONE Finnhub socket a key may
// have and fans trades out to browsers. Run: node ci/test-worker-relay.mjs
//
// Runs the real class in Node with the Workers runtime faked: WebSocketPair hands out fake
// sockets, Response accepts the 101 + webSocket init Node's own Response rejects, fetch()
// answers the Finnhub upgrade with a fake upstream socket (or fails, on demand), and
// setTimeout is a manual scheduler so reconnect backoff is asserted delay by delay.
//
// What must hold: one upstream socket at most, ever (a second one kicks every visitor off);
// upstream = union of browsers' symbols capped first-come at 50; each browser gets only its
// own symbols' trades; upstream closes once nobody listens; reconnect backs off 2s -> 15s.
import assert from "node:assert/strict";
import { LiveRelay } from "../worker/index.js";

// ---- fake runtime ------------------------------------------------------------------------
class FakeSocket {
  constructor(name) {
    this.name = name;
    this.listeners = {};
    this.sent = [];
    this.accepted = false;
    this.closed = false;
    this.throwOnSend = false;
  }
  accept() {
    this.accepted = true;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(s) {
    if (this.throwOnSend) throw new Error("socket closed");
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
  }
  emit(type, data) {
    for (const fn of this.listeners[type] ?? []) fn({ data });
  }
}
const serverSockets = [];
globalThis.WebSocketPair = class {
  constructor() {
    const client = new FakeSocket("client");
    const server = new FakeSocket(`server${serverSockets.length}`);
    serverSockets.push(server);
    this[0] = client;
    this[1] = server;
  }
};
globalThis.Response = class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket ?? null;
  }
};

// Finnhub upgrade: each fetch gets a deferred the test resolves (or the default auto-resolver).
const upstreams = []; // every upstream socket ever handed out
let fetches = [];
let autoUpgrade = true;
let failUpgrade = false;
globalThis.fetch = (url, init) => {
  let resolve, reject;
  const p = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  const f = {
    url: String(url),
    init,
    ok() {
      const ws = new FakeSocket(`up${upstreams.length}`);
      upstreams.push(ws);
      resolve({ status: 101, webSocket: ws });
      return ws;
    },
    noSocket(status = 401) {
      resolve({ status, webSocket: null });
    },
    fail() {
      reject(new TypeError("network"));
    },
  };
  fetches.push(f);
  if (failUpgrade) f.fail();
  else if (autoUpgrade) f.ok();
  return p;
};

// Manual timers.
let timers = [];
let timerId = 0;
globalThis.setTimeout = (fn, ms) => {
  const t = { id: ++timerId, fn, ms, cleared: false, fired: false };
  timers.push(t);
  return t;
};
globalThis.clearTimeout = (t) => {
  if (t && typeof t === "object") t.cleared = true;
};
const pending = () => timers.filter((t) => !t.cleared && !t.fired);
async function fireNext() {
  const t = pending()[0];
  assert.ok(t, "expected a pending reconnect timer");
  t.fired = true;
  t.fn();
  await flush();
  return t.ms;
}
const flush = () => new Promise((r) => setImmediate(r));

// ---- helpers ---------------------------------------------------------------------------------
const ENV = { FINNHUB_KEY: "fh-key" };
let relay;
function reset() {
  relay = new LiveRelay({}, ENV);
  fetches = [];
  timers = [];
  autoUpgrade = true;
  failUpgrade = false;
  upstreams.length = 0;
}
async function connectBrowser() {
  const res = await relay.fetch(new Request("https://w.example/live"));
  await flush();
  return { res, ws: serverSockets.at(-1) };
}
const say = (b, msg) => b.ws.emit("message", typeof msg === "string" ? msg : JSON.stringify(msg));
const sub = (b, ...syms) => syms.forEach((symbol) => say(b, { type: "subscribe", symbol }));
const unsub = (b, ...syms) => syms.forEach((symbol) => say(b, { type: "unsubscribe", symbol }));
/** The symbol set upstream holds, replayed from what the relay sent it. */
function upstreamSet(up) {
  const s = new Set();
  for (const m of up.sent) {
    if (m.type === "subscribe") s.add(m.symbol);
    else if (m.type === "unsubscribe") s.delete(m.symbol);
  }
  return s;
}
const openUpstreams = () => upstreams.filter((u) => !u.closed);
const trade = (...pairs) => JSON.stringify({ type: "trade", data: pairs.map(([s, p]) => ({ s, p, t: 1, v: 1 })) });

let failed = 0;
let passed = 0;
async function t(label, fn) {
  reset();
  try {
    await fn();
    passed++;
    console.log(`ok   ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}: ${e?.message ?? e}`);
  }
}

// ---- connection ------------------------------------------------------------------------------
await t("browser connect: 101 with the client end; server end accepted", async () => {
  const b = await connectBrowser();
  assert.equal(b.res.status, 101);
  assert.equal(b.res.webSocket.name, "client");
  assert.ok(b.ws.accepted);
});
await t("first browser opens ONE upstream (token in URL, websocket upgrade)", async () => {
  await connectBrowser();
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "https://ws.finnhub.io?token=fh-key");
  assert.equal(fetches[0].init.headers.upgrade, "websocket");
  assert.ok(upstreams[0].accepted);
});
await t("more browsers share the upstream (no second connect)", async () => {
  await connectBrowser();
  await connectBrowser();
  await connectBrowser();
  assert.equal(fetches.length, 1);
  assert.equal(openUpstreams().length, 1);
});

// ---- subscribe / unsubscribe ---------------------------------------------------------------------
await t("subscribe forwards once; a second browser on the same symbol adds nothing", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  sub(a, "AAPL");
  sub(b, "AAPL");
  assert.deepEqual(upstreams[0].sent, [{ type: "subscribe", symbol: "AAPL" }]);
});
await t("unsubscribe reaches upstream only when the LAST browser drops the symbol", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  sub(a, "AAPL");
  sub(b, "AAPL");
  unsub(a, "AAPL");
  assert.equal(upstreams[0].sent.length, 1);
  unsub(b, "AAPL");
  assert.deepEqual(upstreams[0].sent.at(-1), { type: "unsubscribe", symbol: "AAPL" });
  assert.equal(upstreamSet(upstreams[0]).size, 0);
});
await t("subscriptions made while upstream is still connecting are sent once it opens", async () => {
  autoUpgrade = false;
  const a = await connectBrowser();
  sub(a, "AAPL", "MSFT");
  assert.equal(upstreams.length, 0);
  fetches[0].ok();
  await flush();
  assert.deepEqual([...upstreamSet(upstreams[0])].sort(), ["AAPL", "MSFT"]);
  assert.equal(upstreams[0].sent.length, 2);
});
await t("junk browser messages are ignored", async () => {
  const a = await connectBrowser();
  say(a, "not json");
  say(a, { type: "subscribe" });
  say(a, { type: "subscribe", symbol: 42 });
  say(a, { type: "subscribe", symbol: "X".repeat(21) });
  say(a, { type: "hello", symbol: "AAPL" });
  say(a, "null");
  assert.deepEqual(upstreams[0].sent, []);
  sub(a, "X".repeat(20)); // 20 is the limit, inclusive
  assert.equal(upstreams[0].sent.length, 1);
});

// ---- 50-symbol cap -------------------------------------------------------------------------------
await t("cap: union of all browsers held at 50, first come", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  const A = Array.from({ length: 40 }, (_, i) => `A${i}`);
  const B = Array.from({ length: 20 }, (_, i) => `B${i}`);
  sub(a, ...A);
  sub(b, ...B);
  const held = upstreamSet(upstreams[0]);
  assert.equal(held.size, 50);
  for (const s of A) assert.ok(held.has(s), s);
  assert.deepEqual(B.filter((s) => held.has(s)), B.slice(0, 10));
});
await t("cap: never more than 50 subscribed at any point while symbols churn", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  let max = 0;
  const up = () => upstreams[0];
  const track = () => (max = Math.max(max, upstreamSet(up()).size));
  for (let i = 0; i < 60; i++) {
    sub(a, `A${i}`);
    track();
  }
  for (let i = 0; i < 30; i++) {
    sub(b, `B${i}`);
    track();
  }
  for (let i = 0; i < 25; i++) {
    unsub(a, `A${i}`);
    track();
  }
  assert.ok(max <= 50, `upstream held ${max}`);
});
await t("cap: freed slots go to the waiting symbols", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  const A = Array.from({ length: 50 }, (_, i) => `A${i}`);
  sub(a, ...A);
  sub(b, "LATE");
  assert.ok(!upstreamSet(upstreams[0]).has("LATE"));
  unsub(a, "A0");
  const held = upstreamSet(upstreams[0]);
  assert.ok(held.has("LATE"));
  assert.ok(!held.has("A0"));
  assert.equal(held.size, 50);
});
await t("cap: a departing browser's slots go to the others", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  sub(a, ...Array.from({ length: 50 }, (_, i) => `A${i}`));
  sub(b, "LATE");
  a.ws.emit("close");
  assert.deepEqual([...upstreamSet(upstreams[0])], ["LATE"]);
});

// ---- fan-out -------------------------------------------------------------------------------------
await t("fan-out: each browser gets only its own symbols' trades", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  const c = await connectBrowser();
  sub(a, "AAPL");
  sub(b, "MSFT", "AAPL");
  upstreams[0].emit("message", trade(["AAPL", 1], ["MSFT", 2], ["TSLA", 3]));
  assert.deepEqual(a.ws.sent, [{ type: "trade", data: [{ s: "AAPL", p: 1, t: 1, v: 1 }] }]);
  assert.deepEqual(b.ws.sent[0].data.map((d) => d.s), ["AAPL", "MSFT"]);
  assert.deepEqual(c.ws.sent, []);
});
await t("fan-out: pings / non-trade / malformed upstream messages are not forwarded", async () => {
  const a = await connectBrowser();
  sub(a, "AAPL");
  upstreams[0].emit("message", JSON.stringify({ type: "ping" }));
  upstreams[0].emit("message", "garbage{");
  upstreams[0].emit("message", JSON.stringify({ type: "trade", data: "x" }));
  upstreams[0].emit("message", JSON.stringify({ type: "trade", data: [null, { p: 1 }] }));
  assert.deepEqual(a.ws.sent, []);
});
await t("fan-out: a browser whose send throws is dropped; the others still get data", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  sub(a, "AAPL");
  sub(b, "AAPL");
  a.ws.throwOnSend = true;
  upstreams[0].emit("message", trade(["AAPL", 1]));
  assert.equal(b.ws.sent.length, 1);
  assert.ok(!relay.clients.has(a.ws));
  upstreams[0].emit("message", trade(["AAPL", 2]));
  assert.equal(b.ws.sent.length, 2);
});

// ---- teardown ------------------------------------------------------------------------------------
await t("last browser leaving closes upstream and schedules no reconnect", async () => {
  const a = await connectBrowser();
  const b = await connectBrowser();
  b.ws.emit("close");
  assert.ok(!upstreams[0].closed);
  a.ws.emit("error"); // an error drops the browser just like close
  assert.ok(upstreams[0].closed);
  assert.equal(relay.up, null);
  upstreams[0].emit("close"); // the upstream's own close event must not resurrect it
  assert.equal(pending().length, 0);
  assert.equal(fetches.length, 1);
});
await t("a new browser after teardown opens a fresh upstream with a clean symbol set", async () => {
  const a = await connectBrowser();
  sub(a, "AAPL");
  a.ws.emit("close");
  const b = await connectBrowser();
  sub(b, "MSFT");
  assert.equal(fetches.length, 2);
  assert.deepEqual([...upstreamSet(upstreams[1])], ["MSFT"]);
});
await t("upstream that opens after everyone left is closed at once", async () => {
  autoUpgrade = false;
  const a = await connectBrowser();
  a.ws.emit("close");
  fetches[0].ok();
  await flush();
  assert.ok(upstreams[0].closed);
  assert.equal(relay.up, null);
});

// ---- reconnect backoff -----------------------------------------------------------------------
await t("upstream lost -> reconnect after 2s, then resubscribes the full set", async () => {
  const a = await connectBrowser();
  sub(a, "AAPL", "MSFT");
  upstreams[0].emit("close");
  assert.equal(relay.up, null);
  assert.deepEqual(pending().map((x) => x.ms), [2000]);
  await fireNext();
  assert.equal(fetches.length, 2);
  assert.deepEqual([...upstreamSet(upstreams[1])].sort(), ["AAPL", "MSFT"]);
});
await t("error + close on the same upstream schedule ONE reconnect", async () => {
  await connectBrowser();
  upstreams[0].emit("error");
  upstreams[0].emit("close");
  assert.equal(pending().length, 1);
});
await t("backoff doubles on failed reconnects and caps at 15s", async () => {
  await connectBrowser();
  failUpgrade = true;
  upstreams[0].emit("close");
  const delays = [];
  for (let i = 0; i < 6; i++) delays.push(await fireNext());
  assert.deepEqual(delays, [2000, 4000, 8000, 15000, 15000, 15000]);
});
await t("upgrade answered without a socket (bad key / 401) counts as a failure", async () => {
  autoUpgrade = false;
  await connectBrowser();
  fetches[0].noSocket(401);
  await flush();
  assert.equal(relay.up, null);
  assert.deepEqual(pending().map((x) => x.ms), [2000]);
});
await t("a successful reconnect resets the backoff to 2s", async () => {
  await connectBrowser();
  failUpgrade = true;
  upstreams[0].emit("close");
  await fireNext(); // 2s, fails
  await fireNext(); // 4s, fails
  failUpgrade = false;
  await fireNext(); // 8s, succeeds
  assert.equal(relay.up, upstreams.at(-1));
  upstreams.at(-1).emit("close");
  assert.deepEqual(pending().map((x) => x.ms), [2000]);
});
await t("a stale close from a replaced upstream is ignored", async () => {
  await connectBrowser();
  const first = upstreams[0];
  first.emit("close");
  await fireNext();
  const second = upstreams[1];
  first.emit("close"); // late duplicate from the dead socket
  assert.equal(relay.up, second);
  assert.equal(pending().length, 0);
});
await t("everyone leaving cancels a pending reconnect", async () => {
  const a = await connectBrowser();
  upstreams[0].emit("close");
  assert.equal(pending().length, 1);
  a.ws.emit("close");
  assert.equal(pending().length, 0);
  assert.equal(fetches.length, 1);
});

// ---- the one-socket invariant ---------------------------------------------------------------
// Browser A connects (upgrade in flight), leaves, browser B connects before A's upgrade
// resolves: sync() reset the in-flight guard, so B starts a SECOND upgrade. Both complete;
// the first socket is overwritten in `this.up` but never closed — two live Finnhub sockets on
// one key, which is exactly what the relay exists to prevent.
await t("one upstream at most: leave + rejoin during an in-flight upgrade", async () => {
  autoUpgrade = false;
  const a = await connectBrowser();
  a.ws.emit("close");
  const b = await connectBrowser();
  sub(b, "AAPL");
  for (const f of fetches) f.ok();
  await flush();
  assert.equal(openUpstreams().length, 1, `${openUpstreams().length} upstream sockets left open (${fetches.length} upgrades issued)`);
  assert.ok(upstreamSet(relay.up).has("AAPL"));
});
await t("one upstream at most: many browsers arriving during one upgrade", async () => {
  autoUpgrade = false;
  for (let i = 0; i < 5; i++) await connectBrowser();
  assert.equal(fetches.length, 1);
  fetches[0].ok();
  await flush();
  assert.equal(openUpstreams().length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} LiveRelay check(s) failed`);
console.log("LiveRelay OK");
