// npx tsc src/featureFlags.check.ts --outDir node_modules/.tmp/checks --module commonjs \
//   --target es2020 --lib es2020,dom --esModuleInterop --skipLibCheck
//
// resolveFlags is the whole flag system. It is pure so it can be checked without a browser:
// the wrapper around it only reads location/localStorage and hands the strings over.

import { resolveFlags } from "./featureFlags";

let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return;
  console.log(`FAIL ${label}: got ${g}, want ${w}`);
  failed++;
}

eq("nothing set", resolveFlags("", null), []);
eq("url turns one on", resolveFlags("?ff=feed", null), ["feed"]);
eq("stored persists", resolveFlags("", '["feed"]'), ["feed"]);
eq("url adds to stored", resolveFlags("?ff=charts", '["feed"]'), ["charts", "feed"]);
eq("minus removes", resolveFlags("?ff=-feed", '["feed"]'), []);
eq("several at once", resolveFlags("?ff=feed,charts", null), ["charts", "feed"]);
eq("add and remove together", resolveFlags("?ff=charts,-feed", '["feed"]'), ["charts"]);
eq("other params ignored", resolveFlags("?t=AAPL&ff=feed", null), ["feed"]);
eq("no duplicates", resolveFlags("?ff=feed,feed", '["feed"]'), ["feed"]);
eq("always sorted", resolveFlags("?ff=zeta,alpha", null), ["alpha", "zeta"]);
eq("blank entries dropped", resolveFlags("?ff=feed,,%20,-", null), ["feed"]);
// Corrupt storage must not take the app down — a bad value is simply no flags.
eq("garbage storage", resolveFlags("", "not json"), []);
eq("wrong-shaped storage", resolveFlags("", '{"feed":true}'), []);
eq("non-string members dropped", resolveFlags("", '["feed",3,null]'), ["feed"]);

if (failed) throw new Error(`${failed} check(s) failed`);
console.log("featureFlags OK — url on/off, persistence, merge, sort, dedupe, corrupt storage");
