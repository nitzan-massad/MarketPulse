// Every deploy (data refresh, ~3h) writes /version.json with a new build id. When it changes,
// reload the tab the next time it is hidden, so it picks up fresh data and chunks without
// interrupting the user. The open stock (#hash) and section survive the reload.
declare const __BUILD_ID__: string;

export function startAutoUpdate() {
  if (!import.meta.env.PROD) return;
  let stale = false;
  const reloadIfHidden = () => stale && document.hidden && location.reload();
  const check = async () => {
    try {
      const r = await fetch("/version.json", { cache: "no-store" });
      const { id } = await r.json();
      if (id && id !== __BUILD_ID__) stale = true;
    } catch {
      return; // offline / mid-deploy: try next tick
    }
    reloadIfHidden();
  };
  setInterval(check, 10 * 60_000);
  document.addEventListener("visibilitychange", () => (stale ? reloadIfHidden() : document.hidden && check()));
}
