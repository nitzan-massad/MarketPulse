// Dependency-free self-check for haptics.ts. No test framework by design
// (mirrors fmtPx.check.ts).
//
// Guards the platform split: Android (vibrate present) gets the kind's pattern and must
// NOT touch the DOM; iPhone (no vibrate) must click one hidden label wrapping a real
// <input type="checkbox" switch>, attached to the page once. Drop any of those and iOS
// silently stops tapping, with nothing else to notice it.
//
// Run:
//   npx tsc src/haptics.ts src/haptics.check.ts --outDir /tmp/hp \
//     --module commonjs --target es2020 --lib es2020,dom --skipLibCheck \
//   && node /tmp/hp/haptics.check.js

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

const g = globalThis as Record<string, unknown>;

// ---- iPhone: no vibrate, fake DOM that records what is built --------------------
interface FakeEl {
  tag: string;
  type?: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  children: FakeEl[];
  clicks: number;
  setAttribute(k: string, v: string): void;
  appendChild(c: FakeEl): void;
  click(): void;
}
const made: FakeEl[] = [];
const attached: FakeEl[] = [];
Object.defineProperty(g, "navigator", { value: {}, configurable: true });
g.document = {
  createElement(tag: string): FakeEl {
    const el: FakeEl = {
      tag, attrs: {}, style: {}, children: [], clicks: 0,
      setAttribute(k, v) { el.attrs[k] = v; },
      appendChild(c) { el.children.push(c); },
      click() { el.clicks++; },
    };
    made.push(el);
    return el;
  },
  body: { appendChild(el: FakeEl) { attached.push(el); } },
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { haptic, PATTERNS } = require("./haptics") as typeof import("./haptics");

haptic("success");
haptic("warning");
const label = attached[0];
const input = label?.children[0];
eq("iOS: one element attached to the page", attached.length, 1);
eq("iOS: attached element is a label", label?.tag, "label");
eq("iOS: label hidden from screen readers", label?.attrs["aria-hidden"], "true");
eq("iOS: label wraps an input", input?.tag, "input");
eq("iOS: input is a checkbox", input?.type, "checkbox");
eq("iOS: input has the switch attribute", "switch" in (input?.attrs ?? {}), true);
eq("iOS: label clicked once per call", label?.clicks, 2);
eq("iOS: built once (label + input)", made.length, 2);

// ---- Android: vibrate present ------------------------------------------------
const calls: unknown[] = [];
Object.defineProperty(g, "navigator", { value: { vibrate: (p: unknown) => (calls.push(p), true) }, configurable: true });
haptic("success");
haptic();
eq("Android: success pattern", calls[0], PATTERNS.success);
eq("Android: default is light", calls[1], PATTERNS.light);
eq("Android: no extra switch clicks", label?.clicks, 2);

// ---- never throws --------------------------------------------------------------
Object.defineProperty(g, "navigator", { value: { vibrate: () => { throw new Error("x"); } }, configurable: true });
let threw = false;
try { haptic("medium"); } catch { threw = true; }
eq("swallows platform errors", threw, false);

if (failed) process.exit(1);
