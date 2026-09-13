// Refresh src/data/feargreed.json — CNN Business's Fear & Greed Index, the 0-100 one.
// One unauthenticated GET per run (~175KB in, ~3KB written), no key, no FlareSolverr.
//
// CNN is behind Fastly, not Cloudflare, and its bot gate answers 418 ("I'm a teapot.
// You're a bot.") unless the request carries BOTH a browser User-Agent and a cnn.com
// Referer. Those are Forbidden Headers, so a browser can never send them — which is why
// this lives in CI and the app reads a committed file. The endpoint does return
// `access-control-allow-origin: *`, but that is a red herring: the 418 fires first.
//
// ponytail: the payload is trimmed here, not in the app — 175KB of raw CNN JSON would
// otherwise land in the bundle to render one dial and a sparkline. If the app ever needs
// the raw per-component series (each carries ~250 points of underlying VIX / put-call
// values), widen KEEP below rather than shipping the whole document.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const OUT = "src/data/feargreed.json";

// CNN publishes nine series; seven are the documented sub-indicators. `market_momentum_sp125`
// and `market_volatility_vix_50` are alternate lookbacks of two of them and would double-count.
const KEEP = [
  ["market_momentum_sp500", "Market momentum"],
  ["stock_price_strength", "Stock price strength"],
  ["stock_price_breadth", "Stock price breadth"],
  ["put_call_options", "Put / call ratio"],
  ["market_volatility_vix", "Market volatility"],
  ["junk_bond_demand", "Junk bond demand"],
  ["safe_haven_demand", "Safe haven demand"],
];

const MIN_HISTORY = 120; // a good run returns ~250 trading days; far fewer means a truncated payload
const WEEKLY = 5; // trading days per week — sample the daily series down to ~52 points

const r1 = (n) => Math.round(n * 10) / 10;

/** Score sanity: CNN sends floats, but only 0-100 is meaningful. */
function score01(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`${what}: score ${v} outside 0-100`);
  return r1(n);
}

export function parseFearGreed(doc) {
  const fg = doc?.fear_and_greed;
  if (!fg) throw new Error("no fear_and_greed block — payload reshaped");

  const components = [];
  for (const [key, label] of KEEP) {
    const c = doc[key];
    // An absent component means CNN reshaped the document — that is a failure, not a gap.
    if (!c) throw new Error(`component "${key}" missing — payload reshaped`);
    components.push({ key, label, score: score01(c.score, key), rating: String(c.rating || "") });
  }

  const raw = doc.fear_and_greed_historical?.data;
  if (!Array.isArray(raw) || raw.length < MIN_HISTORY) {
    throw new Error(`history has ${raw?.length ?? 0} points (need ${MIN_HISTORY}) — not writing`);
  }
  // Sample weekly, oldest-first, and always keep the newest point so the sparkline's
  // last value matches the headline score rather than drifting up to a week behind it.
  const history = [];
  for (let i = raw.length - 1; i >= 0; i -= WEEKLY) history.unshift(r1(Number(raw[i].y)));

  return {
    score: score01(fg.score, "headline"),
    rating: String(fg.rating || ""),
    asOf: String(fg.timestamp || "").slice(0, 19),
    previous: {
      close: score01(fg.previous_close, "previous_close"),
      week: score01(fg.previous_1_week, "previous_1_week"),
      month: score01(fg.previous_1_month, "previous_1_month"),
      year: score01(fg.previous_1_year, "previous_1_year"),
    },
    components,
    history,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await fetch(URL, {
    headers: {
      // both required — see the header comment; dropping either one returns 418
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
      referer: "https://edition.cnn.com/",
    },
  });
  if (!res.ok) throw new Error(`CNN returned HTTP ${res.status} — bot gate or endpoint moved`);

  const next = parseFearGreed(await res.json());

  // Staleness is judged on CNN's own `asOf`, never file mtime — actions/checkout restamps
  // every file on every run (see ci/README.md).
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  if (prev && prev.asOf > next.asOf) {
    console.log(`feargreed.json: kept ${prev.asOf} (fetched ${next.asOf} is older)`);
  } else {
    writeFileSync(OUT, JSON.stringify(next, null, 1) + "\n");
    console.log(`feargreed.json: ${next.score} ${next.rating}, ${next.history.length} weekly points, asOf ${next.asOf}`);
  }
}
