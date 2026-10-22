// The shared Cloudflare Worker (worker/): /quotes (CNBC, cached), /bars (CNBC chart bars,
// cached), /live (Finnhub WS relay) and the "Track this stock" dispatch. VITE_WORKER_URL points `npm run dev` at a local
// `wrangler dev`. Kept out of the pure modules: their checks compile to CommonJS, which
// has no `import.meta`.
export const WORKER_URL: string =
  import.meta.env.VITE_WORKER_URL || "https://marketpulse-track.nitzanmassad.workers.dev";
