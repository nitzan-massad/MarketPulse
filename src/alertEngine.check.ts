// Dependency-free self-check for the alert ratchet. No test framework by design.
//
// LOCKED LOGIC (see the header of alertEngine.ts): every expectation below is a product
// decision. Do not edit an expectation to make a code change pass without a direct
// instruction from the repo owner — that edit IS the logic change.
//
// The alert matrix, as agreed (stock tracked at $100; ref = price of the last alert):
//   1 move < 5% from ref           -> no alert
//   2 up >= 5% from ref            -> "up" alert, ref resets to the price
//   3 down >= 5% from ref          -> "down" alert, ref resets to the price
//   4 < 5% after an alert          -> no alert
//   5 another 5% after an alert    -> alert showing the move SINCE THAT ALERT, not since added
//   6 reversal after an alert      -> alert in the new direction, its own %
//   7 small moves that add up      -> alert once the sum from ref reaches 5%
//   8 one big gap                  -> ONE alert carrying the whole move
//   9 tick right after an alert    -> suppressed (stale-ref double-alert guard)
//  10 missing / zero price         -> nothing
//  11 newly watched                -> meta seeded at that price, no alert
//  12 removed then re-added        -> fresh baseline at the new price
//  13 display                      -> colored block with the % since the last alert, the ticker,
//                                     gray "−30% since 10/03" ("since tracked" on older meta);
//                                     legacy rows (pct only) show their old % and no gray %
//
// Run:
//   npx tsc src/alertEngine.ts src/alertEngine.check.ts --outDir /tmp/ae \
//     --module commonjs --target es2020 --lib es2020,dom --resolveJsonModule \
//     --esModuleInterop --skipLibCheck \
//   && node /tmp/ae/alertEngine.check.js
import {
  ALERT_THRESHOLD,
  alertView,
  evalAlert,
  fireAlerts,
  reconcileMeta,
  reFireSuppressed,
  type Meta,
} from "./alertEngine";

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

eq("threshold is 5%", ALERT_THRESHOLD, 0.05);

const DAY = 86_400_000;
const ADDED = Date.UTC(2026, 9, 3, 15); // 2026-10-03, when the ticker was "added"
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10); // stand-in for the UI's date format

// ---- evalAlert: one price vs one meta -----------------------------------------------------------
const fresh = { addPx: 100, ref: 100 };
eq("1  +4% -> null", evalAlert(104, fresh), null);
eq("1  -4% -> null", evalAlert(96, fresh), null);
eq("1  +4.99% -> null (just under)", evalAlert(104.99, fresh), null);
eq("1  -4.99% -> null (just under)", evalAlert(95.01, fresh), null);
eq("1  unchanged -> null", evalAlert(100, fresh), null);
eq("2  exactly +5% fires up", evalAlert(105, fresh), { dir: "up", pct: 5, newRef: 105 });
eq("2  +12% fires up", evalAlert(112, fresh), { dir: "up", pct: 12, newRef: 112 });
eq("3  exactly -5% fires down", evalAlert(95, fresh), { dir: "down", pct: -5, newRef: 95 });
eq("3  -6% fires down", evalAlert(94, fresh), { dir: "down", pct: -6, newRef: 94 });
eq("4  -3% after a -6% alert -> null", evalAlert(91.18, { addPx: 100, ref: 94 }), null);
eq("4  +3% after a -6% alert -> null", evalAlert(96.82, { addPx: 100, ref: 94 }), null);
eq("5  -5% after a -6% alert shows -5, not -11", evalAlert(89.3, { addPx: 100, ref: 94 }), { dir: "down", pct: -5, newRef: 89.3 });
eq("5  +5% after a +5% alert shows +5, not +10", evalAlert(110.25, { addPx: 100, ref: 105 }), { dir: "up", pct: 5, newRef: 110.25 });
eq("6  reversal: -5% from a raised ref fires down -5 though flat vs add", evalAlert(99.75, { addPx: 100, ref: 105 }), {
  dir: "down",
  pct: -5,
  newRef: 99.75,
});
eq("6  reversal: +6% from a lowered ref fires up +6", evalAlert(99.64, { addPx: 100, ref: 94 }), { dir: "up", pct: 6, newRef: 99.64 });
eq("8  one -20% gap -> one alert carrying -20", evalAlert(80, fresh), { dir: "down", pct: -20, newRef: 80 });
eq("8  one +50% gap -> one alert carrying +50", evalAlert(150, fresh), { dir: "up", pct: 50, newRef: 150 });
eq("%  rounds to the nearest whole percent", evalAlert(79.6, fresh)?.pct, -20);
eq("%  rounds half up", evalAlert(106.5, fresh)?.pct, 7);
eq("10 zero current -> null", evalAlert(0, fresh), null);
eq("10 negative current -> null", evalAlert(-5, fresh), null);
eq("10 NaN current -> null", evalAlert(NaN, fresh), null);
eq("10 zero ref -> null", evalAlert(105, { addPx: 100, ref: 0 }), null);
eq("10 zero addPx -> null", evalAlert(105, { addPx: 0, ref: 100 }), null);

