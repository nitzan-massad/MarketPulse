// User "Track this stock" requests — RTDB `trackRequests/<KEY>` → src/data/tracked.json.
// Tracked is NOT pinned: a tracked ticker expires by the same rules as any other (ci/keep.mjs).
//
//   node ci/track-requests.mjs fold    site.yml, BEFORE pin: rows the lite run published to RTDB
//                                      `trackedRows/<KEY>` join the repo (stocks/tracked/seen.json +
//                                      public/forecasts|bullbear|pe and their sidecars), and the
//                                      folded {KEY: asOf} goes to $RUNNER_TEMP for `clear`
//   node ci/track-requests.mjs pin     before the refresh: pending requests join tracked.json,
//                                      so this run's keep-set backfill fetches them (ci/keep.mjs).
//                                      Also snapshots every watchlist + `views` into keepalive.json,
//                                      and clears requests whose stock has since been dropped so
//                                      the ticker can be requested again
//   node ci/track-requests.mjs fetch   lite run only (track-requests.yml): tracked requests with
//                                      no stocks.json row get one now (getData + forecast payload)
//                                      and their tickers go to $GITHUB_OUTPUT for the scrapers' ONLY
//   node ci/track-requests.mjs upload  lite run only, after its data gate: each $TICKERS row +
//                                      payloads → `trackedRows/<KEY>` (what the app reads live) and
//                                      `trackedRevs/<KEY>/<ms>` (history, never deleted)
//   node ci/track-requests.mjs mark    after the deploy (site) / the upload (lite): requests whose
//                                      ticker now has a row on disk flip to tracked=true
//   node ci/track-requests.mjs clear   site.yml, after the deploy: deletes the folded
//                                      `trackedRows/<KEY>` — only if its asOf is still the folded one
//
// The lite run never commits: it publishes to RTDB, so it never waits behind site.yml, and the app
// merges `trackedRows` over its bundle at load. site.yml's fold is what makes it permanent, and it
// MUST run before pin: the request is already tracked=true, so pin won't re-add it, and without the
// row planUnrequest would delete the request (pin also treats trackedRows keys as rows, for the
// seconds between a fold and a lite run landing).
//
// Marking waits for a real row, not for the pin: a run whose scrape got blocked leaves the request
// pending and the next run marks it.
//
// Auth: FIREBASE_SERVICE_ACCOUNT (the service-account JSON) is exchanged for an OAuth token
// with node:crypto — admin access, so it bypasses the rules that stop users writing tracked=true
// (and that keep trackedRows read-only / trackedRevs private).
// No secret => every mode logs and exits 0; this step must never block the deploy.
import { createSign } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fillNulls, forecastFields, rowFromGetData } from "./keep.mjs";

const DB = "https://marketpulse-df5d9-default-rtdb.europe-west1.firebasedatabase.app";
const PINNED = "src/data/pinned.json";
const TRACKED = "src/data/tracked.json";
const KEEPALIVE = "src/data/keepalive.json";
const STOCKS = "src/data/stocks.json";
const SEEN = "src/data/seen.json";
const FC_ASOF = "public/forecasts/_asOf.json";
const PE_INDEX = "public/pe/_asOf.json";
const FOLDED = `${process.env.RUNNER_TEMP || tmpdir()}/tracked-folded.json`; // fold → clear, same job
const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
// ponytail: flat cap against request spam — every pin costs a getData call every run, forever.
// Per-user quotas if one account ever floods it.
const MAX_NEW_PER_RUN = 20;

/** RTDB keys can't hold "." — the client stores BRK.B as BRK_B. */
export const keyToTicker = (k) => k.replace(/_/g, ".");
export const tickerToKey = (t) => t.replace(/\./g, "_");

/** The seen.json entry a lite-run arrival gets — the shape refresh-data-ci gives a pins-only
 *  arrival: "baseline", so New Arrivals isn't flooded. */
export const seenFor = (row, iso) => ({ d: "baseline", ls: iso, ss: row.ss, ai: row.ai, con: row.con, l: ["p"], ea: iso, ba: iso });

