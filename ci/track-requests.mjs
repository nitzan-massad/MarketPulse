// User "Track this stock" requests — RTDB `trackRequests/<KEY>` → src/data/pinned.json.
//
//   node ci/track-requests.mjs pin    before the refresh: pending requests join pinned.json,
//                                     so this run's keep-set backfill fetches them (ci/keep.mjs)
//   node ci/track-requests.mjs fetch  lite run only (track-requests.yml): pinned requests with
//                                     no stocks.json row get one now (getData + forecast payload)
//                                     and their tickers go to $GITHUB_OUTPUT for the scrapers' ONLY
//   node ci/track-requests.mjs mark   after the deploy: requests whose ticker now has a
//                                     row in stocks.json flip to tracked=true
//
// Only `tracked == false` is ever read (`.indexOn: tracked` in database.rules.json). Marking
// waits for a real row, not for the pin: a run whose scrape got blocked leaves the request
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
const STOCKS = "src/data/stocks.json";
const SEEN = "src/data/seen.json";
const FS_URL = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
// ponytail: flat cap against request spam — every pin costs a getData call every run, forever.
// Per-user quotas if one account ever floods it.
const MAX_NEW_PER_RUN = 20;

/** RTDB keys can't hold "." — the client stores BRK.B as BRK_B. */
export const keyToTicker = (k) => k.replace(/_/g, ".");

/** Pending request keys → the tickers to add to pinned (new ones only, oldest first, capped). */
export function planPins(requests, pinned, cap = MAX_NEW_PER_RUN) {
  const have = new Set(pinned);
  return Object.entries(requests || {})
    .filter(([, r]) => r && r.tracked === false)
    .sort(([, a], [, b]) => (a.ts || 0) - (b.ts || 0))
    .map(([k]) => keyToTicker(k))
    .filter((t) => /^[A-Z0-9.-]{1,12}$/.test(t) && !have.has(t))
    .slice(0, cap);
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

/** Pending requests that are pinned but have no row yet → the tickers the lite run fetches. */
export function planFetch(requests, pinned, rowTickers, cap = MAX_NEW_PER_RUN) {
  const rows = new Set(rowTickers);
  return Object.entries(requests || {})
    .filter(([, r]) => r?.tracked === false)
    .map(([k]) => keyToTicker(k))
    .filter((t) => pinned.includes(t) && !rows.has(t))
    .slice(0, cap);
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
  const pending = await rtdb(token, "GET", `trackRequests.json?orderBy=%22tracked%22&equalTo=false`);
  console.log(`track requests: ${Object.keys(pending || {}).length} pending`);

  if (mode === "pin") {
    const pinned = JSON.parse(readFileSync(PINNED, "utf8"));
    const add = planPins(pending, pinned);
    if (add.length) writeFileSync(PINNED, JSON.stringify([...pinned, ...add]) + "\n");
    console.log(`  pinned +${add.length}${add.length ? `: ${add.join(", ")}` : ""}`);
  } else if (mode === "fetch") {
    const pinned = JSON.parse(readFileSync(PINNED, "utf8"));
    const stocks = JSON.parse(readFileSync(STOCKS, "utf8"));
    const seen = JSON.parse(readFileSync(SEEN, "utf8"));
    const now = new Date().toISOString();
    const got = [];
    for (const t of planFetch(pending, pinned, stocks.map((r) => r.t))) {
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
