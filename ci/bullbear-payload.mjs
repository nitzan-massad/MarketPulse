// Parse TipRanks' "Bulls Say, Bears Say" thesis out of /stocks/<t>/stock-aianalyst/payload.json.
//
// Why JSON: since 2026-11-22 Cloudflare hard-blocks GitHub runner IPs on the HTML /stocks/<t> page
// (the previous source), while payload.json still passes. The same points live at
// models.stocks_extra[_id === T].aiAnalysis.keyPoints[] as {sentiment, title, description}.
//
// Missing JSON / no stocks_extra list -> THROWS (challenge page, error body, reshape = failure).
// Ticker missing from stocks_extra -> THROWS. Entry present, no keyPoints -> empty (no thesis).

// FlareSolverr wraps a JSON body in <pre> with HTML entities; a plain fetch returns it raw.
export function extractJson(s) {
  try { return JSON.parse(s); } catch { /* wrapped: fall through */ }
  const pre = s.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!pre) throw new Error("no JSON in response");
  // &amp; last, so "&amp;lt;" stays the literal text "&lt;"
  return JSON.parse(pre[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, "\u00a0").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&"));
}

export function parseBullBearPayload(json, ticker) {
  const list = json?.models?.stocks_extra;
  if (!Array.isArray(list)) throw new Error("no stocks_extra in payload");
  const entry = list.find((e) => String(e?._id ?? "").toUpperCase() === ticker.toUpperCase());
  if (!entry) throw new Error("ticker not in payload"); // reshape / wrong ticker: a failure, never "empty"
  const kp = (entry.aiAnalysis?.keyPoints || []).filter(Boolean);
  const pick = (s) => kp.filter((k) => String(k.sentiment).toLowerCase() === s)
    .map((k) => ({ t: (k.title || "").trim(), b: (k.description || "").trim() }))
    .filter((x) => x.t && x.b); // ci/test-payload-files.mjs rejects an empty body in the data gate
  return { bull: pick("bullish"), bear: pick("bearish") };
}
