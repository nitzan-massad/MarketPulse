# MarketPulse — Whales (13F) Design Mockups

Thirty static mockups for the proposed **Whales** page — what large institutional managers
reported owning, parsed from SEC Form 13F-HR — plus ten candidate bottom-nav icons.

Design only. Nothing is wired into the app; no `src/`, `ci/` or `package.json` files were touched,
and no dependency was added.

## How to look at these

Open any file directly in a browser. Every file is **fully self-contained** — inline CSS, inline
SVG, no build step, no CDN, and **no network fonts**. The house faces (Fraunces / Archivo /
JetBrains Mono) are requested by name and fall back to local system stacks, so the pages render
correctly even where those faces aren't installed. (This differs from `design/modals/`, which
loads Google Fonts over a `<link>`.)

**Resize your browser to 390px before judging anything.** All 30 pages are designed mobile-first,
render the real bottom tab bar, and reserve `96px + env(safe-area-inset-bottom)` at the bottom.
None of them scroll the page body sideways at 390px — wide things (the flat table, the coverage
matrix, the manager rail) scroll inside their own `overflow-x:auto` container.

Everything uses the real **Steel Navy** tokens from `src/index.css` — `--gold:#1b3f73`
(which is **navy**, despite the token name), `--ink`, `--muted`, `--faint`, `--panel`, `--line` —
and reuses the existing class vocabulary (`.bob-card`, `.bob-title`, `.bob-eyebrow`, `.na-wrap`,
`.na-table`, `.pill`, `.na-list`, `.bob-empty`, `.seg`) so these read as options *within* the
house style, not ten unrelated designs.

## Sample data

All 30 files share one fake dataset so the options are directly comparable: **Berkshire Hathaway**
($312.4B, 41 positions), **Pershing Square** ($13.8B, 9), **Scion Asset Management** ($186.4M, 12),
**Duquesne Family Office** ($3.12B, 48) and **Appaloosa LP** ($7.41B, 32) — all Q1 2026, filed
May 14–15 2026, 8 holdings each, with all five change states represented. Aggregate views use a
24-manager rollup: 1,847 positions, $482B, and **112 of our 355 covered tickers** held by at least
one whale.

## The five change states

| state | meaning | hue | glyph |
|---|---|---|---|
| NEW | position opened | `--gold` (navy) | `✛` |
| ADDED | increased | `--green` | `▲` |
| TRIMMED | decreased | `--amber` | `▼` |
| EXITED | sold out | `--red` | `✕` |
| HELD | unchanged | `--faint` | `—` |

Two deliberate calls: **TRIMMED is amber, not red** — trimming is not exiting, and painting both
red throws away the distinction that matters most. **NEW is the app accent navy**, not green,
because an opened position is the *interesting* event, not a good/bad one. Every treatment pairs
the hue with a glyph and a word, so none of the ten depends on color alone.

Covered vs not-covered is likewise never color-only: covered tickers are navy, bold, and carry a
`›` chevron or underline plus a real link; uncovered tickers are muted, dotted-underlined, and
carry an explicit `not tracked` / `UNTRACKED` marker.

---

## A. Page layout — `whales-1.html` … `whales-10.html`

★ = recommendation. Options 4, 5 and 9 lead with the cross-reference angle rather than
manager-by-manager.

