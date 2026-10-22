import type { Analytics } from "firebase/analytics";
import { fbP } from "./watchlist";

// Firebase Analytics (GA4). Initializing it turns on auto-collected page views,
// unique/active users, geography and device info. track()/trackUser() add custom
// usage events. All no-ops until init succeeds (and if Firebase isn't configured).
// The SDK is import()ed after Firebase itself (fbP, post-first-render), so it never
// sits in the main chunk; events fired before it lands are dropped, as before.
let A: { a: Analytics; m: typeof import("firebase/analytics") } | null = null;
let uid: string | null = null;

export async function initAnalytics(): Promise<void> {
  const f = await fbP;
  if (!f || A) return;
  try {
    const m = await import("firebase/analytics");
    if (await m.isSupported()) {
      A = { a: m.getAnalytics(f.app), m };
      m.setUserId(A.a, uid); // the user may have resolved before the SDK did
    }
  } catch {
    /* analytics unavailable (private mode / blocked) — silently skip */
  }
}

export function track(event: string, params?: Record<string, unknown>): void {
  if (A) A.m.logEvent(A.a, event, params);
}

// tie events to the signed-in user (uid) when available, anonymous otherwise
export function trackUser(u: string | null): void {
  uid = u;
  if (A) A.m.setUserId(A.a, u);
}