// ---- reFireSuppressed: the in-memory guard -------------------------------------------------------
eq("9  within threshold of last fire -> suppressed", reFireSuppressed(93, 95), true);
eq("9  same price (StrictMode double-invoke) -> suppressed", reFireSuppressed(95, 95), true);
eq("9  just under a full threshold up -> suppressed", reFireSuppressed(99.7, 95), true);
eq("9  another full threshold down -> allowed", reFireSuppressed(90.25, 95), false);
eq("9  another full threshold up -> allowed", reFireSuppressed(99.75, 95), false);
eq("9  no prior fire -> allowed", reFireSuppressed(93, undefined), false);
eq("9  non-positive price -> allowed (evalAlert already rejects it)", reFireSuppressed(0, 95), false);

// ---- reconcileMeta: seeding and pruning ---------------------------------------------------------
{
  const last: Record<string, number> = {};
  eq("11 newly watched with a price -> seeded at that price, stamped with the add time", reconcileMeta(["AAPL"], { AAPL: 210.5 }, {}, last, ADDED), [["AAPL", { addPx: 210.5, ref: 210.5, addAt: ADDED }]]);
  eq("11 newly watched without a price yet -> nothing (waits for one)", reconcileMeta(["AAPL"], {}, {}, last), []);
  eq("11 already seeded -> untouched (never re-seeded at a later price)", reconcileMeta(["AAPL"], { AAPL: 230 }, { AAPL: { addPx: 210, ref: 220 } }, last), []);
  const lf: Record<string, number> = { MU: 95, AAPL: 200 };
  eq("12 unwatched -> deleted", reconcileMeta(["AAPL"], { AAPL: 200 }, { AAPL: { addPx: 200, ref: 200 }, MU: { addPx: 100, ref: 95 } }, lf), [["MU", null]]);
  eq("12 unwatched -> its re-fire memory dropped, others kept", lf, { AAPL: 200 });
}

// ---- fireAlerts: one pass over the watchlist ----------------------------------------------------
{
  const last: Record<string, number> = {};
  const meta: Record<string, Meta> = { CRDO: { addPx: 210, ref: 182.28 }, AAPL: { addPx: 200, ref: 200 } };
  const r = fireAlerts(["CRDO", "AAPL"], { CRDO: 162.77, AAPL: 203 }, meta, last);
  eq("multi-ticker: only the one that crossed fires", r.alerts, [{ ticker: "CRDO", dir: "down", since: -11, total: -22 }]);
  eq("multi-ticker: only its ref is reset, addPx kept", r.writes, [["CRDO", { addPx: 210, ref: 162.77 }]]);
  eq("multi-ticker: last-fire price remembered", last, { CRDO: 162.77 });
  eq("9  same pass re-run before the ref write lands -> nothing (StrictMode)", fireAlerts(["CRDO"], { CRDO: 162.77 }, meta, last), { alerts: [], writes: [] });
  eq("9  stale ref (write reverted) + tick 2% lower -> suppressed (MU regression)", fireAlerts(["CRDO"], { CRDO: 159.5 }, meta, last), { alerts: [], writes: [] });
  eq(
    "5  stale ref but a full 5% below the last fire -> fires, % from the ref it was evaluated on",
    fireAlerts(["CRDO"], { CRDO: 147.29 }, meta, last).alerts,
    [{ ticker: "CRDO", dir: "down", since: -19, total: -30 }],
  );
}
{
  const last: Record<string, number> = {};
  eq("10 no price for the ticker -> nothing", fireAlerts(["X"], {}, { X: fresh }, last), { alerts: [], writes: [] });
  eq("10 no meta yet (seeding pending) -> nothing", fireAlerts(["X"], { X: 50 }, {}, last), { alerts: [], writes: [] });
  eq("10 meta for an unwatched ticker -> never fires", fireAlerts([], { X: 50 }, { X: fresh }, last), { alerts: [], writes: [] });
}

