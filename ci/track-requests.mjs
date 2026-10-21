// User "Track this stock" requests — RTDB `trackRequests/<KEY>` → src/data/tracked.json.
// Tracked is NOT pinned: a tracked ticker expires by the same rules as any other (ci/keep.mjs).
//
//   node ci/track-requests.mjs pin    before the refresh: pending requests join tracked.json,
//                                     so this run's keep-set backfill fetches them (ci/keep.mjs).
//                                     Also snapshots every watchlist + `views` into keepalive.json,
//                                     and clears requests whose stock has since been dropped so
//                                     the ticker can be requested again
//   node ci/track-requests.mjs fetch  lite run only (track-requests.yml): tracked requests with
//                                     no stocks.json row get one now (getData + forecast payload)
//                                     and their tickers go to $GITHUB_OUTPUT for the scrapers' ONLY
//   node ci/track-requests.mjs mark   after the deploy: requests whose ticker now has a
//                                     row in stocks.json flip to tracked=true
//
// Marking waits for a real row, not for the pin: a run whose scrape got blocked leaves the request
// pending and the next run marks it.
//
// Auth: FIREBASE_SERVICE_ACCOUNT (the service-account JSON) is exchanged for an OAuth token
// with node:crypto — admin access, so it bypasses the rules that stop users writing tracked=true.
// No secret => both modes log and exit 0; this step must never block the deploy.
import { createSign } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fillNulls, forecastFields, rowFromGetData } from "./keep.mjs";

const DB = "https://marketpulse-df5d9-default-rtdb.europe-west1.firebasedatabase.app";
const PINNED = "src/data/pinned.json";
const TRACKED = "src/data/tracked.json";
const KEEPALIVE = "src/data/keepalive.json";
const STOCKS = "src/data/stocks.json";
const SEEN = "src/data/seen.json";
const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
// ponytail: flat cap against request spam — every pin costs a getData call every run, forever.
// Per-user quotas if one account ever floods it.
const MAX_NEW_PER_RUN = 20;

/** RTDB keys can't hold "." — the client stores BRK.B as BRK_B. */
export const keyToTicker = (k) => k.replace(/_/g, ".");

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

async function rtdb(token, method, path, body) {
  const res = await fetch(`${DB}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main(mode) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.log("FIREBASE_SERVICE_ACCOUNT not set — skipping track requests.");
    return;
  }
  const token = await accessToken(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
  // ponytail: whole-tree GETs (all requests, all watchlists, all views) — fine at hobby scale;
  // shallow/indexed queries if any of them ever reaches MBs.
  const all = await rtdb(token, "GET", "trackRequests.json");
  const pending = Object.fromEntries(Object.entries(all || {}).filter(([, r]) => r?.tracked === false));
  console.log(`track requests: ${Object.keys(pending).length} pending`);
  const tracked = readJson(TRACKED, {});

  if (mode === "pin") {
    const add = planTracks(pending, readJson(PINNED, []), tracked);
    if (add.length) writeFileSync(TRACKED, JSON.stringify({ ...tracked, ...Object.fromEntries(add) }) + "\n");
    console.log(`  tracked +${add.length}${add.length ? `: ${add.map(([t]) => t).join(", ")}` : ""}`);
    // Requests only — never touch tracked.json here: its date is what lets a dropped ticker stay dropped.
    const gone = planUnrequest(all, readJson(STOCKS, []).map((r) => r.t));
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
    for (const t of planFetch(pending, Object.keys(tracked), stocks.map((r) => r.t))) {
      try {
        const row = rowFromGetData(await flareJson(`https://www.tipranks.com/api/stocks/getData/?name=${encodeURIComponent(t)}`));
        if (!row.t) throw new Error("no ticker in getData");
        try {
          fillNulls(row, forecastFields(await flareJson(`https://www.tipranks.com/stocks/${t.toLowerCase()}/stock-forecast/payload.json`), t));
        } catch (e) { console.log(`  ${t}: forecast payload skip (${e.message}) — the 5h run's enrich fills it`); }
        stocks.push(row);
        // same shape refresh-data-ci gives a pins-only arrival: "baseline", so New Arrivals isn't flooded
        seen[t] = { d: "baseline", ls: now, ss: row.ss, ai: row.ai, con: row.con, l: ["p"], ea: now, ba: now };
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
    throw new Error(`usage: track-requests.mjs pin|fetch|mark (got ${mode})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv[2]);
