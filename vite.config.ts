import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// stocks.ts imports src/data/stocks.json with `?url`, so the build emits it as a hashed asset
// instead of inlining ~700 KB into the JS. This adds a <link rel=preload> for that hashed file so
// the fetch starts with the HTML, in parallel with the JS. The source file stays in src/data/
// (CI writes it there and the tests read it off disk). Build only: dev fetches it unhashed.
const preloadStocks = (): Plugin => {
  let base = "/";
  return {
    name: "preload-stocks",
    apply: "build",
    configResolved: (c) => void (base = c.base),
    transformIndexHtml: {
      order: "post",
      handler: (_html, ctx) => {
        const f = Object.keys(ctx.bundle ?? {}).find((k) => /\/stocks-[\w-]+\.json$/.test(k));
        if (!f) throw new Error("preload-stocks: hashed stocks.json not in the bundle");
        return [{ tag: "link", attrs: { rel: "preload", as: "fetch", crossorigin: true, href: base + f }, injectTo: "head-prepend" }];
      },
    },
  };
};

// Project-page base for GitHub Pages (https://nitzan-massad.github.io/MarketPulse/);
// dev server stays at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/MarketPulse/" : "/",
  plugins: [react(), preloadStocks()],
}));