// ---- scenarios: the ratchet across days, applying writes like the hook does ---------------------
function run(prices: number[], addPx = 100): { since: number; dir: string }[] {
  const meta: Record<string, Meta> = {};
  const last: Record<string, number> = {};
  const out: { since: number; dir: string }[] = [];
  const apply = (ws: [string, Meta | null][]) => {
    for (const [t, m] of ws) if (m) meta[t] = m; else delete meta[t];
  };
  apply(reconcileMeta(["T"], { T: addPx }, meta, last, ADDED));
  for (const px of prices) {
    const { alerts, writes } = fireAlerts(["T"], { T: px }, meta, last);
    apply(writes);
    for (const a of alerts) out.push({ since: a.since, dir: a.dir });
  }
  return out;
}
eq("4  the user's case: -6% alerts, next day -3% is quiet", run([94, 91.18]), [{ since: -6, dir: "down" }]);
eq("5  -6%, -3%, then -5% from the alert price -> two alerts, second shows -5", run([94, 91.18, 89.3]), [
  { since: -6, dir: "down" },
  { since: -5, dir: "down" },
]);
eq("7  +3% then +3% -> one alert at +6% (sum from ref)", run([103, 106.09]), [{ since: 6, dir: "up" }]);
eq("7  +3% then -3% then +3% -> never 5% from ref, no alert", run([103, 99.91, 102.9]), []);
eq("6  up 5% then back down 5% -> up then down", run([105, 99.75]), [
  { since: 5, dir: "up" },
  { since: -5, dir: "down" },
]);
eq("8  one -20% gap -> exactly one alert", run([80]), [{ since: -20, dir: "down" }]);
eq("8  a gap then flat ticks -> still one alert", run([80, 80, 79.5, 80.3]), [{ since: -20, dir: "down" }]);
eq("CRDO 2026-10: 182.28 -> 162.77 -> 147.29 alerts -11 then -10", run([162.77, 147.29], 182.28), [
  { since: -11, dir: "down" },
  { since: -10, dir: "down" },
]);
{
  const meta: Record<string, Meta> = {};
  const last: Record<string, number> = {};
  const apply = (ws: [string, Meta | null][]) => {
    for (const [t, m] of ws) if (m) meta[t] = m; else delete meta[t];
  };
  apply(reconcileMeta(["T"], { T: 100 }, meta, last, ADDED));
  apply(fireAlerts(["T"], { T: 94 }, meta, last).writes);
  apply(reconcileMeta([], { T: 94 }, meta, last));
  apply(reconcileMeta(["T"], { T: 60 }, meta, last, ADDED + 5 * DAY));
  eq("12 removed then re-added at 60 -> fresh baseline at 60, new add time", meta, { T: { addPx: 60, ref: 60, addAt: ADDED + 5 * DAY } });
  eq("12 re-added: 57 (-5% from the new 60 baseline) fires", fireAlerts(["T"], { T: 57 }, meta, last).alerts, [
    { ticker: "T", dir: "down", since: -5, total: -5, addAt: ADDED + 5 * DAY },
  ]);
}

{
  // the gray % keeps counting from the add price across alerts, while the big % restarts each time
  const meta: Record<string, Meta> = { T: { addPx: 100, ref: 100 } };
  const last: Record<string, number> = {};
  const step = (px: number) => {
    const r = fireAlerts(["T"], { T: px }, meta, last);
    for (const [t, m] of r.writes) if (m) meta[t] = m;
    return r.alerts.map((x) => [x.since, x.total]);
  };
  eq("13 first alert: since == total", step(94), [[-6, -6]]);
  eq("13 quiet day in between", step(91.18), []);
  eq("13 second alert: since -5, total -11", step(89.3), [[-5, -11]]);
  eq("13 rebound alert: since +6, total still -5", step(94.66), [[6, -5]]);
}

{
  const meta: Record<string, Meta> = { T: { addPx: 100, ref: 100, addAt: ADDED } };
  const r = fireAlerts(["T"], { T: 94 }, meta, {});
  eq("13 the add time rides on the alert", r.alerts, [{ ticker: "T", dir: "down", since: -6, total: -6, addAt: ADDED }]);
  eq("13 ...and survives the ref reset", r.writes, [["T", { addPx: 100, ref: 94, addAt: ADDED }]]);
  eq("13 older meta without addAt -> no addAt key at all (Firebase rejects undefined)", "addAt" in fireAlerts(["T"], { T: 94 }, { T: fresh }, {}).alerts[0], false);
}

// ---- alertView: what the row shows --------------------------------------------------------------
eq("13 down: colored block % since last alert + gray % since the add date", alertView({ since: -10, total: -30, addAt: ADDED }, iso), { pct: "−10%", total: "−30% since 2026-10-03" });
eq("13 up: plus signs", alertView({ since: 6, total: 12, addAt: ADDED }, iso), { pct: "+6%", total: "+12% since 2026-10-03" });
eq("13 mixed: up since the last alert, still down since tracked", alertView({ since: 5, total: -8, addAt: ADDED }, iso), { pct: "+5%", total: "−8% since 2026-10-03" });
eq("13 flat since tracked shows +0%, not hidden", alertView({ since: -5, total: 0, addAt: ADDED }, iso).total, "+0% since 2026-10-03");
eq("13 the date goes through the formatter it is given", alertView({ since: 5, total: 5, addAt: ADDED }, () => "10/03").total, "+5% since 10/03");
eq("13 meta older than addAt -> \"since tracked\"", alertView({ since: -5, total: -11 }, iso), { pct: "−5%", total: "−11% since tracked" });
eq("13 since wins over a legacy pct", alertView({ since: -5, pct: -30, total: -30 }, iso).pct, "−5%");
eq("13 legacy row: old cumulative %, no gray line", alertView({ pct: -30 }, iso), { pct: "−30%", total: null });
eq("13 nothing at all -> +0%, no gray line", alertView({}, iso), { pct: "+0%", total: null });

if (failed) throw new Error(`${failed} alertEngine check(s) failed`);
console.log("\nall alertEngine checks passed");