| # | File | Concept | Structural idea | Main trade-off |
|---|------|---------|-----------------|----------------|
| 1 | `whales-1.html` | **Manager Cards** | One card per filer — initials tile, CIK/quarter/filed meta, a 5-counter change-mix strip, then an 8-row holdings table. | Safest and most expected, but you scroll a full screen per manager and can't compare two. |
| 2 | `whales-2.html` | **Accordion Ledger** | All 5 managers as `<details>` rows; each collapsed summary carries a stacked change-mix bar that reads while shut. | Scanning 24 managers is fast, but comparing two means expanding both and losing the overview. |
| 3 | `whales-3.html` | **Flat Table + Filter** | One merged 16-row ledger across all managers, manager as a column, with a manager chip rail and an All/New/Added/Trimmed/Exited segment. | The most powerful sortable surface, but it destroys any sense of a portfolio's *shape*. |
| 4 ★ | `whales-4.html` | **Coverage Consensus** | Leads with "what do whales own among *our* 355": per-ticker cards with a 24-pip whale meter, a buy-vs-sell diverging bar, and who-holds-it chips. | Best answer to "why is this in MarketPulse", but a whale fan can't see any single manager's book. |
| 5 | `whales-5.html` | **Buy Leaderboard** | Ranked most-bought-first list with Fraunces rank numerals, buying/selling micro-bars and a 4-quarter whale-count sparkline. | Instantly readable momentum, but says nothing about position size or conviction. |
| 6 | `whales-6.html` | **Rail + Detail Pane** | Sticky horizontal rail of manager tiles over the selected manager's full detail; becomes a 220px sidebar at ≥900px. | Switching managers is one tap, but you still only ever see one at a time. |
| 7 | `whales-7.html` | **Allocation Weights** | Portfolio-shape-forward: a full-width stacked book bar per manager plus per-row weight bars, so concentration is the first thing you see. | Gorgeous for conviction, but 0%-weight EXITED rows need a special ghost treatment to exist at all. |
| 8 | `whales-8.html` | **Whale Radar Feed** | An activity stream, not a portfolio — cross-manager moves newest-first under sticky filing-date headers, written as sentences. | Reads like news and surfaces the interesting 20%, but it is not a portfolio view; HELD has to be dropped. |
| 9 | `whales-9.html` | **Coverage Matrix** | Covered tickers × managers grid of change glyphs, sticky ticker column, `held by N` summary column and a `net buys` footer row. | The only view showing consensus *and* dissent at once, but brutal on a phone and caps out ~6 managers. |
| 10 | `whales-10.html` | **Quarterly Digest** | Editorial brief — Fraunces lede with inline stat callouts, "three moves that mattered" cards, then a closing ledger. **Includes the full empty state.** | The most persuasive and most shareable page, but it's generated editorial, not a plain data render. |

**★ Recommendation — `whales-4` (Coverage Consensus).** A manager-by-manager 13F browser competes
with a dozen free sites; "which of the stocks you already follow are whales buying" is the only
version of this page that's differentiated, links straight back into the existing 355, and stacks
to one clean column at 390px. If you ship two views, make `whales-1` the second tab — it's the
book-level view `whales-4` deliberately gives up.

Empty states live in `whales-10.html` (full-page, labeled `— EMPTY STATE —` below the populated
design) and `whales-9.html` (coverage-gap block).

---

## B. Bottom-nav icon — `../icons/whale-1.svg` … `whale-10.svg`

Gallery: **`../icons/whales-gallery.html`** — renders every candidate in a real 5-tab bottom nav
at exactly **21px**, twice per concept (**active** navy and **inactive** muted, which is where weak
icons fall apart), on the real translucent nav chrome over the real page background. It also has a
**confusion check** row putting all four existing nav icons and all ten candidates side by side at
21px, and a 21/28/48px size ladder per concept.

All ten are `viewBox="0 0 24 24"`, `currentColor` only, no hex, no gradients — matching the
existing set's 2px round strokes and solid silhouettes.

| # | File | Concept | Structural idea | Main trade-off |
|---|------|---------|-----------------|----------------|
| 1 | `whale-1.svg` | Whale silhouette | Filled side profile with pectoral fin and raised fluke. | Most literal, but the most detail to lose at 21px. |
| 2 | `whale-2.svg` | Dorsal fin + waterline | Stroke fin cresting a waterline, body implied below. | Most icon-set-native and restrained; can read as a generic swoosh. |
| 3 ★ | `whale-3.svg` | Tail fluke | Filled diving fluke over a short waterline stroke. | Highest recognition per pixel; leans on the fluke being universally "whale". |
| 4 | `whale-4.svg` | Spouting whale | Stroke back plus a 3-mark spout. | Friendliest and most obvious; the spout marks are the first thing to vanish small. |
| 5 | `whale-5.svg` | Big fish, small fish | One large filled mass beside three small — capital asymmetry, no marine literalism. | Abstract and bulletproof at any size; needs the label to mean anything. |
| 6 | `whale-6.svg` | Iceberg | Peak above a waterline, larger mass below — "you see a fraction". | Great metaphor for disclosure lag; reads as a mountain without the waterline. |
| 7 | `whale-7.svg` | Institution portico | Pediment, three columns, base — classical bank facade. | Clearest "institutional money" reading, but three columns risk confusion with the Stocks bars. |
| 8 | `whale-8.svg` | Vault door | Circle door, 4-spoke dial, hinge bar. | Distinct silhouette; says "money stored", not "money moving". |
| 9 | `whale-9.svg` | Whale over bars | Filled whale riding three ascending stroke bars. | Ties whale to market explicitly; the busiest and riskiest at 21px. |
| 10 | `whale-10.svg` | Fluke / candlestick | A candlestick whose lower wick splits into a tail. | The most brand-y mark, but only legible once you know what it is. |

