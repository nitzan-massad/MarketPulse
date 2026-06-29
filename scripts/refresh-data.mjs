// Refreshes src/data/stocks.json + meta.json from TipRanks' screener API.
// Runs a real (headless) Chromium so it passes Cloudflare's JS challenge, then
// does the same in-page fetch the app's data was originally pulled with.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const API =
  "https://www.tipranks.com/api/apps/stock/screener?country=us&method=screener&isPrimaryMarket=true&exchange=xnas&exchange=xnys&exchange=arcx&exchange=xase&exchange=bats&page=1&pageSize=120&sortDir=2";

// runs inside the page (has Cloudflare clearance) — mirrors the original pull
async function pull(page) {
  return page.evaluate(async (base) => {
    const sorts = [5, 2, 3]; // upside, smart score, market cap
    const seen = new Map();
    const rnd = (x, p = 2) => (x == null ? null : +Number(x).toFixed(p));
    let total = null;
    for (const sb of sorts) {
      const r = await fetch(base + "&sortBy=" + sb, { headers: { accept: "application/json" } });
      const j = await r.json();
      if (total == null) total = j.totalCount ?? null;
      for (const it of j.items || []) {
        const t = it.tradingInformationData || {};
        const e = it.tipRanksEssentialData || {};
        if (seen.has(t.ticker)) continue;
        const bpt = e.bestPriceTargetData || {};
        const bc = e.bestAnalystsConsensusData || {};
        const d = bc.distribution || {};
        const ai = it.aiAnalystData || {};
        seen.set(t.ticker, {
          t: t.ticker, n: t.companyName, sec: t.sector?.name || null,
          px: rnd(t.lastClose), chg: rnd(t.priceChangePct != null ? t.priceChangePct * 100 : null, 2),
          pt: rnd(bpt.convertedPriceTarget), up: rnd(bpt.upside != null ? bpt.upside * 100 : null, 1),
          con: bc.analystConsensus?.name || null, b: d.buy || 0, h: d.hold || 0, s: d.sell || 0,
          ss: e.tipRanksSmartScoreData?.tipRanksSmartScore ?? null,
          ai: rnd(ai.overallScore, 1),
          air: (typeof ai.overallRating === "object" ? ai.overallRating?.name : ai.overallRating) ?? null,
          aipt: rnd(ai.priceTarget), mc: t.marketCap != null ? Math.round(t.marketCap / 1e6) : null,
        });
      }
    }
    return { rows: [...seen.values()], total };
  }, API);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, locale: "en-US" });
const page = await ctx.newPage();

let data = null;
for (let attempt = 1; attempt <= 4 && !(data && data.rows.length >= 50); attempt++) {
  try {
    await page.goto("https://www.tipranks.com/screener/stocks", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(6000); // let the Cloudflare challenge clear
    if (/just a moment/i.test(await page.title())) await page.waitForTimeout(8000);
    data = await pull(page);
    console.log(`attempt ${attempt}: ${data.rows.length} rows`);
  } catch (e) {
    console.error(`attempt ${attempt} failed:`, e.message);
    await page.waitForTimeout(5000);
  }
}
await browser.close();

if (!data || data.rows.length < 50) {
  console.error("Did not get enough rows — leaving existing data untouched.");
  process.exit(1);
}

mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/stocks.json", JSON.stringify(data.rows));
writeFileSync(
  "src/data/meta.json",
  JSON.stringify({ generatedAt: new Date().toISOString(), universe: data.total, shown: data.rows.length }, null, 2) + "\n",
);
console.log(`wrote ${data.rows.length} rows; universe ${data.total}`);