/** One `trackedRows/<KEY>` value. Every payload is the file's JSON TEXT, not an object: RTDB drops
 *  null fields and turns arrays into objects, and `ss: null` / `con: null` are data (CLAUDE.md), so a
 *  round-trip through RTDB objects would silently change what the fold commits. */
export const trackedEntry = (row, files, trackedAt, asOf) => ({
  row: JSON.stringify(row),
  forecast: files.forecast ?? null,
  bullbear: files.bullbear ?? null,
  pe: files.pe ?? null,
  trackedAt,
  asOf,
});

const PAYLOAD_DIRS = { forecast: "forecasts", bullbear: "bullbear", pe: "pe" };

/** RTDB `trackedRows` → what site.yml's fold writes. Pure: `has(dir, t)` says whether the repo
 *  already has public/<dir>/<t>.json. Only fills gaps — an existing row, file or newer tracked date
 *  wins, so a re-fold of an uncleared entry is a no-op — except that a ticker NEW to stocks.json
 *  overwrites its files: those are orphans from an earlier tenure, older than the lite run's. Sidecars are stamped like the scrapers:
 *  forecasts/_asOf.json[T] = ISO, pe/_asOf.json[T] = { a, ok:true }; bullbear carries its asOf in
 *  the file itself. Returns the new state, the files to write and the {KEY: asOf} folded. */
export function planFold(rows, { stocks, tracked, seen, fcAsOf, peIndex, has, peCache = {}, hasCache = () => false }) {
  const out = { stocks: [...stocks], tracked: { ...tracked }, seen: { ...seen }, fcAsOf: { ...fcAsOf }, peIndex: { ...peIndex }, files: [], folded: {} };
  const have = new Set(stocks.map((r) => r.t));
  for (const [k, e] of Object.entries(rows || {})) {
    const t = keyToTicker(k);
    let row;
    try { row = JSON.parse(e?.row); } catch { continue; }
    if (row?.t !== t || typeof e.asOf !== "string") continue; // junk: leave it in RTDB, unfolded
    const fresh = !have.has(t);
    if (fresh) {
      out.stocks.push(row);
      have.add(t);
      out.seen[t] ??= seenFor(row, e.asOf);
    }
    if (e.trackedAt && !((out.tracked[t] || "") >= e.trackedAt)) out.tracked[t] = e.trackedAt;
    for (const [kind, dir] of Object.entries(PAYLOAD_DIRS)) {
      if (typeof e[kind] !== "string" || (!fresh && has(dir, t))) continue;
      out.files.push([`public/${dir}/${t}.json`, e[kind]]);
      if (kind === "forecast") out.fcAsOf[t] = e.asOf;
      if (kind === "pe") out.peIndex[t] = { a: e.asOf, ok: true };
    }
    // scrape-pe's inputs (5Y closes, EPS), so the folded chart keeps moving with the price
    // without re-fetching its CNBC closes
    if (typeof peCache[k] === "string" && (fresh || !hasCache(t))) out.files.push([`ci/cache/pe/${t}.json`, peCache[k]]);
    out.folded[k] = e.asOf;
  }
  return out;
}

/** Pending requests → [ticker, request ISO date] to write to tracked.json (not pinned, oldest
 *  first, capped). A re-request of a dropped ticker carries a newer date, which restarts its clock. */
export function planTracks(requests, pinned, tracked = {}, cap = MAX_NEW_PER_RUN) {
  const pins = new Set(pinned);
  return Object.entries(requests || {})
    .filter(([, r]) => r && r.tracked === false)
    .sort(([, a], [, b]) => (a.ts || 0) - (b.ts || 0))
    .map(([k, r]) => [keyToTicker(k), new Date(r.ts || Date.now()).toISOString()])
    .filter(([t, iso]) => /^[A-Z0-9.-]{1,12}$/.test(t) && !pins.has(t) && !((tracked[t] || "") >= iso))
    .slice(0, cap);
}

