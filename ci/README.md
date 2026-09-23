# CI/CD — data refresh & deploy

This folder holds the code the automated pipeline runs. **The pipeline lives entirely
in this repo** — there is no separate system to log into or "upload" to. Editing the
code here and pushing to `main` **is** the deploy: the next scheduled or manual run
uses whatever is on `main`.

## How it runs

`.github/workflows/site.yml` (the workflow YAML **must** live in `.github/workflows/`
— GitHub requirement — but all the logic it calls lives here in `ci/`):

- **Trigger:** every 5h (`cron`), the "Run workflow" button (`workflow_dispatch`), and every push to `main`.
- **FlareSolverr** service starts (solves Cloudflare from the runner's IP).
- **`ci/refresh-data-ci.mjs`** pulls the TipRanks screener API through FlareSolverr and writes
  `src/data/stocks.json`, `src/data/seen.json`, `src/data/meta.json` (skipped on plain pushes;
  a blocked fetch fails the step but not the run — the site still deploys the last data).
- **Commit step** stages the refreshed data and commits `chore: refresh TipRanks snapshot [skip ci]`.
- **Build** (`npm run build`) with the Finnhub/TwelveData/FMP keys from repo secrets, then deploy to GitHub Pages.
- **`ci/generate-posts.mjs`** turns the fresh snapshot into one social post for the in-app feed.
  `loadWindow()` (in `generate-posts.mjs`, **not** in `hooks.mjs`) reads the last `POST_WINDOW`
  snapshots out of git history — `git log -30 --format=%H -- src/data/stocks.json`, then
  `git show <sha>:src/data/stocks.json` for each — and appends the working copy as the current
  one. `ci/hooks.mjs` runs **no git at all**: it is handed that array of snapshots, oldest first,
  and emits scored, structured hooks (no LLM — the same window always gives the same hooks).

  **De-tickering.** Immediately after `detectHooks`, `ci/hooks.mjs`'s `deTickerHooks(hooks,
  currentRows)` runs as its own pass, before the prompt builder or the scorer ever see a hook.
  A published post once read "IRD soared 151.7% to $13.14." — a ticker, which is banned — and
  the root cause was upstream of the writer entirely: the `list` hook's own `facts` handed the
  model a ticker to quote back verbatim (`members: "IRD (151.7% to $13.14), …"`, `leader:
  "IRD"`). `deTickerHooks` scans every STRING fact on every hook for a known ticker token (the
  window's own `t` -> `n` map) and substitutes the company's short name — general on purpose,
  so a future fact carrying a ticker is caught the same way, not just `members`/`leader`. Long
  company names get sensibly shortened for a facts string that already names several companies
  at once (`shortCompanyName` strips legal-entity suffixes — "Inc.", "Corp.", "Ltd.", "LLC",
  "PLC" — never brand-identity words like "Holdings"). This is the root-cause fix; the ticker
  penalty in `ci/post-score.mjs` (see below) is the backstop for a model that names one anyway.

  Then the provider in `ci/provider.mjs` writes `POST_CANDIDATES` variations; `ci/post-score.mjs`
  picks the best one deterministically and writes it to `src/data/posts.json` (rolling, newest
  first, `POSTS_KEEP` max). `continue-on-error` like the other scrapes. Publishing nothing is a
  valid outcome — a skipped run beats a bad post.

  **Fact keys are HUMANISED before they ever reach the prompt.** `buildPrompt()` in
  `ci/generate-posts.mjs` used to render `hook.facts` as literal `- key: value` lines, and a
  published post once read "Alphabet Inc. smartScore: 10, unchanged for 30 snapshots." because
  the model copied the raw JS field name back verbatim. `FACT_LABELS`/`humanizeFactKey()` map
  every key any of the seven hook kinds emits to a plain-English label (`smartScoreFrom` ->
  "Smart Score before", `windowLow` -> "Lowest in the window", …) — deliberately at the prompt
  boundary, not in `ci/hooks.mjs` itself, since `supportLine`-era consumers and `ci/test-hooks.mjs`
  depend on the current field names.

  **The company name is not required in the statement any more, and the model is told so.**
  The composed card (below) already prints the company name large above the statement — a
  candidate repeating it too ("Astera Labs, Inc." on the card, "Astera Labs upside halved…" as
  the statement) is a published redundancy, not a stylistic quirk. The system prompt in
  `buildPrompt()` now says the name is already on the card and must not be repeated, and
  `ci/post-score.mjs`'s old +10 "names the company" / -20 "does not name it" pair is gone —
  naming the company is now scored neutrally either way. A TICKER is still a hard, decisive
  rejection regardless (see below); removing the naming requirement never means removing the
  requirement for concrete numbers, which is what actually keeps a nameless-AND-contextless
  candidate from scoring well (the no-digits penalty alone, -35, is sized to beat the length
  band's own best-case bonus on its own).

  **The ticker penalty is decisive.** `TICKER_PENALTY` (100) in `ci/post-score.mjs` is sized
  the same way `FABRICATION_PENALTY` is: a candidate naming a ticker instead of the company
  must land below `MIN_PUBLISHABLE` regardless of what else it earns (digits, length band,
  even a correct name mention elsewhere in the same sentence) — it used to be a plain -20
  nudge, which is exactly how "IRD soared 151.7%…" cleared the floor at 56 in the first place.

  **A misdescribed movement verb is rejected just as hard, even with real numbers.** The same
  published line was wrong twice over: "soared" claimed a PRICE move, but 151.7% was analyst
  upside-to-target, not a thing that had happened to the stock. The system prompt now bans
  soared/plunged/rocketed/crashed/jumped/surged/spiked/tanked (and close synonyms) whenever the
  number they touch is a target/score/forecast/rating rather than a realized price change, and
  `ci/post-score.mjs`'s `misdescribedMovementVerbs()` backs it with the same
  `MISDESCRIBED_MOVEMENT_PENALTY` (100) treatment `TICKER_PENALTY` gets — decisive, but a lesser
  sin than an outright fabricated number. Bold framing of a true fact is the goal; a verb that
  misdescribes what the number MEANS is not, and the fabrication verifier alone cannot catch it
  (it only checks that numbers are real, not what a verb claims about them). `catapulted` and an
  unqualified `overnight` claim get the same decisive treatment now too — both reached a live
  post before they were added (see below).

  **A Smart Score change alone is not a post — `trend` and `churn` are deleted, and `movement`
  no longer fires on one.** TipRanks' Smart Score is a 1-10 quant rating; a post whose entire
  story is that rating moving is weak content on its own, and it also invited misleading copy —
  a live post read "Smart Score catapulted from 7 to 10 overnight" for a hook whose real window
  was 6.3 days. `trend` (net Smart Score drift across the window) and `churn` (how many distinct
  scores it showed) had no other story to tell, so both are gone from `ci/hooks.mjs` outright —
  not damped, deleted, tests and all. `movement` survives, but its firing condition dropped the
  `|Math.abs(dSs) >= 2|` branch: only a real upside change or a consensus flip trips it now, and
  a Smart Score delta is written into its `facts` LAST, only when it actually changed, never
  restated when unchanged. `steady` (held a top score for the whole window) survives on purpose
  even though it is also Smart-Score-only content: it is not about a *change* (it fires on the
  absence of one), and "this name has not wavered all week" reads as a different, more
  interesting claim than "the number moved". `contrarian` (Smart Score vs. AI Score) is
  unaffected either way — that hook is a disagreement between two models, not a change in one.

  **The window is why the checkout is not shallow.** Three of the seven hook kinds — `record`,
  `steady`, `newcomer` — refuse to fire below `MIN_WINDOW` (10) snapshots, because a "30-run
  high" off four readings is not a fact. A default `actions/checkout@v4` clones at
  `fetch-depth: 1`, so `git log` returns exactly ONE sha and exits 0: the window collapses to 2
  and those three kinds go silently dead in the only environment that runs them. `site.yml`
  therefore pins `fetch-depth: 0`, and `loadWindow()` prints a WARNING naming the count when the
  window comes back under `MIN_WINDOW`. **Do not make the checkout shallow.**

  **The displayed company name strips legal-entity and share-class cruft.** A composed card
  once printed "Applied Materials, Inc." and, on another run, "Alphabet Inc. Class A" — the
  full legal name straight out of `src/data/stocks.json`. `ci/hooks.mjs`'s
  `displayCompanyName()` strips `", Inc."`, `Corp`/`Corporation`, `Co.`/`Company`, `Ltd`/
  `Limited`, `plc`, `N.V.`/`S.A.`/`AG`, `Holdings`/`Group`, `Class A`/`B`/`C`, and `& Co.`/`and
  Company` — ONLY from the end of the name, looped so a chained tail fully resolves ("Rani
  Therapeutics Holdings, Inc. Class A" -> "Rani Therapeutics"), and never returns an empty
  string. It is a SEPARATE, more aggressive function than `shortCompanyName()` (used by
  de-tickering, above): that one deliberately keeps "Holdings"/"Group" because they can be
  load-bearing brand identity inside a `list` post's `members` string; this one is for the one
  line a human actually sees — the big name on the composed image and the name given to the
  writer model in the prompt — where a punchier name is exactly what is wanted. The underlying
  `name` field on the post record, and everything in `ci/hooks.mjs`'s hook facts, is untouched;
  this is a display concern only.

  **The writer model is `@cf/meta/llama-3.3-70b-instruct-fp8-fast` by default, not an 8B
  model.** An 8B model writing an 8-word headline has a low ceiling on wit, which was the root
  cause of flat, repetitive copy. `CF_MODEL` still overrides the default either way. The style
  corpus (`ci/style-corpus.json`) — the few-shot exemplars a model imitates far more than it
  follows the system prompt's rules — was rewritten alongside this to be punchier and to drop
  its one `churn`-flavoured line ("Four different Smart Scores in one week."), since that kind
  no longer exists. A bigger model is billed more Workers AI neurons per token than the 8B
  default was, so the "~15% of the daily free pool" estimate elsewhere in this doc is now a
  floor, not a fresh measurement — worth watching after this ships.

  **Rounded numbers, not raw TipRanks precision.** Posts used to read straight off the snapshot's
  decimal fields verbatim — "143.6% upside dwarfs current 300.65 price", "Held Strong Buy for 6.3
  days straight" — which reads like a machine copying a spreadsheet cell. The system prompt now
  tells the writer to round every figure it is given (round HALF UP to the nearest whole number,
  or keep one decimal where that reads better) before using it, and permits a leading "~" where an
  approximation marker reads more naturally than a bare rounded number. `ci/post-score.mjs`'s
  fabrication check (`unverifiedNumbers`/`vouchedBy`) was ALREADY tolerant of exactly these
  transforms — round-half-up, truncate, and one-decimal rounding of a real fact, and nothing
  looser (see that file's own comment for why a blanket percentage tolerance would be wrong: 1%
  of 143.6 is wide enough to also verify 145, which must stay rejected) — so this is a prompt and
  style-corpus change, not a loosening of the verifier. `ci/style-corpus.json`'s exemplars are all
  rounded ("six days", "40%", "~144%"), never raw decimals.

  **Lead with the number, cite the analysts, compare when you can — three more prompt rules from
  a later review.** (4) The system prompt now tells the writer to OPEN on the figure itself — the
  percentage, price, or count — rather than the company or a verb ("~15% upside, 25 analysts
  covering" over "Microsoft held…"). (5) When an analyst count is available, the prompt prefers
  it as social proof ("25 analysts agree") over a bare percentage, which reads more abstract. (12)
  `ci/hooks.mjs`'s `surprise` and `record` hooks now compute `sectorMedianUpside` — the CURRENT
  snapshot's median upside across the hook's own sector, attached only when the sector has at
  least `MIN_SECTOR_PEERS` (3) eligible rows this run AND the name's own number clears
  `MIN_COMPARISON_GAP` (10 points) from that median — so the writer can say a name is "double its
  sector's median" instead of stating the number in isolation, without ever inventing a
  comparison it was not actually handed.

  **Images are THREE separate steps, deliberately, not one blended function: text (above),
  photo, fusion.** `ci/post-image.mjs` generates the photo via Cloudflare Workers AI **Flux
  Schnell** (`@cf/black-forest-labs/flux-1-schnell`, 4 steps, ~43 neurons/image against the
  same free 10,000/day pool the text candidates already spend ~15% of, rate-limited at 720
  req/min, Apache-2.0). The canvas scenes in `src/postArt.ts` cannot be made genuinely light
  AND visually substantial at once — two of the seven measured a mean brightness of 240 with a
  visual variation of 12 on 0-255, i.e. a blank white rectangle — so a real photo is the fix,
  and canvas stays wired in as the fallback. `scenePhrase()` maps the post's sector to a
  plain-English scene description (the 12 real sectors in `src/data/stocks.json`, plus a
  fallback); `buildImagePrompt()` wraps it in a fixed template forcing bright/high-key/abstract
  imagery. **The prompt NEVER carries a hook fact, number, ticker-as-text or company name —
  sector only, plus a seed for one coin flip (below), always.** Flux is well known for
  rendering text accurately, and this model's schema has no `negative_prompt` field to suppress
  it with, so a number reaching the prompt would be a plausible route to a fabricated figure —
  a wrong price, a wrong date — baked as pixels into a picture that sits next to a real public
  company's name.

  **Every photo now shows one or more people doing the company's actual work, close and large in
  frame** — a scientist pipetting a sample mid-motion, an engineer soldering a circuit board,
  hands and work filling most of the composition — inverted from the old "no people, no faces,
  no hands, no silhouettes" clause, and rewritten a second time from a set of safe-but-small,
  mid-distance, often-posed scenes toward close/medium-close shots caught mid-action, because
  small and static was the complaint (`SECTOR_ROLE` in `ci/post-image.mjs`). Scenes that would
  have a natural reason to carry signage (a "wall of glowing display panels" for Technology, a
  studio "wall of softly glowing screens" for CommunicationServices) were rewritten to drop the
  screens entirely: Flux exposes no `negative_prompt`, so the no-numbers instruction cannot be
  enforced, and a generated screen wall has produced chart-like numeric marks before — a scene
  with nothing screen-shaped in it is simply less likely to invent one. **Roughly 90% of the
  time the person is a woman**, chosen deterministically (not by chance) from an FNV-1a hash of
  the post's ticker, so a given post always renders the same person; about one in ten seeds
  resolve to "a man". The ticker is used for EXACTLY this one coin flip and is never
  concatenated into the prompt text itself (`ci/test-post-image.mjs` asserts the ticker string
  never appears in its own built prompt). The no-text/no-numbers/no-logos/no-watermark clauses
  all stay, and matter more than ever now that real text is about to be burned onto the photo.

  **Three further refinements to `buildImagePrompt()`, from a later round of review.** (1) TIGHT
  CROPS: "close or medium-close" is now "extreme close-up", with an explicit "face and hands
  both in frame" and "shallow depth of field" — the best image the old wording produced (a
  scientist mid-pipette) was already this tight; the weakest was mid-distance, and the looser
  wording left Flux room to pick the weaker option. (2) SCREENS, REDIRECTED: the old "no charts,
  no graphs, no diagrams" clause — a pure negative, on a model with no `negative_prompt` field,
  that had ALREADY been ignored once (a generated screen rendered chart-like marks anyway) — is
  replaced with a POSITIVE instruction: if a screen or monitor appears in frame at all, it shows
  only soft out-of-focus coloured light and bokeh, never legible marks. (3) COMMERCIAL CASTING,
  per the user's explicit direction that the person be strikingly attractive: framed the way a
  photo director actually briefs a shoot (well-groomed, styled, professionally lit, magazine/
  advertising production values), never crudely, and purely additive — the deterministic
  woman/man split, the high-key aesthetic, and every safety clause above are all unchanged.

  **(9) `General` — TipRanks' unclassified bucket — never reaches Flux at all.** There is no
  real job to depict for a catch-all sector, so any photo would be filler; `generateImage()`
  skips the Cloudflare call entirely for this one sector (saving the ~43 neurons every time) and
  renders a deterministic, palette-driven abstract mark instead (`renderAbstractMark()` — a
  handful of soft circles in the app's own accent colours, seeded by ticker, rasterised locally
  with the same `@resvg/resvg-js` this pipeline already depends on). `ci/post-compose.mjs` burns
  the post's text onto it exactly like any other photo — it is a real image buffer, not a
  second-class fallback.

  **The descriptor is written by the model, per company — not mapped from the sector.**
  `descriptorFor()`'s old map (a 2-4 word editorial caption per sector, "powering the grid",
  "chasing the next cure", …) fixed the flat "technology systems"/"public markets" taxonomy
  problem, but it is still one phrase per SECTOR, and `General` — TipRanks' own unclassified
  bucket, not an industry — rendered "too big to label" under every General-sector name
  including Alphabet: meaningless (the bucket says nothing about the business) and slightly
  absurd under Google's parent company. `ci/company-descriptor.mjs`'s `describeCompany()` now
  asks the SAME writer model one extra question per PUBLISHED post (never per candidate): given
  the display name, sector, market cap, price, analyst coverage, AND the real prose description
  `src/data/stocks.json` already carries per row (`row.desc` — populated for every row), write a
  short, characterful 2-4 word identity line true to the actual business (for Alphabet, something
  about search or advertising, never the sector bucket). `sanitizeDescriptor()` then validates the
  response — no digits, `$`/`%`, the company's own ticker, or a performance/valuation word
  (upside, buy, rating, undervalued, …), since this is an identity line under the name, not a
  stat — and ANY failure (a network error, a malformed body, a descriptor that fails validation)
  falls back deterministically to the OLD sector map, `descriptorFor()`, which survives
  unchanged as exactly that: a fallback, not the primary path. Results are cached per ticker in
  `src/data/company-descriptors.json` (committed by the same "Commit refreshed data" step below,
  since it lives under `src/data/`) — a cache hit costs zero neurons and keeps a company's
  descriptor consistent across posts, and a fallback is never cached, so the next run retries
  the model instead of freezing in a bad answer.

  `generateImage()` never throws: any failure (missing credentials, a non-ok response, a
  malformed body, a thrown network error) returns `null`, and the post degrades to canvas art —
  same as always.

  **Fusion — `ci/post-compose.mjs`.** This is the module that makes the photo postable outside
  this app: it burns the post's own text into the photo's pixels as ONE JPEG, so the words
  travel with the file wherever it goes (X, Instagram, anywhere). The browser no longer overlays
  any text (see `src/components/PostFeed.tsx` / `src/index.css`) — what ships in
  `public/post-images/` is the whole card. Layout, top to bottom: the **company name** large at
  the top; a **2-to-4-word sector descriptor** (`SECTOR_DESCRIPTOR` in `ci/post-image.mjs`, e.g.
  "powering the grid") directly beneath it at **exactly half** the company-name font size; the
  **statement** — the post's own text, unmodified — large at the bottom. This inverts the old
  browser-overlay layout, which put the hook at the top.

  **No solid plates — but a soft scrim, added back on review.** Every text block used to sit on
  a semi-transparent white/black rectangle — legible, but a hard-edged box read as a caption
  pasted onto a photo rather than text on the photo itself. Legibility still leans on the type
  first: a `stroke` halo with `paint-order="stroke fill"` (resvg renders this correctly, unlike a
  CSS text-shadow/blur filter, which it does not support). `haloStyle()` samples the photo's real
  brightness/variance per band (`sampleBrightness()`): dark ink with a light halo is the default
  (the photos are high-key by construction), a band that samples dark inverts to light ink with a
  dark halo, and a busy (high-variance) band gets a thicker, more opaque halo. **(8)** On top of
  that, `scrimDefs()` now adds a soft gradient — fully transparent around mid-height, tinted only
  at the very top edge (behind the company/descriptor block) and the very bottom edge (behind the
  statement), each tinted with the SAME colour the halo already chose for that band. Unlike the
  old plate this is never a hard-edged rectangle and never covers the middle of the photo — it
  only reinforces exactly where text already sits, on top of the halo, not instead of it.

  **(7) Number-first typography.** `composePost()` splits the statement's LEAD figure (the first
  number-shaped token, "~" and "%"/"$" riding along with it) from the words around it —
  `extractFigure()` — and renders it markedly larger, tinted by direction (`detectDirection()`,
  reading the statement's own up/down vocabulary): green for good news, red for bad, amber for a
  number with no inherent direction (a Smart Score, an analyst count, a number of days). The
  words sit smaller beneath it. A statement with no number at all (rare) falls back to the single
  block layout unchanged.

  Approach: build an SVG with the photo as a base64 `<image>` plus `<text>` elements, then
  rasterise with **`@resvg/resvg-js`** to raw RGBA pixels and encode those as a JPEG with
  **`ci/jpeg-encode.mjs`** — a from-scratch baseline (non-progressive) JPEG encoder over the
  standard ITU-T.81 Huffman/quantisation tables, written rather than adding a second image
  dependency (resvg only outputs PNG or raw pixels; there is no JPEG anywhere in this repo's
  dependency tree). A composed card was a ~900KB PNG at Flux's 1024x1024 output — mostly
  photographic detail PNG's lossless deflate cannot touch — which at `POSTS_KEEP=200` was
  heading toward ~180MB committed to git; JPEG's DCT+quantisation is built for exactly that
  content and gets the same pixels down an order of magnitude. See `ci/jpeg-encode.mjs`'s own
  header for how a hand-rolled encoder with no second decoder in this repo to round-trip against
  was verified (structurally, and once by hand against a real decoder outside the repo).
  **`@resvg/resvg-js` is still the one deliberate, user-approved exception to this pipeline's
  zero-dependency rule** — Node has no built-in font engine, and rasterising real text needs
  one. Two Inter weights (Bold for the two big headline blocks,
  Medium for the descriptor) are checked into `ci/fonts/` (subset to the Latin range this app's
  data actually produces, ~72KB each rather than the ~410KB an unsubset static weight ships at)
  and loaded EXPLICITLY via resvg's `fontFiles` option with `loadSystemFonts: false` — a GitHub
  Actions `ubuntu-latest` runner's system fonts are whatever that image happens to ship that
  month, nondeterministic and almost certainly different from a dev machine's, so relying on
  them would make the same post render differently depending on where it happened to run.

  SVG `<text>` does not wrap, so `ci/post-compose.mjs` does it by hand: `wrapText` greedily
  breaks on word boundaries, measuring every candidate line's REAL rendered width by asking
  resvg itself (the exact font is already loaded for the real render anyway, so this is both
  more accurate than a hand-tuned per-character advance table and no more code). `fitText`
  shrinks the font size step-wise and re-wraps whenever a block still overflows its line cap —
  including the trap where a single word longer than the line has nowhere to break: it gets
  force-placed alone, so a check that only compared word counts would call that "fine" even
  though the line runs off the canvas. `ci/test-post-compose.mjs` has a dedicated regression
  test for exactly that (`Pneumonoultramicroscopicsilicovolcanoconiosis`, English's longest
  common word).

  Text must stay legible over a photograph, and the photos are high-key/light — so dark text
  with a light halo is the default — but `sampleBrightness()` actually renders the photo at low
  resolution and measures mean luminance + variance per band rather than assuming: an unusually
  DARK band flips to light text with a dark halo, and a high-variance ("busy") band gets a
  thicker, more opaque halo regardless of which way the mean falls (see "No plates" above).

  On success the FUSED JPEG bytes are written to `public/post-images/<sanitised id>.jpg` (not the
  raw Flux photo — the composed image is the artifact now) and the post record gets an `image`
  field — the **filename only**, never a path. Post ids carry `:`/`.` from their ISO timestamp,
  which `postImageFilename()` (`ci/post-image.mjs`) collapses to `-`; that function is the ONLY
  place this mapping happens, so the frontend (`src/components/PostFeed.tsx`) just reads
  `post.image` verbatim — there is nothing for the two sides to keep in sync. A failure at
  EITHER the photo or the fusion step degrades identically: no `image` field, canvas fallback,
  the post still ships. Gated by `POST_IMAGES` (default `"true"`), same on/off shape as
  `POSTS_ENABLED`.

  **Prune.** `POSTS_KEEP` bounds `posts.json`, but says nothing about the image files
  themselves — at well under 200KB each that is unbounded growth in git, forever, with no cap.
  After writing the rolling posts list, `ci/generate-posts.mjs` deletes every file under
  `public/post-images/` whose post fell out of that window, and logs the count every run (even
  when it is zero). This is not optional cleanup — it is what keeps the feature from silently
  bloating the repo.

  **Knobs** (env in `.github/workflows/site.yml`): `POSTS_PER_RUN` (default 1), `POST_CANDIDATES`
  (default 5), `POST_WINDOW` (default 30 — snapshots pulled from git history), `POSTS_KEEP`
  (default 200), `POST_PROVIDER` (`cloudflare` free-tier default, `anthropic` for quality,
  `stub` for offline runs), `CF_MODEL` (default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`;
  overrides which Workers AI model writes the copy), `POSTS_ENABLED` (set `false` to stop
  writing posts), `POST_IMAGES` (default `"true"`; set `"false"` to skip Flux generation and
  always ship canvas art). Secrets: `CF_ACCOUNT_ID`, `CF_API_TOKEN` (shared with the text
  provider — no new secret).

