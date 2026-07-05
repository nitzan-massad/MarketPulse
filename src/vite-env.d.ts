/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FINNHUB_KEY?: string;
  readonly VITE_TWELVEDATA_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
