// Shared fetch for the provider/Finviz scrapers: plain fetch first, FlareSolverr on a
// challenge/403, and FAIL FAST on a Cloudflare *firewall* block.
//
// Why: a firewall block ("Sorry, you have been blocked", error 1020) is a verdict on the runner's
// IP, not a transient. The old per-script retry loops treated it like a timeout and re-asked
// every URL 3-8 times with 6-8s sleeps, which stretched one blocked run to the 6h job limit.
// A block now throws BlockedError at once, and a per-endpoint breaker lets the caller skip the
// rest of that endpoint after `limit` blocks in a row (rows carry; files stay untouched).
import { appendFileSync } from "node:fs";
import { BROWSER_UA } from "../worker/cnbc.js";
import { isChallenge } from "./forecast-html.mjs";

const FS_URL_DEFAULT = process.env.FLARESOLVERR_URL || "http://localhost:8191/v1";
export const FLARE_TIMEOUT_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A firewall block (not a challenge): FlareSolverr's own verdict, or Cloudflare's block page. */
export const isBlocked = (s) => typeof s === "string"
  && /Cloudflare has blocked this request|Sorry, you have been blocked|error code: 1020/i.test(s);

export class BlockedError extends Error {
  constructor(msg = "Cloudflare has blocked this request") { super(msg); this.name = "BlockedError"; }
}

/** Opens after `limit` blocks in a row; any non-blocked result resets the count. */
export function makeBreaker(limit = 3) {
  let n = 0;
  return {
    open: () => n >= limit,
    record: (blocked) => { n = blocked ? n + 1 : 0; },
  };
}

/** Append a line to $RUNNER_TEMP/health (read by the workflow summary); no-op outside Actions. */
export function health(msg) {
  if (!process.env.RUNNER_TEMP) return;
  try { appendFileSync(`${process.env.RUNNER_TEMP}/health`, `${msg}\n`); } catch { /* best-effort */ }
}

/** One step-wide wall-clock budget: `passed()` once `ms` have elapsed since `start`. Pass `at` as
 *  getText's `deadline` so an in-flight fetch stops retrying too, and the step still writes its files
 *  before the workflow's `timeout-minutes` kills it. */
export function stepDeadline(ms, start = Date.now()) {
  const at = start + ms;
  return { at, passed: (now = Date.now()) => now >= at };
}

/**
 * GET `url` and return the body text (FlareSolverr JSON endpoints come back wrapped in <pre>;
 * keep using extractJson on the result).
 * - plain fetch first (once), FlareSolverr when it is a challenge, 403, or fails `ok`;
 * - a blocked response records on the breaker and throws BlockedError immediately;
 * - a challenge page, a FlareSolverr error or `!ok(body)` retries up to `tries`, `sleepMs` apart;
 * - `deadline` (epoch ms): a hard wall-clock bound on the whole call. No request starts past it
 *   (plain included), each attempt's AbortSignal is cut to the time left (body read included), and a
 *   retry sleep never runs past it. Per attempt: plain <= timeoutMs, FlareSolverr <= FLARE_TIMEOUT_MS.
 */
export async function getText(url, { flareUrl = FS_URL_DEFAULT, tries = 3, plain = true, ok = () => true, breaker, sleepMs = 8000, timeoutMs = 30_000, deadline = Infinity } = {}) {
  const blocked = (what) => { breaker?.record(true); throw new BlockedError(what); };
  const good = (body) => { breaker?.record(false); return body; };
  if (breaker?.open()) throw new BlockedError("breaker open");
  // the fetch signal also aborts the body read (r.text()/r.json()), so this bounds the whole attempt
  const left = () => deadline - Date.now();
  const signal = (ms) => AbortSignal.timeout(Math.max(0, Math.min(ms, left())));

  if (plain && left() > 0) {
    let r = null, body = "";
    try {
      r = await fetch(url, { headers: { "user-agent": BROWSER_UA }, signal: signal(timeoutMs) });
      body = await r.text();
    } catch { r = null; } // network trouble: let FlareSolverr try
    if (r) {
      // a plain-fetch block is NOT fatal: Node's TLS fingerprint draws WAF pages that FlareSolverr's
      // real browser may pass, so it falls through like a 403. Only a FlareSolverr block is final.
      if (r.status === 200 && !isChallenge(body) && ok(body)) return good(body);
    }
  }

  let lastErr = new Error("step deadline passed");
  for (let i = 1; i <= tries; i++) {
    if (left() <= 0) break;
    try {
      const r = await fetch(flareUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "request.get", url, maxTimeout: 60000 }),
        // longer than maxTimeout (60s): a FlareSolverr that never answers must not hang the step
        signal: signal(FLARE_TIMEOUT_MS),
      });
      const j = await r.json();
      const html = j.solution?.response || "";
      if (isBlocked(j.message) || isBlocked(html)) blocked(j.message || "blocked");
      if (j.status === "ok" && j.solution) {
        if (isChallenge(html)) throw new Error("Cloudflare page");
        if (!ok(html)) throw new Error("unusable response");
        return good(html);
      }
      throw new Error(j.message || "status != ok");
    } catch (e) {
      if (e instanceof BlockedError) throw e;
      lastErr = e;
      if (i < tries && left() > 0) await sleep(Math.min(sleepMs, left())); // also absorbs FlareSolverr's cold start
    }
  }
  throw lastErr;
}