`scripts/refresh-data.mjs` is the **local** manual equivalent (uses Playwright instead of
FlareSolverr) — a dev tool, not part of CI.

## How to change the pipeline (for humans and agents)

1. Edit the files in `ci/` and/or `.github/workflows/site.yml` **in the repo**.
2. Commit and push to `main`.
3. That's it — the next scheduled run, or a manual **Actions → Run workflow**, uses the new code.
   **Never** edit the workflow through the GitHub web UI; the repo is the source of truth.

## Pinned & sticky tickers ✅

The refresh isn't only the dynamic top-120 screener sorts. A ticker is also **kept**
(refreshed every run even when it falls out of those sorts) if it is either:

- **Pinned** — listed in `src/data/pinned.json` (a hand-edited array, e.g. `["AAPL","RIVN"]`).
  Pins never expire. Edit + commit + push this file; the next scheduled/manual run picks it up.
- **Sticky** — seen in the dynamic list within the last **365 days** (`KEEP_MAX_AGE_DAYS`
  in `ci/keep.mjs`). A ticker absent from the dynamic list for longer than that is dropped
  (unless pinned). `seen.json` now carries an `ls` (last-seen) timestamp per ticker to drive this.

Kept tickers missing from a run's screener pull are backfilled from the per-ticker
`getData` feed (`ci/keep.mjs` → `rowFromGetData`), **merging fresh fields over the ticker's
last-known row**. `getData` supplies price, targets, consensus, buy/hold/sell, smart score,
market cap and description — but **not** the AI-analyst score/rating/target or the sector name.
Backfill is capped per run (`BACKFILL_LIMIT`, default 300, most-stale-first) and per-ticker
failure-tolerant, so it can't blow the runtime or break the main refresh.