/** Done requests whose ticker has no row any more (it expired) → RTDB patch deleting them,
 *  so the ticker can be requested again (the rules only allow creating a request). */
export function planUnrequest(requests, rowTickers) {
  const rows = new Set(rowTickers);
  return Object.fromEntries(Object.entries(requests || {})
    .filter(([k, r]) => r?.tracked === true && !rows.has(keyToTicker(k)))
    .map(([k]) => [k, null]));
}

/** RTDB `watchlist` (per-uid object, or a legacy array) + `views` → keepalive.json. No uids. */
export function planKeepalive(watchlists, views) {
  const watched = new Set();
  for (const l of Object.values(watchlists || {})) {
    for (const t of Array.isArray(l) ? l : Object.keys(l || {})) {
      // watched tickers are ADDED to the keep set, so junk must not reach a getData call
      if (typeof t === "string" && /^[A-Z0-9._-]{1,12}$/.test(t)) watched.add(keyToTicker(t));
    }
  }
  const viewed = {};
  for (const [k, ms] of Object.entries(views || {})) if (typeof ms === "number") viewed[keyToTicker(k)] = ms;
  return { watched: [...watched].sort(), viewed };
}

/** Pending request keys whose ticker now has a stocks.json row → the RTDB patch that marks them. */
export function planMarks(requests, rowTickers, now = Date.now()) {
  const rows = new Set(rowTickers);
  const patch = {};
  for (const [k, r] of Object.entries(requests || {})) {
    if (r?.tracked === false && rows.has(keyToTicker(k))) {
      patch[`${k}/tracked`] = true;
      patch[`${k}/trackedAt`] = now;
    }
  }
  return patch;
}

/** Pending requests that are tracked but have no row yet → the tickers the lite run fetches. */
export function planFetch(requests, tracked, rowTickers, cap = MAX_NEW_PER_RUN) {
  const rows = new Set(rowTickers);
  return Object.entries(requests || {})
    .filter(([, r]) => r?.tracked === false)
    .map(([k]) => keyToTicker(k))
    .filter((t) => tracked.includes(t) && !rows.has(t))
    .slice(0, cap);
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

// ponytail: same FlareSolverr transport as refresh-data-ci / scrape-forecasts / scrape-bullbear,
// each holding a copy. Hoist to one module if a fifth caller appears.
async function flareJson(url, tries = 6) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(FS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
      });
      const j = await r.json();
      if (j.status !== "ok" || !j.solution) throw new Error(j.message || "status != ok");
      const html = j.solution.response || "";
      const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
      const body = (pre ? pre[1] : html)
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      return JSON.parse(body.match(/\{[\s\S]*\}/)[0]);
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 6000)); // also absorbs FlareSolverr's cold start
    }
  }
  throw lastErr;
}

/** The lite run starts FlareSolverr in the background (track-requests.yml) so an empty run never
 *  waits for it: block here, only once there is something to fetch. Its root answers 200 when ready. */
async function waitForFlare(ms = 180_000) {
  const root = new URL(FS_URL).origin;
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 2000))) {
    try { if ((await fetch(root)).ok) return; } catch { /* not up yet */ }
  }
  console.log(`  FlareSolverr not up after ${ms / 1000}s — fetching anyway, flareJson retries`);
}