**★ Recommendation — `whale-3` (tail fluke).** The fluke is the most recognizable whale shape at
tiny sizes, it's a solid fill like the Best and New icons so the set stays balanced, and its
waterline gives it the same flat baseline as the bars and bookmark. `whale-2` is the safe
alternative if you want a fifth stroke icon instead of a third filled one.

---

## C. Holding row + change badge — `badges-1.html` … `badges-10.html`

Each file shows the **same 7 rows** (all five states, 4 covered + 3 uncovered tickers, including
uncovered rows in loud states so the two signals can be checked for collision) inside a realistic
Berkshire card, plus a **magnitude range** strip (`+2.1%` → `+75.0%` → `−33.3%`), a
**states-isolated** strip, and an accessibility note listing the non-color cue for every state.

| # | File | Concept | Mechanism | Main trade-off |
|---|------|---------|-----------|----------------|
| 1 | `badges-1.html` | Filled pills | House `.pill` idiom — glyph + word in a tinted 999px pill, magnitude in mono beside it. | The safe baseline everything else is measured against; magnitude is just a number you must read. |
| 2 | `badges-2.html` | Left-border rail | 3px full-height state-colored rail per row plus the state word in tracked caps; no pill at all. | The rails form a scannable vertical spine, but the signal is peripheral and easy to miss. |
| 3 | `badges-3.html` | Delta bar | Two-part bar of prior vs current shares — solid gain, hatched loss ghost, capped ends for NEW/EXITED. | The only one that shows *what the position was*; needs real width and a shared scale. |
| 4 | `badges-4.html` | Typographic only | Weight, case and a leading sign character; includes a `grayscale check` duplicate to prove it. | Quietest and most elegant, and survives grayscale — but nothing pops in a long list. |
| 5 | `badges-5.html` | Share sparkline | A 4-quarter share-count sparkline per row plus a 2-letter state code in a bordered square. | Adds trajectory no other option has; the richest and the most expensive to render. |
| 6 ★ | `badges-6.html` | Glyph tile + pip meter | A 30px tile whose **shape** differs per state, plus a 5-pip meter that fills by magnitude bucket. | Shape carries state and pips carry size, so it works in grayscale — but buckets lose exact values. |
| 7 | `badges-7.html` | Ledger sentence | The app's existing `old → new` chip idiom applied to share counts, with the state as an outline tag. | Reads like a filing footnote and reuses a pattern users know; zero visual punch. |
| 8 | `badges-8.html` | Diverging bar | A shared center-zero axis — ADDED grows right, TRIMMED grows left, capped bars for NEW/EXITED. | The only option where magnitudes are comparable *across rows*; wants a wide dedicated column. |
| 9 | `badges-9.html` | Card + corner ribbon | Each holding is a card with a diagonal state ribbon and a large watermark glyph. | Most expressive and most tappable, but ~3× the vertical space of a row. |
| 10 | `badges-10.html` | Status gutter + leaders | A 10px marker with a distinct inner shape in a fixed gutter, dotted leader to a right-aligned value. | Quietest and densest, index-like; the marker is small enough to need the caption to disambiguate. |

**★ Recommendation — `badges-6` (glyph tile + pip meter).** It's the only treatment that encodes
state as *shape* and magnitude as a *separate visual channel* in a footprint narrower than a pill,
so it stays readable at 390px, survives grayscale and colorblind checks without a fallback, and
doesn't need the wide shared axis `badges-8` depends on. `badges-1` is the zero-risk fallback if
you'd rather not introduce a new component.

---

## Notes

- Design only — nothing is wired into the app; no `src/` or `ci/` file was modified.
- No external assets of any kind: no CDN, no Google Fonts, no remote images. Every file opens
  offline.
- The `.svg` files in `../icons/` are the source of truth for the icons; `whales-gallery.html`
  inlines identical path data so the marks inherit `currentColor` from the nav (an `<img>`-loaded
  SVG would render black and defeat the whole test).
- Every page carries a `prefers-reduced-motion` guard and the standard source footnote:
  *positions are as of quarter end and lag up to 45 days; 13F discloses long US equity positions
  only.*