⚠️ **`ss: null` from TipRanks is an answer, not a gap.** `getData` returns the full
`tipranksStockScore` object with `"score": null` for a stock that simply **has no Smart
Score** (verified live on **ASTI** and **BCDA**; GOOGL comes back 10 and DNLI 6 from the
identical shape). `rowFromGetData` used to write `j.tipranksStockScore?.score ?? prev.ss`,
which cannot tell "TipRanks says there is no score" from "the payload reshaped" — so a real
null resurrected the last number and served it as fresh. ASTI was stuck at `ss 2` from
2026-07-23 across 7 market-moving runs and could not recover to `—` while it stayed off the
screener list. `ssFromGetData` now keys off **presence of the `score` key**: present (even
`null`) → trust it and let null through → the UI renders `—`; object/key absent → payload
reshaped, carry `prev.ss`. That matches the screener path, which has always used `?? null`
(`refresh-data-ci.mjs:73`) — which is why *on-list* no-score tickers like BCDA already showed
`—`. The deliberate trade-off: if `tipranksStockScore` ever disappears wholesale, every
keep-path ticker freezes on its previous `ss` (current behaviour, and the safe side — a
vanished field is our parse bug, not news). Backstops: `if (row.t)` rejects a garbage
per-ticker response and carries the whole previous row, and the ≥50-row guard
(`refresh-data-ci.mjs:83-86`) aborts before writing on a total screener failure. Covered by
`node ci/keep.mjs` (explicit null beats `prev`; missing object / missing key carry it; a real
score and a literal `0` still win).

