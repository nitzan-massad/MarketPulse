# MarketPulse — Stock Detail Modals · v2

Evolved from `../modal-1.html … ../modal-5.html`. Each keeps its original concept's
character and adds two things: **(A) a ~1-month inline-SVG price chart** with static
range tabs (1D · 1W · **1M** · 3M · 6M · YTD · 1Y, 1M active) and **(B) a full statistics
strip** (Open / High / Low / 52-wk High / Low / Avg Vol / P/E / Beta / Market Cap), while
retaining the analyst block (Smart Score, consensus + price target + upside, AI Analyst).

Sample: **NVDA — NVIDIA Corporation (Technology)**.
- TipRanks fields from `src/data/stocks.json`: price $194.83, day −1.39%, target $309.33,
  upside +56.6%, Strong Buy (36·1·0, 37 analysts), Smart Score 9, AI 88 / Outperform / tgt $232, mkt cap $4.71T.
- Live stats via Finnhub: Open $197.14, Day High $200.06, Day Low $192.35, Prev Close $197.58,
  52-wk High $236.54, 52-wk Low $152.97, P/E (TTM) 30.02, Avg Vol (3M) 169.9M, Beta 2.24.
- The chart is a hand-crafted 30-point dip-and-recover month series (low $183.05, high $201.30,
  closing at the real $194.83) since intraday candles aren't on the free tier.

Each file is self-contained (inline CSS + inline SVG, Google Fonts via `<link>`), centered over
a dimmed/blurred faux-app backdrop, with a close (×) and a pinned mobile-behavior note.

## The five

1. **modal-1.html — Ticket.** The compact boarding-pass card grows via a tear-perforation and a
   three-way segment selector (Chart / Analysts / Stats), so the chart, the kept upside-hero +
   analyst trio, and the 2-column stat ledger each get a clean panel instead of cramming.
2. **modal-2.html — Dashboard.** A wide gold area-chart panel sits at the top as the hero, with a
   grid of the kept analyst panels (price-target track, consensus B/H/S, Smart-Score meter, AI ring)
   and a new full-width 5-up "Key Statistics" strip below.
3. **modal-3.html — Editorial.** The chart becomes a magazine "chart plate": ruled figure header,
   thin gold hairline plot, and an italic-serif figure caption; stats fold in as a two-column
   small-caps "The fundamentals" table beneath the kept analyst ledger.
4. **modal-4.html — Terminal.** A dark `plot NVDA --range` command row drives a gridded terminal
   plot in bright terminal-gold; the kept metric matrix + distribution/target-ladder readout stay,
   and a dense 5-up `key=value` "Session & Fundamentals" dump adds the stats.
5. **modal-5.html — Graphical.** The biggest gradient area-chart hero leads, above the kept gauge
   trio (upside / Smart Score / AI) and consensus donut; a bar-chip "Key Statistics" grid plus a
   full-width 52-week range slider (gold marker at the live price) carry the new stats.
