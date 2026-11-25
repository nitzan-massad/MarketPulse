import { useEffect, useRef } from "react";
import { needsTapSwitch } from "../haptics";

/**
 * iPhone haptics (see src/haptics.ts). Put it as the last child of a button: an invisible
 * native switch covers the button, so the finger toggles it (iOS taps), then the click is
 * stopped here and re-sent to the button, whose own onClick runs exactly once. Renders
 * only on touch screens without navigator.vibrate (iPhone); haptic() covers Android.
 */
export default function TapSwitch() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sw = ref.current;
    if (!sw) return;
    // The real click never reaches React; the button gets a re-sent one instead. It is sent
    // on `change`, after the toggle (and its tap) has completed: many of these buttons
    // unmount on the render their click causes, and a switch removed mid-click never taps.
    // `change` still runs inside the gesture, so Share and the sign-in popup keep it.
    const stop = (e: Event) => e.stopPropagation();
    const resend = () => sw.parentElement?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    sw.addEventListener("click", stop);
    sw.addEventListener("change", resend);
    return () => {
      sw.removeEventListener("click", stop);
      sw.removeEventListener("change", resend);
    };
  }, []);
  if (!needsTapSwitch()) return null;
  // `switch` is a WebKit attribute React doesn't know; passed through as a plain attribute.
  return <input ref={ref} type="checkbox" className="tap-sw" aria-hidden="true" tabIndex={-1} {...{ switch: "" }} />;
}
