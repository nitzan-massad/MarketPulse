import { getAnalytics, isSupported, logEvent, setUserId, type Analytics } from "firebase/analytics";
import { app, firebaseReady } from "./watchlist";

// Firebase Analytics (GA4). Initializing it turns on auto-collected page views,
// unique/active users, geography and device info. track()/trackUser() add custom
// usage events. All no-ops until init succeeds (and if Firebase isn't configured).
let analytics: Analytics | null = null;

export async function initAnalytics(): Promise<void> {
  if (!firebaseReady || !app || analytics) return;
  try {
    if (await isSupported()) analytics = getAnalytics(app);
  } catch {
    /* analytics unavailable (private mode / blocked) — silently skip */
  }
}

export function track(event: string, params?: Record<string, unknown>): void {
  if (analytics) logEvent(analytics, event, params);
}

// tie events to the signed-in user (uid) when available, anonymous otherwise
export function trackUser(uid: string | null): void {
  if (analytics) setUserId(analytics, uid);
}
