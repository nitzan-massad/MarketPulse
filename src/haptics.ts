// Haptic feedback on a button press, on both phones.
//
// Android: navigator.vibrate with a pattern per kind.
// iPhone: Safari has no vibrate API, but since iOS 18 toggling a native
// <input type="checkbox" switch> plays the system tap. We keep one hidden switch and
// click its label. iOS has a single strength, so every kind is the same light tap there.
//
// ponytail: the iOS tap only fires inside a user gesture, so call this before any await.
// The sign-in result arrives after the popup, so it is silent on iPhone (Android buzzes);
// older iOS gets nothing. Upgrade path is a native wrapper.

export type Haptic = "light" | "medium" | "success" | "warning";

export const PATTERNS: Record<Haptic, number | number[]> = {
  light: 10,
  medium: 20,
  success: [12, 60, 12],
  warning: [30, 50, 30],
};

let iosSwitch: HTMLLabelElement | null = null;

export function haptic(kind: Haptic = "light"): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(PATTERNS[kind]);
      return;
    }
    if (typeof document === "undefined") return;
    if (!iosSwitch) {
      iosSwitch = document.createElement("label");
      iosSwitch.setAttribute("aria-hidden", "true");
      iosSwitch.style.display = "none";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.tabIndex = -1;
      input.setAttribute("switch", "");
      iosSwitch.appendChild(input);
      document.body.appendChild(iosSwitch);
    }
    iosSwitch.click();
  } catch {
    // haptics are a nicety; never let one break the action it decorates
  }
}
