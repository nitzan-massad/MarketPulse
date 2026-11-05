// Parse TipRanks' "Bulls Say, Bears Say" thesis out of the SSR /stocks/<t> page.
//
// Why this exists: the old source, /stocks/<t>/stock-analysis/payload.json, was retired
// (2026-11: {"data":null,"error":"not found"} for EVERY ticker). That body parsed as JSON with no
// key points, so every ticker counted as "none" and nothing refreshed, silently. The thesis is now
// server-rendered: an <h2>Bulls Say, Bears Say</h2>, then two columns, each opened by
// <h3>…<span>Bulls Say|Bears Say</span></h3> and holding <h4>title</h4><p>body</p> pairs.
//
// Missing section -> THROWS, never returns empty: a challenge page, an error page and a redesign
// must all count as failures, not as "this ticker has no thesis" (the exact bug above).
//
// ponytail: regex over the markup, no cheerio; anchored on text + tag names, never class names.
// Guarded by ci/test-bullbear-html.mjs against a real trimmed ONDS page.

export const unent = (s) =>
  s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x?27;|&#39;/g, "'").replace(/&nbsp;/g, " ").trim();

const head = (name) => new RegExp(`>${name}</span>\\s*</h3>`);

export function parseBullBearHtml(html) {
  const i = html.indexOf("Bulls Say, Bears Say</h2>");
  if (i < 0) throw new Error("no bull/bear section");
  const sec = html.slice(i);
  const col = (name, end) => {
    const a = sec.search(head(name));
    if (a < 0) return [];
    const rest = sec.slice(a);
    // the bull column ends where the bear heading starts; otherwise (bear column, or no bear
    // heading at all) at the column's own </section>
    let b = end ? rest.search(head(end)) : -1;
    if (b < 0) b = rest.indexOf("</section>");
    return [...(b > 0 ? rest.slice(0, b) : rest).matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>\s*<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => ({ t: unent(m[1]), b: unent(m[2]) }))
      .filter((x) => x.t && x.b); // ci/test-payload-files.mjs rejects an empty body in the data gate
  };
  return { bull: col("Bulls Say", "Bears Say"), bear: col("Bears Say") };
}
