// Dependency-free self-check for haptics.ts. No test framework by design
// (mirrors fmtPx.check.ts).
//
// Guards the platform split: Android (vibrate present) gets the kind's pattern and no
// on-screen switch; iPhone (no vibrate) gets the switch (TapSwitch) and haptic() stays a
// no-op — a scripted tap is silent on iOS 26.5+ and would double-tap on older iOS.
//
// Run:
//   npx tsc src/haptics.ts src/haptics.check.ts --outDir /tmp/hp \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/hp/haptics.check.js
import { haptic, needsTapSwitch, PATTERNS } from "./haptics";

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

const setNav = (v: unknown) => Object.defineProperty(globalThis, "navigator", { value: v, configurable: true });

// ---- iPhone: no vibrate, touch screen ------------------------------------------
// A document that records any DOM work: haptic() must do none (no scripted-switch comeback).
const domCalls: string[] = [];
const g = globalThis as Record<string, unknown>;
g.document = {
  createElement: (t: string) => (domCalls.push(`create ${t}`), {}),
  body: { appendChild: () => domCalls.push("append") },
};
const setPointer = (coarse: boolean) => { g.matchMedia = (q: string) => ({ matches: coarse && q === "(pointer: coarse)" }); };
setNav({});
setPointer(true);
eq("iOS: needs the on-screen switch", needsTapSwitch(), true);
haptic("success");
eq("iOS: haptic() touches no DOM", domCalls, []);

// ---- desktop Safari/Firefox: no vibrate, fine pointer ----------------------------
setPointer(false);
eq("desktop without vibrate: no switch", needsTapSwitch(), false);
setPointer(true);

// ---- Android: vibrate present ------------------------------------------------
const calls: unknown[] = [];
setNav({ vibrate: (p: unknown) => (calls.push(p), true) });
eq("Android: no on-screen switch", needsTapSwitch(), false);
haptic("success");
haptic("warning");
haptic();
eq("Android: patterns per kind, default light", calls, [PATTERNS.success, PATTERNS.warning, PATTERNS.light]);

// ---- never throws --------------------------------------------------------------
setNav({ vibrate: () => { throw new Error("x"); } });
let threw = false;
try { haptic("medium"); } catch { threw = true; }
eq("swallows platform errors", threw, false);

if (failed) process.exit(1);
