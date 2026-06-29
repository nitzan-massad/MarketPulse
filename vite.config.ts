import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Project-page base for GitHub Pages (https://nitzan-massad.github.io/MarketPulse/);
// dev server stays at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/MarketPulse/" : "/",
  plugins: [react()],
}));
