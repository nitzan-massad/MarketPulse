// Dependency-free self-check for quoteStore.ts — the quotes the page already holds, which the
// stock modal opens on instead of re-fetching. Freshness must follow the session's own poll
// cadence: a held quote older than one poll is not "live" any more.
// Run (from repo root):
//   npx tsc src/quoteStore.ts src/quoteStore.check.ts --outDir /tmp/qs \
//     --module commonjs --target es2020 --lib es2020,dom --strict --skipLibCheck \
//   && node /tmp/qs/quoteStore.check.js
import { freshQuote, putQuotes } from "./quoteStore";
import type { CnbcQuote } from "./quotes";

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
const Q = (px: number): CnbcQuote => ({
  px, chg: 1, pct: 1, pc: px - 1, day: "2026-10-22", o: null, h: null, l: null, ext: null,
  name: "Co", mc: 1, hi52: 1, lo52: 1, pe: 1, fpe: 1, eps: 1, beta: 1, vol10: 1,
});
const at = (iso: string) => Date.parse(iso);
const NOON = at("2026-10-22T16:00:00Z"); // Thu 12:00 ET, regular session (cadence 20 s)
const NIGHT = at("2026-10-23T02:00:00Z"); // 22:00 ET, closed (cadence 30 min)

putQuotes({ AAPL: Q(100), QNCX: null, "BRK.B": Q(480) }, NOON);
eq("held quote, just polled -> returned", freshQuote("AAPL", NOON + 1_000)?.px, 100);
eq("in session: still fresh at 25 s (20 s cadence + slack)", freshQuote("AAPL", NOON + 25_000)?.px, 100);
eq("in session: older than one poll -> not returned", freshQuote("AAPL", NOON + 25_001), null);
eq("a null (CNBC lacks it) is never stored", freshQuote("QNCX", NOON), null);
eq("never held -> null", freshQuote("MSFT", NOON), null);
eq("app tickers are normalized like the poll (BRK-B -> BRK.B)", freshQuote("BRK-B", NOON)?.px, 480);
eq("junk ticker -> null", freshQuote("", NOON), null);
putQuotes({ AAPL: Q(101) }, NIGHT);
eq("closed: a quote from 20 min ago is still fresh (30 min cadence)", freshQuote("AAPL", NIGHT + 20 * 60_000)?.px, 101);
eq("closed: older than the cadence -> null", freshQuote("AAPL", NIGHT + 36 * 60_000), null);
eq("a newer poll replaces the held quote", freshQuote("AAPL", NIGHT)?.px, 101);

if (failed) throw new Error(`${failed} quoteStore check(s) failed`);
console.log("\nall quoteStore checks passed");
