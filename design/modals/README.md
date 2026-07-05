# MarketPulse — Stock Detail Modal Mockups

Five design directions for the stock-detail modal that opens when a user clicks a ticker/price
(replacing today's Yahoo Finance link). Each is a **self-contained HTML page** showing the modal
centered over a dimmed, blurred faux-app backdrop. All use the MarketPulse tokens/fonts
(Fraunces / Archivo / JetBrains Mono; white bg, gold `#b8860b`, ink `#1b1d18`, green/red for up/down)
and reuse the app's real visual language — consensus **pills**, score **chips**, the gold **up-bar**,
and the `scoreColor()` hue logic (Smart Score 9 → `hsl(119.2 64% 37%)`, AI 88 → `hsl(116.6 64% 37%)`).

**Sample stock (real values from `src/data/stocks.json`):** NVDA — NVIDIA Corporation, Technology,
$194.83 (−1.39% today), target $309.33 (+56.6% upside), Strong Buy (36·1·0 = 37 analysts),
Smart Score 9/10, AI Analyst 88/100 "Outperform" (AI target $232), market cap $4.71T.

Open each file directly in a browser. Each includes a desktop layout plus a bottom-left note describing its mobile behavior.

| # | File | Concept | Layout & what it emphasizes |
|---|------|---------|------------------------------|
| 1 | `modal-1.html` | **Ticket** | Compact 440px card with ONE hero metric — the +56.6% upside blown up in Fraunces over a price-to-target track — then a tight consensus/Smart-Score/AI trio. Fast, decisive glance. |
| 2 | `modal-2.html` | **Dashboard** | Full 720px sectioned dashboard with mini-viz: a price-target progress bar, a B/H/S consensus stack, a 10-pip Smart Score meter, and a conic-gradient AI ring. Everything, richly. |
| 3 | `modal-3.html` | **Editorial** | Minimalist magazine spread — big Fraunces company headline, an italic one-line verdict, a giant +56.6% pull-quote, and the numbers set as a quiet serif/mono ledger. Whitespace-forward. |
| 4 | `modal-4.html` | **Terminal** | Data-dense dark trading-terminal popover in JetBrains Mono — traffic-light title bar, an 8-cell metric matrix, a consensus distribution + target ladder readout, and a log-line footer. Every metric tight. |
| 5 | `modal-5.html` | **Graphical** | Chart-forward — three SVG semicircle gauges (Upside / Smart Score / AI, arcs colored by `scoreColor()`), a consensus donut with the Strong-Buy pill at its center, and a price→target bar. Scores read at a glance. |

## Notes
- Design only — nothing is wired into the app; no `src/` files were touched.
- Google Fonts loaded via `<link>`; all other CSS is inline. No other external assets.
- Every close (×) affordance is present; sizes are plausible for desktop, with a mobile variant noted on each page.
