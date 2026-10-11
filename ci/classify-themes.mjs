// Themes that cut across TipRanks' sectors (quantum computing sits under Technology AND
// General) — each company is asked about once, by the same AI provider the posts use, and the
// answers become extra options in the app's Sector filter.
//
//   src/data/themes.json      { "Quantum Computing": ["IONQ", …] }   read by the app (lib.ts)
//   ci/cache/themes.json      { "Quantum Computing": { T: [hash, 0|1] } }   every verdict, kept
//
// A company is asked only when it has no verdict yet or its name/description changed (the hash),
// so a normal run asks 0-5 new arrivals. MAX_CALLS bounds a run; a backfill of the whole universe
// spreads over a few runs instead of eating the posts' share of the free daily neurons.
// Adding a theme = one line in THEMES; its backfill then runs the same way.
//
// ponytail: verdicts come from the description alone. A company whose quantum work is a side
// project (IBM, Alphabet) is a "no" by design — the question says CORE business. If a verdict is
// wrong, the fix is a sharper definition below, not a hand-kept exception list.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { makeProvider } from "./provider.mjs";
import { isExhausted } from "./cf-budget.mjs";

export const THEMES = {
  "Quantum Computing":
    "its core business is quantum computing: building quantum computers or quantum processors, or selling quantum computing software, cloud access or services. Companies whose main business is something else (even with a quantum research program), and companies that only have 'quantum' in their name, are NOT included.",
};

const STOCKS = "src/data/stocks.json";
const OUT = "src/data/themes.json";
const CACHE = "ci/cache/themes.json";
const MAX_CALLS = Number(process.env.THEMES_MAX_CALLS || 150);

export const hashOf = (s) => createHash("sha1").update(`${s.n || ""}\n${s.desc || ""}`).digest("hex").slice(0, 10);

/** "Yes." / "no — it sells …" -> 1 / 0; anything else -> null (asked again next run). */
export function parseVerdict(text) {
  const m = /^\W*(yes|no)\b/i.exec(text || "");
  return m ? (m[1].toLowerCase() === "yes" ? 1 : 0) : null;
}

/** Companies that need asking for one theme: no verdict yet, or the description changed.
 *  Rows without a description are skipped — there is nothing to judge them on. */
export function needsAsk(stocks, verdicts = {}) {
  return stocks.filter((s) => s.desc && verdicts[s.t]?.[0] !== hashOf(s));
}

/** The app's file: each theme's "yes" companies that are still in the snapshot, sorted. */
export function buildOut(stocks, cache) {
  const live = new Set(stocks.map((s) => s.t));
  return Object.fromEntries(
    Object.keys(THEMES).map((name) => [
      name,
      Object.entries(cache[name] || {})
        .filter(([t, [, v]]) => v === 1 && live.has(t))
        .map(([t]) => t)
        .sort(),
    ]),
  );
}

const promptFor = (s, def) =>
  `Company: ${s.n} (${s.t})\nDescription: ${s.desc}\n\nDoes this company belong to the theme? It belongs only if ${def}\nAnswer with one word: yes or no.`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const stocks = JSON.parse(readFileSync(STOCKS, "utf8"));
  const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  const ask = makeProvider();
  let calls = 0;
  outer: for (const [name, def] of Object.entries(THEMES)) {
    const verdicts = (cache[name] ??= {});
    const todo = needsAsk(stocks, verdicts);
    for (const s of todo) {
      if (calls >= MAX_CALLS || isExhausted()) {
        console.log(`themes: stopped at ${calls} calls — the rest are asked next run`);
        break outer;
      }
      calls++;
      const [text] = await ask({
        system: "You classify public companies by their main line of business. Answer only yes or no.",
        prompt: promptFor(s, def),
        temperature: 0,
      });
      const v = parseVerdict(text);
      if (v == null) {
        console.log(`themes: ${s.t} unclear answer ${JSON.stringify(text)} — asked again next run`);
        continue;
      }
      verdicts[s.t] = [hashOf(s), v];
      if (v) console.log(`themes: ${name} + ${s.t} (${s.n})`);
    }
  }
  writeFileSync(CACHE, JSON.stringify(cache, null, 1) + "\n");
  const out = buildOut(stocks, cache);
  writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
  const left = Object.keys(THEMES).reduce((n, name) => n + needsAsk(stocks, cache[name]).length, 0);
  console.log(`themes: ${calls} asked, ${left} still to ask; ` + Object.entries(out).map(([k, v]) => `${k}: ${v.join(", ") || "none"}`).join(" | "));
}
