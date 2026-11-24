// Upstream endpoints and payload key names come from env (Actions secrets SRC_BASE and SRC_MAP),
// so the repo names no host, path or vendor key. Unset (tests, local runs) -> provider.example and
// the neutral defaults below, which is also the shape the fixtures use.
//   SRC_BASE  https://host
//   SRC_MAP   one line, `name=value;name=value` (values may contain `=` and `&`, never `;`)
const DEFAULTS = {
  // URL path templates; {t} = lower-cased, URI-encoded ticker
  universe: "/universe",
  screener: "/screener",
  screenerPage: "/screener-page",
  analysis: "/stocks/{t}/analysis.json",
  forecast: "/stocks/{t}/forecast.json",
  // payload key names
  essential: "essentialData",
  scoreData: "scoreData",
  score: "score",
  outlook: "outlookData",
  stockScore: "stockScore",
  // firm-name prefix the provider uses for its own AI-model ratings
  aiFirm: "Provider",
};

const parse = (s) => Object.fromEntries(
  String(s || "").split(";").map((kv) => kv.trim()).filter(Boolean)
    .map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }),
);

const MAP = { ...DEFAULTS, ...parse(process.env.SRC_MAP) };
export const SRC_BASE = (process.env.SRC_BASE || "https://provider.example").replace(/\/$/, "");

/** A key name or value from SRC_MAP (neutral default when unset). */
export const src = (name) => {
  if (!(name in MAP)) throw new Error(`source: unknown name "${name}"`);
  return MAP[name];
};

/** Full upstream URL for `kind`, with {t} filled from `ticker`. */
export const srcUrl = (kind, ticker = "") =>
  SRC_BASE + src(kind).replaceAll("{t}", encodeURIComponent(String(ticker).toLowerCase()));

/** True when a forecast row's firm is the provider's own AI model (excluded from human counts). */
export const isProviderAiFirm = (firm) =>
  new RegExp(`^${src("aiFirm").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(firm || "");