**AI-score / sector enrichment.** After backfill, a row is enriched from the per-ticker
**stock-forecast** payload (`www.tipranks.com/stocks/<t>/stock-forecast/payload.json`
→ `ci/keep.mjs` `forecastFields`) if it is still missing `ai`/`sec` **or if it is off-pull**:
AI score, AI rating, AI target, and the sector name (slug → the app's PascalCase form).
Ordered stale-pins → blanks → stalest carry, failure-tolerant. `ENRICH_LIMIT` is **derived**
(`max(40, ceil(eligible / 3))`) so full rotation stays inside 3 runs as the off-pull set grows —
a fixed 40 let the bound decay from ~15h to ~50h within six weeks. An explicit env var wins.

`sec` and the rest are fill-only, but **the AI trio (`ai`/`air`/`aipt`) OVERWRITES** — and must,
because `getData` carries no AI-analyst data (`ci/keep.mjs` carries the trio from the previous
row), and `fillNulls` can never correct a stale non-null. Before this, an off-pull ticker's AI
score/rating was frozen indefinitely: **UNP displayed "Outperform"/74 for ~10 days / ~46 runs**
after TipRanks downgraded it to Neutral/69. Only a value actually present in the payload
overwrites — a null never blanks a good one.

**⚠️ The rotation is ordered by `ea` (enriched-at, stamped into `seen.json`), NOT by `ls`.**
`ls` is frozen while a ticker is off-pull, so ordering on it would re-pick the same 40 tickers
every run and staleness would stay unbounded — the identical trap as keying forecast staleness
off file mtime (see the Analyst forecasts section). `ea` is stamped on *attempt*, not success,
so a ticker whose payload never parses can't camp at the queue head. With ~73 off-pull tickers
worst-case AI staleness is **3 runs ≈ 15h**, and stays there because the cap scales. A pin is
prioritised only when actually stale (>3d), so pins no longer re-cost a fetch every run and
sticky slots can't crowd out rotation. The AI trio is applied **atomically** — a payload with
`score` but no `ratingId` would otherwise ship a fresh score beside a stale rating, the very
symptom this pass exists to fix. An empty result is logged and counted (`N with no report`)
rather than silently counting as enriched.

**The keep-set backfill queue has the identical hazard and the identical fix**: it is ordered
by `ba` (backfilled-at), not `ls`, because every candidate is off-pull and `ls` is frozen for
exactly those. Without it, the tail past `BACKFILL_LIMIT` would never be fetched and those rows
would serve stale *prices*, not just stale AI data. Both stamps are written on **attempt**, so a
permanently-dead ticker rotates away instead of camping at the queue head.

`scripts/refresh-data.mjs` mirrors all of this. It diverged once and silently reproduced the
bug CI had already fixed — keep the two in step. Guard: `node ci/test-enrich.mjs`.

Net effect: freshly-pinned and freshly-arrived tickers end up fully populated, and off-pull
tickers no longer serve stale AI data. (Consensus strings use the app's compact vocab —
`StrongBuy`, not `Strong Buy` — because the UI substring-matches `strongbuy`; see `src/lib.ts`.)

⚠️ **`ai` is 0–100 on BOTH sources — never rescale it.** This doc used to say the forecast
score is "0–100 → ÷10", and `forecastFields` did divide. That was wrong on both counts. The
screener writes `aiAnalystData.overallScore` undivided (live spread **39–85**), the forecast
payload's `report.score` is the same scale (verified live: TER 71, AAPL 75, NVDA 79), and the
app expects 0–100 — `scoreColor(s.ai, 100)` in the tables and a literal `/100` in `StockModal`.
Because the enrich path only ever ran for the two **pinned** tickers, exactly 2 of 344 rows
shipped on a 0–10 scale (TER 7.8 for a real 71, stuck for 58 commits and painted deep red in
every table) while the other 342 were fine — which is why nothing looked broken. `aipt` on the
same path is a **dollar** price target, not a score (TER 406 against a 367.69 price), and is
correct as-is. Corrupt rows do **not** self-heal: `fillNulls` only fills nulls.

- **Guard: `node ci/test-ai-scale.mjs`.** Fails if `src/data/stocks.json` mixes scales — some
  non-null `ai` ≤ 10 while others are > 10 (impossible in one column: a real 0–10 column would
  have *every* value ≤ 10) — or if the whole column is ≤ 10 over a 20+ row sample. It names the
  offending tickers, and also re-asserts that `forecastFields` maps 78 → 78. The assumption,
  stated in `aiScaleError` in `keep.mjs`, is that **no ticker legitimately scores ≤ 10 on 0–100**
  (1st percentile of the live 344 is 41, nothing under 30). A bare `max/min` ratio was rejected:
  it false-positives on any legitimately wide spread. **Not yet a step in `site.yml`** — same
  manual posture as `test-staleness.mjs` / `test-forecast-html.mjs`; worth adding as one.

The shared keep/expiry/mapping logic lives in `ci/keep.mjs` (used by both the CI and local
scripts) and has a built-in self-check: `node ci/keep.mjs`.

## Analyst forecasts — automated ✅

`ci/scrape-forecasts.mjs` refreshes `public/forecasts/<TICKER>.json` from TipRanks'
`getData` feed via FlareSolverr. `site.yml` runs it right after the data refresh, and
the commit step also stages `public/forecasts`.

- **Selection:** a ticker is scraped if we **last fetched it more than `STALE_DAYS` ago**
  (default 3), processed **stalest-first** (never-fetched = age 0 = front of queue, so new
  arrivals are always picked up on the very next run). `LIMIT` caps the per-run count
  (default 90); `ALL=1` forces everyone. With ~300 tickers and ~5 runs/day, `LIMIT=90`
  rotates through the whole universe in under a day, and no file exceeds ~`STALE_DAYS` old.

- **⚠️ Age comes from `public/forecasts/_asOf.json`, never from a file's mtime.** Git stores
  no mtimes, so `actions/checkout` stamps every file with the checkout time — an mtime-based
  check makes all 300+ files look seconds old, so nothing is ever refreshed and only
  brand-new tickers get fetched. That silently froze every forecast between 2026-07-24 and
  2026-08-02 while CI ran ~40 times. The `_asOf.json` sidecar (`{ticker: ISO}`, stamped on
  success *and* on an empty result, not on failure) is committed, so it survives checkout.
  `ci/build-reviews-recent.mjs` skips it — it's an object, not an array.
  Guarded by `node ci/test-staleness.mjs`.

- **Source (verified):** `https://www.tipranks.com/api/stocks/getData/?name=<T>` → `experts[]`.
  Mapping: `name`, `firm`, `rankings[].stars` (0–5), newest `ratings[0]` → `ratingId` 1/2/3 =
  Buy/Hold/Sell, `convertedPriceTarget` (→ `pt`), `convertedOldPriceTarget` (→ `opt`), `date` (→ `d`).
- **Output:** `[{ "n": analyst, "f": firm, "st": stars, "r": "Buy|Hold|Sell", "pt": target, "opt": prior|null, "d": "YYYY-MM-DD" }, …]`
- **Failure-tolerant:** per-ticker try/catch, only writes valid non-empty results, `continue-on-error`
  in CI — it can never break the main refresh. Tiny tickers with no ranked analysts simply get no file.

- **⚠️ Paywall fallback — `ci/forecast-html.mjs`.** The `getData` API anonymizes a fixed teaser
  window of rows: 6 AI-model rows plus **up to 4 real brokers**. An anonymized row keeps `firm`,
  `date`, `ratingId` and `stars` but has `name: null` and every price-target field nulled, so
  `toForecasts()` drops it on the `!e.name` guard. On AAPL (194 experts) losing 4 is noise. On a
  micro cap whose entire coverage is 3–4 ratings it swallows **100%** of it — which is how ~49
  tickers wrote `[]` and showed "No analyst forecasts" while tipranks.com plainly listed them.
  Relaxing the guards recovers **nothing**; the targets are absent from the JSON. So when
  `fc.length === 0 && data.expertRatingsFilteredCount > 0` we scrape the SSR page
  `tipranks.com/stocks/<t>/forecast`, which renders names and targets in full, and join `stars`
  back from the API on firm+date.

  **A revised target renders as two cells joined by an arrow — `"$15" "→" "$0.9"` — and the NEW
  target is the LAST one.** Taking the first `$` publishes the pre-revision figure: that bug
  shipped briefly and wrote `pt=15` for VTGN, a $0.24 stock whose real target is $0.9, i.e.
  +6100% upside on screen. Verified against the API on 35 revised rows: last `$` === `priceTarget`
  35/35, first `$` === `oldPriceTarget` 35/35 — so `opt` comes from the page too, and the first
  fixture (ADCT) had no revised row, which is why the original test passed. `ci/fixtures/vtgn-forecast.html`
  now covers the revised case; keep both.

  **Stage 2 — SHIPPED 2026-08-22: the page is now MERGED into the JSON path, not just a
  fallback.** The teaser covers the *freshest* ratings, so the JSON path was systematically
  behind on every ticker, not only the ones where it returned nothing. BIOA was the shape of it:
  9 real broker ratings existed, 2 survived the teaser, so `!fc.length` was false and the
  fallback never fired — next to a UI label reading "n=9". After the merge: 8 of 9.

  Union rules and precedence live in [`forecast-merge.mjs`](./forecast-merge.mjs), guarded by
  `node ci/test-forecast-merge.mjs`. Keyed on `name|date`, not `firm|date` — two analysts at one
  firm on one date collide there, which is tolerable for the star join and would drop a whole
  rating here. SSR wins `pt`/`opt`/`n`/`f`/`d`/`r` (it is the rendered truth, and the JSON copy
  of those is nulled for exactly the anonymized rows this path exists to recover); JSON wins
  `st`, the only source of stars.

  Measured over all 418 tickers before shipping (Phase 0, writes-nothing):

  | | |
  |---|---|
  | rows | 3976 → **5669 (+42.6%)** — the 8-ticker sample had estimated +24% |
  | tickers gaining rows | 355 / 418 (85%) |
  | tickers getting fresher data | 349 / 418 (83%), median **+16 days**, worst **+349** (ANVS, stuck on 2025-09-03) |
  | tickers losing rows | **0** |
  | malformed rows / target conflicts | **0 / 0** |
  | cost | **+474s, +34 MB** per 90-ticker rotation (the plan's "+100s floor" was ~5× optimistic) |

  ⚠️ **`SSR_MERGE=0` is the rollback** — set it on the workflow step and the scraper reverts to
  the exact old fallback, which is still covered by `node ci/test-forecast-gate.mjs` so it does
  not rot into an untested incident-only path.

  ⚠️ **The plan's row-count guardrail was DROPPED, not implemented.** It proposed comparing
  parsed rows against the page's own "N Wall Street analysts" figure and skipping on mismatch.
  That figure is unusable in both directions: 120 tickers parse *more* than it states (the table
  renders history beyond the consensus window) and 212 parse *fewer* — but that is TipRanks
  over-counting, not truncation. ALAR states 2 while rendering one analyst whose price target is
  a literal `―` (a Hold downgrade); the parser correctly skips him. Two-sided, the guard would
  have blocked the merge on half the universe. The real protection is structural: a truncated
  FlareSolverr read parses to a valid *prefix*, so under a UNION it can only shrink the gain,
  never the file — which is what the 0-rows-lost result confirms, and why the guard was only
  ever needed under replace semantics.

  `expertRatingsFilteredCount` equals the count of name-null experts (verified across 21
  payloads, zero mismatches) — it is both the gate and the alarm: **if it ever exceeds 4 real
  brokers, the teaser window has widened and will start eating mid-caps.** Gating on it keeps
  the 260 KB page fetch and the brittle HTML parsing away from the ~300 healthy tickers.
  The parser anchors on the analyst-profile slug and on column order, never on class names
  (TipRanks ships obfuscated per-build hashes). Guarded by `node ci/test-forecast-html.mjs`
  against a real trimmed ADCT page; if the markup moves, that test fails and the parser
  returns `[]` — a stale file, never a corrupt one.

## Bulls Say / Bears Say — automated ✅

`ci/scrape-bullbear.mjs` refreshes `public/bullbear/<TICKER>.json` (the AI Bulls Say /
Bears Say thesis) from TipRanks' **stock-analysis** payload via FlareSolverr, using the
**same selection logic as the forecast scrape** — `STALE_DAYS` staleness, stalest-first,
`LIMIT` (default 90), `ALL=1` to force everyone. Age comes from the `asOf` field already
stored **inside** each `<T>.json` (no sidecar needed here), never from mtime — see the
warning under Analyst forecasts for why. `site.yml` runs it right
after the forecast backfill, and the commit step stages `public/bullbear`. (The old "no
free endpoint / still manual" note was wrong — the data is free and unauthenticated.)

- **Source (verified live on AAPL, AMD, ACAD, RIVN, NVDA):**
  `https://www.tipranks.com/stocks/<t-lowercase>/stock-analysis/payload.json` — no auth, no key.
  Unlike `getData` this path isn't even Cloudflare-gated (plain `fetch` returns 200), but CI goes
  through the existing FlareSolverr for runner-IP safety. Same `payload.json` family as the
  AI-score enrichment above, different subpage (`stock-analysis`, not `stock-forecast`).
- **JSON path:** `models.stocks_extra[0].aiAnalysis.keyPoints[]` → `{ sentiment: "bullish"|"bearish", title, description }` (typically 3 bull + 3 bear).
- **Output shape:** `{ "bull": [{ "t": "title", "b": "body" }, …], "bear": [ … ], "asOf": "YYYY-MM-DD" }`
  (`asOf` = the date we last refreshed the ticker, shown next to the panel headline; the payload
  carries no content date of its own).
- **Failure-tolerant:** per-ticker try/catch, only writes non-empty results, `continue-on-error`
  in CI — never blocks the deploy. Tickers with no AI analysis simply get no file (retried next run).

## Sector average P/E — automated ✅

`ci/scrape-sectors.mjs` writes `src/data/sectors.json` — the average **trailing and forward**
P/E per sector — from Finviz's sector groups table. `site.yml` runs it after the reviews feed;
the commit step's existing `src/data` glob already stages it.

- **Source (verified):** `https://finviz.com/groups.ashx?g=sector&v=110&o=name` — one
  unauthenticated GET per run (~60 KB), no key. Finviz is Cloudflare-fronted, so CI routes it
  through the existing FlareSolverr for runner-IP safety; plain `fetch` works locally
  (`node ci/scrape-sectors.mjs`).
- **Taxonomy is free.** Finviz's sector names normalize onto the app's own vocab through
  `keep.mjs`'s `sectorName()` with no mapping table — `Real Estate` → `RealEstate`,
  `Consumer Cyclical` → `ConsumerCyclical`, all 11 map. TipRanks' **`General`** catch-all
  (~15 tickers) has no Finviz counterpart and gets no entry; `StockModal` renders "—".
- **Output:** `{ "asOf": "YYYY-MM-DD", "sectors": { "Technology": { "pe": 34.77, "fpe": 25.53 }, … } }`
- **Parsing is header-anchored,** not fixed-offset: the script finds the `No. | Name | Stocks`
  header run and reads P/E and Fwd P/E at whatever offset the header says, so a Finviz column
  reshuffle moves the reads with it. It anchors on that run specifically because the page's
  filter dropdowns also contain bare `Name` / `P/E` options that a plain `indexOf` hits first.
- **Failure-tolerant:** a run parsing fewer than 8 sectors throws instead of writing, results
  merge over the previous file (a fetch occasionally returns without the first data row), and
  the step is `continue-on-error` — it can never block the deploy.
- **Self-check:** `CHECK=1 node ci/scrape-sectors.mjs` exercises the parse against a fixture
  (column offsets, header reshuffle, `-` → `null`, dropdown decoys). No test framework, same
  posture as `node ci/keep.mjs`.

## Recent reviews feed (New Arrivals) — automated ✅

`ci/build-reviews-recent.mjs` reads the forecast files on disk and writes
`public/reviews-recent.json` — the newest analyst review per ticker whose date is within
`RECENT_DAYS` (default 7): `{ generatedAt, days, items: [{ t, n, f, r, pt, opt, d }] }`.
New Arrivals loads this one small file (instead of hundreds of forecast files) to surface
stocks with a fresh review. `site.yml` runs it after the scrapes and commits the JSON. The
`n|f|d|r|pt` fields match `reviewAlerts.reviewKey`, so clicking a review row opens the stock's
Analyst Forecasts and highlights that exact row.

<!-- BEGIN: Tests (ci/run-tests.mjs + .github/workflows/tests.yml) -->

## Tests — run on every push ✅

**One command, the same one CI runs:**

```
npm test          # === node ci/run-tests.mjs
```

Needs **Node ≥ 22.18** locally (see *Node version* below). No test framework and no test
dependency — every check is a plain script that asserts with `node:assert` (or a local
`eq()` helper) and exits non-zero when unhappy. `ci/run-tests.mjs` only finds them, runs
each in its own child process, and turns "one exited 1" into "the job is red". Nothing
touches the network; the only writes are to `node_modules/.tmp/checks/`.

### What it discovers

Discovery is by **pattern, never a hardcoded list** — drop in a new check and it runs, with
no edit to the runner:

| Pattern | How it runs |
|---|---|
| `ci/test-*.mjs` | directly, on the current Node |
| `src/*.check.ts` | one `tsc` pass into `node_modules/.tmp/checks/` first, then the emitted `.js` |
| `ci/keep.mjs` | the self-check behind its `import.meta.url === file://${process.argv[1]}` guard |

`src/*.check.ts` needs the compile step (not just Node's type stripping) because those files
import their subject **without a file extension** (`from "./lib"`) and one pulls in React +
JSX — Node's resolver cannot do either. The runner uses the repo's existing `typescript`
devDependency with the same flags as the `npx tsc …` line in each file's header comment, plus
a `{ "type": "commonjs" }` marker in the out-dir (the repo root is `"type": "module"`, so
without it Node would parse the CommonJS output as ESM and die on `exports`).

### Two rules beyond pass/fail

1. **A vacuous check is a failing check.** Exit 0 with no output at all, or a source file
   with no assertion in it (commented-out assertions don't count), is reported `FAIL` — a
   gutted test that reads green forever is worse than no test. Exiting 0 with output but no
   `ok`/`pass` line is a softer *suspicious* note, listed in the summary.
2. **A check that cannot execute is not a pass.** See below.

The runner keeps going after the first failure, so one run reports everything that is broken,
and prints a `PASS`/`FAIL` line per file (with assertion count) plus a final tally.

### Node version — why the workflows pin 24, not 20

`ci/test-consensus-direction.mjs` imports `../src/consensus.ts`. Importing `.ts` needs Node's
native type stripping, which shipped **unflagged in 22.18**; on Node 20 the check dies with
`ERR_UNKNOWN_FILE_EXTENSION` and cannot run at all. Both workflows therefore pin
`node-version: 24` (current LTS) — verified: `npm ci`, `npm test`, `npx tsc --noEmit` and
`npm run build` all pass on 24.16.0. Keep the two workflows in step.

On an older local Node the runner detects this via `process.features.typescript` and prints one
actionable line naming the version instead of leaking a resolver stack trace — and **fails**,
rather than quietly skipping the check.

### Where it runs, and what actually blocks a bad deploy

`site.yml` runs `npm test` **twice**, and the two runs guard different things. This is not
belt-and-braces; skip either one and something real gets through.

| Step | When | What it can actually catch |
|---|---|---|
| `tests.yml` | every branch + PR (`main` excluded) | logic regressions, as a red X on the commit — the only coverage branches and PRs get, since `site.yml` only triggers on pushes to `main` |
| `site.yml` → "Run all checks (npm test)" | after `npm ci`, **before** the scrapes | broken *code*, before it is allowed to touch the network |
| `site.yml` → "Re-check the refreshed data (THE DATA GATE)" | after the scrapes, **before** the commit and the deploy | broken *data* — the snapshot this run just produced |

The ordering is the whole point. The data checks (`test-ai-scale.mjs`,
`test-consensus-direction.mjs`) read `src/data/*.json` **off disk**, so in the pre-scrape run
they are validating the *previous* commit's snapshot. On their own they would have let a
repeat of the ÷10 AI-scale bug be committed to `main` and deployed, going red only on the
next cron run five hours later — with the bad data already live. The refresh commit also
carries `[skip ci]`, so `tests.yml` never sees it either.

Neither `npm test` step has `continue-on-error`, unlike the refresh steps above, which are
deliberately failure-tolerant. Failing the data gate aborts before the commit and before the
Pages deploy, so nothing is written and the last good deploy stays up.

`main` is excluded from `tests.yml` because `site.yml` runs the identical command on every
push to it — that exclusion is a duplicate-job saving, not a coverage gap.

<!-- END: Tests -->

## Enrich — the AI trio, the queue, and the cost bound

Where `ci/refresh-data-ci.mjs` and `scripts/refresh-data.mjs` top up rows
from the per-ticker `stock-forecast` payload. This is the only per-ticker source for the
AI-analyst score/rating/target and the sector name — `getData` exposes neither.

**Why the AI trio overwrites instead of filling.** Rows outside a run's screener pull are
built by `rowFromGetData`, which carries `ai`/`air`/`aipt`/`chg` verbatim from the previous
row (`getData` genuinely has no AI-analyst fields, so carrying beats blanking). Nothing else
ever re-checks them. Selecting only rows that "need a null filled" made that permanent: a
carried row has both non-null, so it could never be picked, and `fillNulls` cannot overwrite
a non-null anyway. UNP showed "Outperform"/74 for ~10 days (~46 runs) after TipRanks
downgraded it to Neutral/69. Hence `|| !inPull.has(t)` in the eligibility filter.

`chg` belongs in that set for the same reason and was the field the first pass forgot: it is
Day %, the most time-sensitive column in the table, frozen on every off-pull row. Sampled
12/12 wrong, sign wrong in 8 — TER showed +12.07 against a live +0.60, ARTV +9.29 against
−3.16. The payload we already fetch carries it, so repairing it costs no extra request.

**Shared, not mirrored.** The queue (`enrichQueue`) and the write (`applyForecast`) live in
`ci/keep.mjs`; both refresh scripts import them and supply only the transport (FlareSolverr
vs Playwright). They each held a copy once, drifted, and silently reproduced a bug the other
had already fixed — `ci/test-enrich.mjs` now fails if either re-inlines the logic.

**Atomicity.** The trio lands whole or not at all — *when there is something to be
inconsistent with*. Field-by-field, a payload with `score` but no `ratingId` ships a fresh 69
beside a stale "Outperform": the exact UNP symptom, at half scale. Note the fix is not simply
"never write a partial trio": the hazard is mixing **epochs**, which needs a stale value
present. On a row whose trio is entirely blank there is nothing to mix, and refusing the write
is strictly worse — `needsFill()` stays true, so the row camps at prio 1 and burns one fetch
every run, forever (this regressed once, on the ~7 permanently-unscored rows). So: a trio
holding any value is all-or-nothing; a blank trio takes whatever the payload has, and the
missing fields keep rendering "—". `applyForecast` returns `trio` / `partial` / `fill` /
`none` so the log distinguishes the two. `chg` is independent of the AI report and is applied
separately.

**Scale.** The overwrite depends on `forecastFields` emitting `ai` on the screener's 0–100
scale. Reinstate the old `/10` and the overwrite drags every off-pull row onto 0–10, where
the UI's `scoreColor(s.ai, 100)` paints them dark — the fill path already stranded AAPL at
8.2 and TER at 7.8 that way. `ci/test-ai-scale.mjs` guards it; see *AI score scale* below.

**Rotation and the cost bound.** Queue order is oldest-AI-first, and `ea` (enriched-at) is
stamped on **attempt, not success**, so a permanently-dead ticker goes to the back instead of
camping at the head. `ls` cannot serve as that clock — `nextLastSeen` deliberately freezes it
for exactly the off-pull tickers being rotated. `ba` does the same job for the backfill queue.
Worst-case staleness is `ceil(eligible / (ENRICH_LIMIT − sticky))` runs × the 5h cron.
Measured 2026-08-03: 73 off-pull with 9 sticky slots (2 pins by design, 7 rows whose payload
carries no AI report at all) → 31 fresh slots/run → 3 runs ≈ 15h, inside a news cycle.

`ENRICH_LIMIT` is **derived**, not fixed: a fixed 40 could not bound a set growing ~5.7/day,
and the 15h worst case would decay to ~50h within six weeks. Floor 40 for small sets, ceiling
`ENRICH_MAX` (120) because every unit is one FlareSolverr fetch on top of `BACKFILL_LIMIT`.

The ceiling does a second job: it is what makes the staleness `WARNING` reachable. While the
cap was purely `eligible / ENRICH_TARGET_RUNS`, the condition `eligible > cap * runs` was
arithmetically unsatisfiable — a guard that read as protection and was dead code. With the
ceiling it fires above 360 eligible rows, i.e. when rotation really has slipped past target.
`ci/test-enrich.mjs` asserts both the bound and that regression.

## Smart Score — why an explicit `null` is data, not a miss

TipRanks emits `score: null` as a **real value** meaning "this stock has no Smart Score".
Verified live: ASTI and BCDA both return the full `tipranksStockScore` object
(`returnOnAssets`, `momentum`, `assetGrowth`, …) with `"score": null`, while GOOGL comes back
10 and DNLI 6 from the very same shape. So `ssFromGetData` keys off the **presence of the
key**, not the nullness of the value.

A plain `?? prev.ss` collapses "no score" and "payload reshaped" into a single "carry", which
resurrects the last known number and serves it as if freshly read. ASTI stayed frozen at
`ss: 2` from 2026-07-23 across 7 market-moving runs and could never recover to "—" while it
stayed off the screener list.

**The trade-off, stated deliberately.** If TipRanks ever drops `tipranksStockScore` entirely
or renames `score`, every keep-path ticker silently holds its previous `ss`. That is the safe
side of the line: a vanished field is a *scraper bug*, not a data change, and freezing beats
blanking 350 rows on our own parse error. An explicit null is the opposite — it *is* the data,
so we fail visibly and render "—". An explicitly `null` *object* is lumped in with absent
(unobserved in the wild; carrying is the conservative reading).

This is also what makes the two write paths agree rather than disagree: the screener path uses
`?? null`, which is why on-list no-score tickers like BCDA already render "—". A wholesale
screener failure cannot quietly blank the file either — the row-count guard in
`refresh-data-ci.mjs` aborts before anything is written — and a garbage per-ticker response
cannot reach the mapper, since both callers accept the mapped row only `if (row.t)` and
otherwise carry the whole previous row.

## AI score scale

`ai` is 0–100 on **both** sources. `report.score` verified live at TER 71 / AAPL 75 / NVDA 79,
the same scale as the screener's `aiAnalystData.overallScore` (live spread 39–85). `aipt` is a
price target in dollars, not a score — TER 406 vs px 367.69, AAPL 348 vs 308.91, NVDA 223 vs
200.75. Neither is rescaled.

A `/10` in `forecastFields` once wrote the two pinned rows on a 0–10 scale (TER 7.8 for a real
71) and went unnoticed for 58 commits, because that path only ever ran for pins — exactly two
rows of 344 — and one small number in isolation is indistinguishable from a genuinely low
score. `fillNulls` could not self-heal them either, since it never overwrites a non-null; the
enrich overwrite pass is what repaired them.

`aiScaleError` encodes the detectable signal — the **mixture** — with one stated assumption:
**no ticker legitimately scores ≤ 10 on the 0–100 scale.** Of 344 non-null rows the real
spread is 39–85 and the 1st percentile is 41; nothing has ever come in under 30. If TipRanks
ever publishes a genuine single-digit score this trips. That is the deliberate cost of a check
that cannot be fooled.

Two rejected alternatives, so they don't get re-proposed:

- **A max/min ratio.** False-positives on any legitimately wide spread — 8 → 85 is a ratio of
  10.6 and perfectly valid data.
- **Lowering the `floor` argument "to be careful."** It is the low/high split point, so
  lowering it *silences* the guard: at `floor: 5`, 7.8 and 8.2 count as high and the original
  bug passes. Raising it tightens. `ci/test-keep.mjs` pins this footgun with explicit
  assertions.

`ci/test-ai-scale.mjs` points the guard at the data we actually ship, and carries a positive
control derived from the shipped rows — rescale one by `/10` and the guard must name it — so
neutering `aiScaleError` to `return null` cannot make the file pass silently.