async function accessToken(sa) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat,
    exp: iat + 3600,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function rtdbRes(token, method, path, body, headers = {}) {
  return fetch(`${DB}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: body && JSON.stringify(body),
  });
}

async function rtdb(token, method, path, body) {
  const res = await rtdbRes(token, method, path, body);
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

// verbatim (no trim), so the fold writes back byte-for-byte what the scraper wrote
const readText = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };

async function main(mode) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log("FIREBASE_SERVICE_ACCOUNT not set — skipping track requests.");
    return;
  }
  const token = await accessToken(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  const tracked = readJson(TRACKED, {});

  if (mode === "fold") {
    // ponytail: whole-tree GET of trackedRows — it only holds rows not yet folded, so it stays
    // a handful. Same whole-tree GETs below.
    const rows = await rtdb(token, "GET", "trackedRows.json");
    const peCache = (await rtdb(token, "GET", "trackedPeCache.json")) || {};
    const f = planFold(rows, {
      stocks: readJson(STOCKS, []), tracked, seen: readJson(SEEN, {}),
      fcAsOf: readJson(FC_ASOF, {}), peIndex: readJson(PE_INDEX, {}),
      has: (dir, t) => existsSync(`public/${dir}/${t}.json`),
      peCache, hasCache: (t) => existsSync(`ci/cache/pe/${t}.json`),
    });
    const n = Object.keys(f.folded).length;
    if (n) {
      mkdirSync("ci/cache/pe", { recursive: true });
      for (const [path, text] of f.files) writeFileSync(path, text);
      // each file in the format its writer uses (refresh-data-ci / scrape-forecasts / scrape-pe)
      writeFileSync(STOCKS, JSON.stringify(f.stocks));
      writeFileSync(SEEN, JSON.stringify(f.seen));
      writeFileSync(TRACKED, JSON.stringify(f.tracked) + "\n");
      writeFileSync(FC_ASOF, JSON.stringify(f.fcAsOf, null, 1));
      writeFileSync(PE_INDEX, JSON.stringify(Object.fromEntries(Object.entries(f.peIndex).sort())) + "\n");
    }
    writeFileSync(FOLDED, JSON.stringify(f.folded));
    console.log(`  folded trackedRows: ${n}${n ? `: ${Object.keys(f.folded).map(keyToTicker).join(", ")} (${f.files.length} files)` : ""}`);
    return;
  }
  if (mode === "clear") {
    const folded = readJson(FOLDED, {});
    let cleared = 0;
    for (const [k, asOf] of Object.entries(folded)) {
      // ETag + if-match: deletes only the exact entry folded. A lite run that rewrote it since
      // (new asOf) gets a 412 and its entry waits for the next fold. trackedRevs is never touched.
      const cur = await rtdbRes(token, "GET", `trackedRows/${k}.json`, undefined, { "X-Firebase-ETag": "true" });
      if (!cur.ok) { console.log(`  ${k}: GET ${cur.status}, kept`); continue; }
      if ((await cur.json())?.asOf !== asOf) continue;
      const del = await rtdbRes(token, "DELETE", `trackedRows/${k}.json`, undefined, { "if-match": cur.headers.get("etag") });
      if (del.ok) {
        cleared++;
        await rtdbRes(token, "DELETE", `trackedPeCache/${k}.json`); // a cache, not history: no revision
      } else console.log(`  ${k}: DELETE ${del.status}, kept`);
    }
    console.log(`  cleared trackedRows: ${cleared}/${Object.keys(folded).length}`);
    return;
  }
  if (mode === "upload") {
    const stocks = readJson(STOCKS, []);
    const asOf = new Date().toISOString();
    const ms = Date.parse(asOf);
    const patch = {};
    for (const t of (process.env.TICKERS || "").split(",").filter(Boolean)) {
      const row = stocks.find((r) => r.t === t);
      if (!row) { console.log(`  ${t}: no row on disk, not uploaded`); continue; }
      const files = Object.fromEntries(Object.entries(PAYLOAD_DIRS).map(([kind, dir]) => [kind, readText(`public/${dir}/${t}.json`)]));
      const entry = trackedEntry(row, files, tracked[t] || asOf, asOf);
      // one multi-path PATCH at the root: sets just these two children, never the parents
      patch[`trackedRows/${tickerToKey(t)}`] = entry;
      patch[`trackedRevs/${tickerToKey(t)}/${ms}`] = entry;
      // separate path: the app reads all of trackedRows, and this is up to ~16 KB it never needs
      const cache = readText(`ci/cache/pe/${t}.json`);
      if (cache) patch[`trackedPeCache/${tickerToKey(t)}`] = cache;
    }
    if (Object.keys(patch).length) await rtdb(token, "PATCH", ".json", patch);
    console.log(`  uploaded trackedRows: ${Object.keys(patch).filter((k) => k.startsWith("trackedRows/")).length}`);
    return;
  }

  // ponytail: whole-tree GETs (all requests, all watchlists, all views) — fine at hobby scale;
  // shallow/indexed queries if any of them ever reaches MBs.
  const all = await rtdb(token, "GET", "trackRequests.json");
  const pending = Object.fromEntries(Object.entries(all || {}).filter(([, r]) => r?.tracked === false));
  console.log(`track requests: ${Object.keys(pending).length} pending`);

  if (mode === "pin") {
    const add = planTracks(pending, readJson(PINNED, []), tracked);
    if (add.length) writeFileSync(TRACKED, JSON.stringify({ ...tracked, ...Object.fromEntries(add) }) + "\n");
    console.log(`  tracked +${add.length}${add.length ? `: ${add.map(([t]) => t).join(", ")}` : ""}`);
    // The lite run never commits, so keepalive.json and the cleanup would be thrown away; site.yml does both.
    if (process.env.LITE === "1") return;
    // Requests only — never touch tracked.json here: its date is what lets a dropped ticker stay dropped.
    // a trackedRows ticker is live in the app, just not folded yet: it counts as a row
    const live = Object.keys((await rtdb(token, "GET", "trackedRows.json?shallow=true")) || {}).map(keyToTicker);
    const gone = planUnrequest(all, [...readJson(STOCKS, []).map((r) => r.t), ...live]);
    if (Object.keys(gone).length) await rtdb(token, "PATCH", "trackRequests.json", gone);
    console.log(`  cleared dropped requests: ${Object.keys(gone).length}`);
    const [wl, views] = await Promise.all([rtdb(token, "GET", "watchlist.json"), rtdb(token, "GET", "views.json")]);
    const ka = planKeepalive(wl, views);
    writeFileSync(KEEPALIVE, JSON.stringify(ka) + "\n");
    console.log(`  keepalive: ${ka.watched.length} watched, ${Object.keys(ka.viewed).length} viewed`);
  } else if (mode === "fetch") {
    const stocks = JSON.parse(readFileSync(STOCKS, "utf8"));
    const seen = JSON.parse(readFileSync(SEEN, "utf8"));
    const now = new Date().toISOString();
    const got = [];
    const want = planFetch(pending, Object.keys(tracked), stocks.map((r) => r.t));
    if (want.length) await waitForFlare();
    for (const t of want) {
      try {
        const row = rowFromGetData(await flareJson(`https://www.tipranks.com/api/stocks/getData/?name=${encodeURIComponent(t)}`));
        if (!row.t) throw new Error("no ticker in getData");
        try {
          fillNulls(row, forecastFields(await flareJson(`https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-forecast/payload.json`, 2), t)); // optional: don't burn 36s+ retrying it
        } catch (e) { console.log(`  ${t}: forecast payload skip (${e.message}) — the 5h run's enrich fills it`); }
        stocks.push(row);
        seen[t] = seenFor(row, now);
        got.push(t);
      } catch (e) { console.log(`  ${t}: getData skip (${e.message})`); }
    }
    if (got.length) {
      writeFileSync(STOCKS, JSON.stringify(stocks));
      writeFileSync(SEEN, JSON.stringify(seen));
    }
    console.log(`  fetched rows: ${got.length}${got.length ? `: ${got.join(", ")}` : ""}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tickers=${got.join(",")}\n`);
  } else if (mode === "mark") {
    const rows = JSON.parse(readFileSync(STOCKS, "utf8")).map((r) => r.t);
    const patch = planMarks(pending, rows);
    if (Object.keys(patch).length) await rtdb(token, "PATCH", "trackRequests.json", patch);
    console.log(`  marked tracked: ${Object.keys(patch).length / 2}`);
  } else {
    throw new Error(`usage: track-requests.mjs fold|pin|fetch|upload|mark|clear (got ${mode})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv[2]);
