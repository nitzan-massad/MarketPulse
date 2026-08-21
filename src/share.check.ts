// Dependency-free self-check for the share deep link. No test framework by design
// (mirrors alertEngine.check.ts / fmtPx.check.ts).
//
// What this guards, in order of how badly it would bite:
//   1. The base. Dev serves at "/", the production build at "/MarketPulse/" (vite.config.ts).
//      A link built against the wrong one 404s for whoever it was sent to, and the sender
//      sees a perfectly good copy animation while it happens.
//   2. The hash whitelist. The app reads the hash on every load, so a permissive parser
//      turns any unrelated "#…" into a "No data for …" modal in front of the whole page.
//   3. Round-tripping. build -> parse must be lossless, or a shared link opens the wrong
//      stock (or nothing) for the recipient only — the sender can never reproduce it.
//   4. pickBurst never repeating itself back-to-back: two identical bursts in a row read
//      as "there is only one animation", which is the entire point of having twenty.
//
// Run:
//   npx tsc src/share.ts src/share.check.ts --outDir /tmp/sh \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/sh/share.check.js
import {
  BURSTS,
  buildShareUrl,
  normalizeTicker,
  parseShareHash,
  pickBurst,
  TICKER_MAX,
  type BurstId,
} from "./share";

let failed = 0;
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.error(`FAIL ${label}: got ${g}, want ${w}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

const ORIGIN = "https://nitzan-massad.github.io";

// ---- 1. the base, both of them -------------------------------------------
eq(
  "production base keeps the project path",
  buildShareUrl("AAPL", ORIGIN, "/MarketPulse/"),
  "https://nitzan-massad.github.io/MarketPulse/#AAPL",
);
eq("dev base is a bare root", buildShareUrl("AAPL", "http://localhost:5173", "/"), "http://localhost:5173/#AAPL");
eq(
  "a base without its trailing slash still joins cleanly",
  buildShareUrl("AAPL", ORIGIN, "/MarketPulse"),
  "https://nitzan-massad.github.io/MarketPulse/#AAPL",
);
eq(
  "a base without its leading slash still joins cleanly",
  buildShareUrl("AAPL", ORIGIN, "MarketPulse/"),
  "https://nitzan-massad.github.io/MarketPulse/#AAPL",
);
eq(
  "a trailing slash on the origin never doubles up",
  buildShareUrl("AAPL", ORIGIN + "/", "/MarketPulse/"),
  "https://nitzan-massad.github.io/MarketPulse/#AAPL",
);
eq("no // ever appears after the host", buildShareUrl("AAPL", ORIGIN + "/", "/MarketPulse/").slice(8).includes("//"), false);

// ---- the link has to actually be short -----------------------------------
eq("the whole production link stays under 50 chars", buildShareUrl("AAPL", ORIGIN, "/MarketPulse/").length <= 50, true);
eq("the hash costs exactly one character more than the symbol", buildShareUrl("AAPL", ORIGIN, "/MarketPulse/").length - buildShareUrl("", ORIGIN, "/MarketPulse/").length, 5);

// ---- 2. normalize / the whitelist ----------------------------------------
eq("a lowercase symbol is uppercased", normalizeTicker("aapl"), "AAPL");
eq("surrounding whitespace is trimmed", normalizeTicker("  msft \n"), "MSFT");
eq("a share class survives", normalizeTicker("brk.b"), "BRK.B");
eq("the longest real symbol is fine", normalizeTicker("GOOGL"), "GOOGL");
eq("a digit after the first char is allowed", normalizeTicker("ABC1"), "ABC1");
eq("empty is not a symbol", normalizeTicker(""), "");
eq("null is not a symbol", normalizeTicker(null), "");
eq("a leading digit is not a symbol", normalizeTicker("1AAPL"), "");
eq("a hyphenated slug is not a symbol", normalizeTicker("section-2"), "");
eq("a path is not a symbol", normalizeTicker("stocks/aapl"), "");
eq("a sentence is not a symbol", normalizeTicker("hello world"), "");
eq("markup is not a symbol", normalizeTicker("<img>"), "");
eq(`over ${TICKER_MAX} chars is not a symbol`, normalizeTicker("ABCDEFGHIJ"), "");

// a ticker we can't normalize must not produce a link into a modal that opens empty
eq("garbage yields the bare app URL, not a broken deep link", buildShareUrl("section-2", ORIGIN, "/MarketPulse/"), "https://nitzan-massad.github.io/MarketPulse/");
eq("...and that URL carries no hash at all", buildShareUrl("section-2", ORIGIN, "/MarketPulse/").includes("#"), false);

// ---- the hash parser -----------------------------------------------------
eq("a plain hash resolves", parseShareHash("#AAPL"), "AAPL");
eq("a lowercase hash resolves uppercased", parseShareHash("#aapl"), "AAPL");
eq("the # is optional", parseShareHash("AAPL"), "AAPL");
eq("a rewritten #/ form resolves", parseShareHash("#/AAPL"), "AAPL");
eq("a percent-encoded share class resolves", parseShareHash("#BRK%2EB"), "BRK.B");
eq("an empty hash is not a share link", parseShareHash(""), null);
eq("a bare # is not a share link", parseShareHash("#"), null);
eq("null is not a share link", parseShareHash(null), null);
// THE REGRESSION this whitelist exists for: any of these opening a modal on load
eq("an anchor link is not a share link", parseShareHash("#section-2"), null);
eq("a router-style path is not a share link", parseShareHash("#/stocks/aapl"), null);
eq("an OAuth fragment is not a share link", parseShareHash("#access_token=abc123"), null);
eq("a malformed escape is not a share link", parseShareHash("#%E0%A4%A"), null);

// ---- 3. round trip -------------------------------------------------------
for (const t of ["AAPL", "T", "GOOGL", "BRK.B", "ABC1"]) {
  const url = buildShareUrl(t, ORIGIN, "/MarketPulse/");
  eq(`round trip ${t}`, parseShareHash(url.slice(url.indexOf("#"))), t);
}
eq("a lowercase input round-trips to the canonical symbol", parseShareHash(buildShareUrl("aapl", ORIGIN, "/").replace(/^[^#]*/, "")), "AAPL");

// ---- 4. the burst roster and the pick -----------------------------------
eq("twenty animations, as designed", BURSTS.length, 20);
eq("no id is duplicated", new Set(BURSTS).size, BURSTS.length);
eq("every id is a usable CSS attribute value", BURSTS.every((b) => /^[a-z]+$/.test(b)), true);

// prev is excluded: drive `rand` across its whole range and prev must never come back
const prev: BurstId = "confetti";
const returned = new Set<BurstId>();
for (let i = 0; i < 200; i++) returned.add(pickBurst(prev, () => i / 200));
eq("the previous burst is never picked again", returned.has(prev), false);
eq("every other burst is reachable", returned.size, BURSTS.length - 1);

// with no previous burst, all 20 are in play
const first = new Set<BurstId>();
for (let i = 0; i < 200; i++) first.add(pickBurst(null, () => i / 200));
eq("a first copy can draw any of the twenty", first.size, BURSTS.length);

// rand() returning exactly 1 must not index past the end (Math.random never does, but a
// seeded generator in a future test might, and an undefined burst renders nothing at all)
eq("rand() === 1 stays in bounds", typeof pickBurst(null, () => 1), "string");
eq("rand() === 1 is a real id", BURSTS.includes(pickBurst(null, () => 1)), true);
eq("rand() === 0 is a real id", BURSTS.includes(pickBurst(null, () => 0)), true);

// a real run: 500 consecutive picks, never twice in a row
let last: BurstId | null = null;
let repeats = 0;
for (let i = 0; i < 500; i++) {
  const b = pickBurst(last);
  if (b === last) repeats++;
  last = b;
}
eq("500 live picks produce no back-to-back repeat", repeats, 0);

if (failed) throw new Error(`${failed} share check(s) failed`);
console.log("\nall share checks passed");
