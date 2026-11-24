import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startAutoUpdate } from "./autoUpdate";
import "./index.css";

// iOS Safari ignores user-scalable=no in the viewport meta; this is what actually stops pinch-zoom.
for (const ev of ["gesturestart", "gesturechange"]) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

startAutoUpdate();

// Last resort if the idle prefetch missed (offline, or a deploy landed before it ran): a failed
// chunk import reloads once onto the new build instead of white-screening. The flag stops a loop
// on a genuinely missing chunk; it clears after 30s so a later deploy can recover the same way.
addEventListener("vite:preloadError", (e) => {
  if (!navigator.onLine) return; // offline: reloading would show the browser error page
  try {
    if (sessionStorage.getItem("mp_chunk_reload")) return;
    sessionStorage.setItem("mp_chunk_reload", "1");
  } catch {
    return;
  }
  e.preventDefault();
  location.reload();
});
setTimeout(() => {
  try { sessionStorage.removeItem("mp_chunk_reload"); } catch { /* storage blocked */ }
}, 30_000);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
