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
        // The Firebase chunk (+ its own imports) is import()ed only after first render, so its
        // download used to start then. modulepreload fetches it alongside the main chunk; it still
        // runs after first render. Every visit loads it, so this adds no bytes.
        const fb = Object.keys(ctx.bundle ?? {}).find((k) => /\/firebase-[\w-]+\.js$/.test(k));
        if (!fb) throw new Error("preload-stocks: firebase chunk not in the bundle");
        const fbChunk = ctx.bundle![fb];
        const fbFiles = [fb, ...(fbChunk.type === "chunk" ? fbChunk.imports : [])].filter((k) => {
          const c = ctx.bundle![k];
          return !(c?.type === "chunk" && c.isEntry);
        });
        return [
          { tag: "link", attrs: { rel: "preload", as: "fetch", crossorigin: true, href: base + f }, injectTo: "head-prepend" },
          ...fbFiles.map((k) => ({ tag: "link", attrs: { rel: "modulepreload", crossorigin: true, href: base + k }, injectTo: "head" as const })),
        ];
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
