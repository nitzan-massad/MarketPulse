// Haptic feedback on a button press, on both phones.
//
// Android: haptic() calls navigator.vibrate with a pattern per kind.
// iPhone: Safari has no vibrate API. iOS 18+ taps when a native <input type="checkbox" switch>
// is toggled, but since iOS 26.5 only by a real finger (a scripted label.click() is silent).
// So the chosen buttons carry <TapSwitch/>: an invisible switch laid over the button that the
// finger actually hits. needsTapSwitch() says when to render it.
//
// ponytail: iPhone gets one light tap per press, whatever the kind, and nothing for
// non-tap moments (drag pick-up/drop, the sign-in result). Upgrade path is a native wrapper.

export type Haptic = "light" | "medium" | "success" | "warning";

export const PATTERNS: Record<Haptic, number | number[]> = {
  light: 10,
  medium: 20,
  success: [12, 60, 12],
  warning: [30, 50, 30],
};

const canVibrate = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

/** Touch screen with no vibrate API (iPhone Safari): the tap has to come from an on-screen
 *  switch. Desktop Safari/Firefox also lack vibrate, but have no haptics to gain. */
export const needsTapSwitch = (): boolean =>
  typeof navigator !== "undefined" &&
  !canVibrate() &&
  typeof matchMedia === "function" &&
  matchMedia("(pointer: coarse)").matches;

export function haptic(kind: Haptic = "light"): void {
  if (!canVibrate()) return;
  try {
    navigator.vibrate(PATTERNS[kind]);
  } catch {
    // haptics are a nicety; never let one break the action it decorates
  }
}
