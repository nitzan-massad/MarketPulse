import { useEffect, useRef } from "react";
import posts from "../data/posts.json";
import { paint } from "../postArt";
import { consLabel, fmtPx } from "../lib";

export type Post = {
  id: string;
  ts: string;
  kind: string;
  ticker: string;
  name: string;
  sector: string;
  text: string;
  score: number;
  reasons: string[];
  facts: Record<string, string | number | boolean>;
  /** Filename only (e.g. "ALAB-2026-09-22T14-35-30-122Z.jpg"), never a path — set by
   *  ci/generate-posts.mjs when the photo (ci/post-image.mjs) AND the fusion step
   *  (ci/post-compose.mjs, which burns `text` into the photo's pixels) both succeed, absent
   *  otherwise. This is a JPEG (ci/jpeg-encode.mjs), not the raw Flux photo verbatim — the
   *  post's words are already part of the pixels, which is the whole point (the file can be
   *  posted elsewhere and the text travels with it); JPEG rather than PNG keeps a card in the
   *  tens/low-hundreds of KB instead of ~900KB, which matters at POSTS_KEEP's scale. The
   *  filename is already sanitised at write time (ci/post-image.mjs's postImageFilename), so
   *  nothing here re-derives it from `id` — see PostArt below. */
  image?: string;
};

const p2 = (n: number) => String(n).padStart(2, "0");

/** Created-at, in the VIEWER'S local timezone, as `dd/mm HH:mm`. getDate/getMonth/getHours
 *  are local-time getters, so a post written at 13:44 UTC reads 16:44 in Israel — which is
 *  the point. Returns "" for a bad value rather than rendering "NaN/NaN" into the feed. */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Newest first. The generator already prepends, but ordering the feed is the feed's job —
 *  a hand-edited or merged posts.json must still render in the right order. */
export function sortNewestFirst(list: Post[]): Post[] {
  const key = (p: Post) => {
    const t = Date.parse(p?.ts);
    return Number.isFinite(t) ? t : -Infinity; // an unparseable stamp sinks to the bottom
  };
  return [...list].sort((a, b) => key(b) - key(a));
}

// ======================================================= (5)/(6) the context sentence =======
//
// A second, longer sentence rendered BELOW the image (never burned into it — see the render
// below and .feed-context in src/index.css) giving real context before the reader taps through
// to the stock page. DERIVED FROM THE HOOK'S OWN FACTS, deliberately not generated: a second
// model-written field is another fabrication surface AND another Cloudflare call per post, for
// output that is mostly formatting (see ci/README.md's fabrication-verifier history — "IRD
// soared 151.7%" got through review once already on a real-numbers-wrong-claim). This project
// had exactly this before, once: `supportLine`, a one-liner built from a post's facts, deleted
// in commit c14e95ec when the text moved onto the image itself (`git log --all -S supportLine`).
// This reuses that approach — read the facts, format them, never ask a model — but is RICHER: a
// full sentence (price against target, analyst count, the window, a sector comparison), one
// branch per real hook kind so no kind degrades to the bare company name (the bug that made the
// old version worth deleting was thinner coverage, not the no-LLM idea itself — five of the nine
// kinds back then fell through to a near-empty generic reading).
//
// (4) THE "WHEN" — same rule as the burned-in figure's colour, see `hasGenuineChange` below.
// Only `movement` ("since the last update") and `record` ("over the past N days") ever state a
// TIME for a NUMBER changing, because those are the only two kinds whose facts prove a real
// before/after happened. `steady`'s "held for N days straight" and `newcomer`'s "first tracked N
// days ago" both mention a duration too, but neither one times a NUMBER'S change — one is how
// long a state has persisted (the absence of a change), the other is when we started tracking
// the name (a data-availability fact, not a claim the stock moved then). Nothing here ever
// writes "today"/"just now"/a clock time for a standing figure.

type Facts = Post["facts"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const plural = (n: number, word: string) => `${Math.round(n)} ${word}${Math.round(n) === 1 ? "" : "s"}`;
const pct = (n: number) => `${n}%`;
// Money is ALWAYS fmtPx (src/lib.ts) here, never a private "$"+toFixed() copy — that private-
// copy trap is exactly how "$0.00" survived StockModal's first fix (see ci/test-price-format.mjs,
// which scans every src/*.tsx file's SOURCE for a hand-rolled money formatter, this one
// included). `money` is just a short local alias so the per-kind builders below read cleanly.
const money = (n: number) => fmtPx(n);

/** Stitch fact fragments into one readable, capitalised, period-terminated sentence. Every
 *  per-kind builder below is written so it always supplies at least one real fragment — the
 *  regression this guards is the exact one that made the old `supportLine` worth replacing: a
 *  hand-rolled reading that quietly degraded to nothing but the company name for kinds it didn't
 *  have a branch for. */
function joinSentence(parts: (string | null)[]): string {
  const clean = parts.filter((p): p is string => Boolean(p));
  if (!clean.length) return "";
  const s = clean.join(", ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/**
 * Mirrors ci/hooks.mjs's `hasGenuineChange` — see that module's own comment (right above its
 * `hasGenuineChange`/`genuineChangeDirection`) for the full reasoning. Duplicated here rather
 * than imported: ci/ is the Node pipeline and src/ is the browser app, two runtimes this repo
 * deliberately never shares code between (see CLAUDE.md's three-layer split) — kept in step by
 * ci/test-hooks.mjs and this file's own postfeed.check.ts both asserting against ci/hooks.mjs's
 * REAL, live fact shapes for every kind, not a hand-rolled guess at them.
 *
 * A hook only describes a genuine, MEASURED change when its facts carry a real before/after pair
 * for the same metric — `upsideFrom`/`upsideTo` (movement), `windowLow`/`windowHigh` (record),
 * or `smartScoreFrom`/`smartScoreTo`. A bare current figure (`upside`, `smartScore`,
 * `leaderUpside`, …) — surprise/contrarian/steady/newcomer/list — is a STANDING state: most
 * numbers in this feed are analyst upside-to-target, a forecast, never something that already
 * happened to the stock (a published post once read "IRD soared 151.7%" for exactly this kind of
 * number — every digit real, the claim false).
 */
export function hasGenuineChange(facts: Facts): boolean {
  const f = facts ?? {};
  return (
    (num(f.upsideFrom) !== null && num(f.upsideTo) !== null) ||
    (num(f.smartScoreFrom) !== null && num(f.smartScoreTo) !== null) ||
    (num(f.windowLow) !== null && num(f.windowHigh) !== null)
  );
}

/** surprise — the number itself is the story (ci/hooks.mjs `# 1. SURPRISE`). A standing
 *  analyst-upside figure: no "when", never coloured as a move (see `hasGenuineChange` above). */
function surpriseLine(post: Post): string {
  const f = post.facts;
  const up = num(f.upside), price = num(f.price), pt = num(f.priceTarget);
  const an = num(f.analysts), con = str(f.consensus);
  const secMed = num(f.sectorMedianUpside);
  const parts: (string | null)[] = [];
  if (price !== null && pt !== null && up !== null) {
    parts.push(`${money(price)} against a ${money(pt)} Street target puts ${pct(up)} upside on the table`);
  } else if (up !== null) {
    parts.push(`${pct(up)} upside to the Street's target`);
  }
  if (an !== null) parts.push(`${plural(an, "analyst")} covering it`);
  if (con !== null) parts.push(`consensus ${consLabel(con)}`);
  if (secMed !== null && up !== null) {
    parts.push(`${up >= secMed * 2 ? "more than double" : up > secMed ? "well above" : "below"} ${post.sector}'s ${pct(secMed)} median`);
  }
  return joinSentence(parts);
}

/** contrarian — two models disagree (ci/hooks.mjs `# 2. CONTRARIAN`). A standing snapshot of a
 *  disagreement, not a change in either model's own rating: no "when", neutral figures. */
function contrarianLine(post: Post): string {
  const f = post.facts;
  const ss = num(f.smartScore), ai = num(f.aiScore), air = str(f.aiRating), bullish = str(f.bullish);
  const con = str(f.consensus), up = num(f.upside), price = num(f.price), an = num(f.analysts);
  const parts: (string | null)[] = [];
  if (ss !== null && ai !== null) {
    const lean = bullish === "quant" ? "the quant model is the more bullish of the two"
      : bullish === "ai" ? "the AI model is the more bullish of the two"
      : "the two models split";
    parts.push(`Smart Score ${ss}/10 against an AI score of ${ai}/100${air ? ` (${air})` : ""} — ${lean}`);
  }
  if (con !== null) parts.push(`Street consensus ${consLabel(con)}`);
  if (up !== null) parts.push(`${pct(up)} upside`);
  if (an !== null) parts.push(`${plural(an, "analyst")} covering it`);
  if (price !== null) parts.push(`priced at ${money(price)}`);
  return joinSentence(parts);
}

/** movement — what changed since the last run (ci/hooks.mjs `# 3. MOVEMENT`). ALWAYS a genuine
 *  change (upsideFrom/upsideTo are guaranteed present whenever this kind fires) — the "since the
 *  last update" framing is correct and welcome here. */
function movementLine(post: Post): string {
  const f = post.facts;
  const upFrom = num(f.upsideFrom), upTo = num(f.upsideTo);
  const conFrom = str(f.consensusFrom), conTo = str(f.consensusTo);
  const ssFrom = num(f.smartScoreFrom), ssTo = num(f.smartScoreTo);
  const price = num(f.price), pt = num(f.priceTarget), an = num(f.analysts);
  // GATED ON THE SHARED PREDICATE, not just this kind's name — "since the last update" only
  // ever appears when `hasGenuineChange` actually confirms a real before/after pair is present
  // (in practice always true here, since upsideFrom/upsideTo IS one of that predicate's pairs).
  const genuine = hasGenuineChange(f);
  const parts: (string | null)[] = [];
  if (upFrom !== null && upTo !== null) {
    const verb = upTo > upFrom ? "climbed" : upTo < upFrom ? "eased back" : "held steady";
    parts.push(`Upside ${verb} from ${pct(upFrom)} to ${pct(upTo)}${genuine ? " since the last update" : ""}`);
  }
  if (conFrom !== null && conTo !== null) parts.push(`consensus flipped from ${consLabel(conFrom)} to ${consLabel(conTo)}`);
  else if (conTo !== null) parts.push(`consensus is now ${consLabel(conTo)}`);
  if (ssFrom !== null && ssTo !== null) parts.push(`Smart Score ${ssFrom} → ${ssTo}`);
  const priceBits: string[] = [];
  if (price !== null) priceBits.push(`priced at ${money(price)}`);
  if (pt !== null) priceBits.push(`against a ${money(pt)} target`);
  if (an !== null) priceBits.push(`across ${plural(an, "analyst")}`);
  if (priceBits.length) parts.push(priceBits.join(" "));
  return joinSentence(parts);
}

/** record — today's upside is the highest in the window (ci/hooks.mjs `# 4. RECORD`). ALWAYS a
 *  genuine change (windowLow/upside are guaranteed present whenever this fires) — "over the past
 *  N days" is correct and welcome here. */
function recordLine(post: Post): string {
  const f = post.facts;
  const low = num(f.windowLow), up = num(f.upside), days = num(f.days), snaps = num(f.snapshots);
  const price = num(f.price), pt = num(f.priceTarget), an = num(f.analysts), secMed = num(f.sectorMedianUpside);
  // Same gate as movementLine above — record's windowLow/windowHigh pair is what
  // `hasGenuineChange` actually checks (windowHigh itself isn't quoted in the sentence, but its
  // presence alongside windowLow is what makes "a new high" a provable claim, not a guess).
  const genuine = hasGenuineChange(f);
  const parts: (string | null)[] = [];
  if (low !== null && up !== null) {
    const period = days !== null ? `over the past ${plural(days, "day")}`
      : snaps !== null ? `across ${plural(snaps, "snapshot")}` : "";
    const when = genuine && period ? ` ${period}` : "";
    parts.push(`Upside climbed from a ${pct(low)} window low to ${pct(up)} now — a new high${when}`);
  }
  const priceBits: string[] = [];
  if (price !== null) priceBits.push(`priced at ${money(price)}`);
  if (pt !== null) priceBits.push(`against a ${money(pt)} target`);
  if (an !== null) priceBits.push(`across ${plural(an, "analyst")}`);
  if (priceBits.length) parts.push(priceBits.join(" "));
  if (secMed !== null && up !== null) parts.push(`versus ${post.sector}'s ${pct(secMed)} median`);
  return joinSentence(parts);
}

/** steady — never left the top of the scale all window (ci/hooks.mjs `# 5. STEADY`). A standing
 *  state BY DEFINITION (it fires on the ABSENCE of a change) — "held for N days" describes a
 *  duration, not a timed change, so it stays even though this kind carries no colour/when for
 *  its figures. */
function steadyLine(post: Post): string {
  const f = post.facts;
  const ss = num(f.smartScore), days = num(f.days), snaps = num(f.snapshots);
  const up = num(f.upside), con = str(f.consensus), an = num(f.analysts);
  const parts: (string | null)[] = [];
  if (ss !== null && days !== null) parts.push(`Smart Score has held at ${ss}/10 for ${plural(days, "day")} straight`);
  else if (ss !== null && snaps !== null) parts.push(`Smart Score has held at ${ss}/10 across ${plural(snaps, "snapshot")}`);
  const rest: string[] = [];
  if (up !== null) rest.push(`${pct(up)} upside`);
  if (con !== null) rest.push(`${consLabel(con)} consensus`);
  if (an !== null) rest.push(`across ${plural(an, "analyst")}`);
  if (rest.length) parts.push(rest.join(", "));
  return joinSentence(parts);
}

/** newcomer — absent when the window opened, here now (ci/hooks.mjs `# 6. NEWCOMER`). The "N
 *  days ago" here times when the name FIRST APPEARED in the tracked data, never a claim that its
 *  upside moved then — that figure is stated plainly, with no time attached. */
function newcomerLine(post: Post): string {
  const f = post.facts;
  const days = num(f.days), seenIn = num(f.seenIn), windowSnaps = num(f.windowSnapshots);
  const up = num(f.upside), con = str(f.consensus), an = num(f.analysts), ss = num(f.smartScore);
  const parts: (string | null)[] = [];
  if (days !== null) parts.push(`First tracked on the board ${plural(days, "day")} ago`);
  else if (seenIn !== null && windowSnaps !== null) parts.push(`New to the board — present for ${seenIn} of the last ${windowSnaps} snapshots`);
  const rest: string[] = [];
  if (up !== null) rest.push(`currently ${pct(up)} upside`);
  if (con !== null) rest.push(`${consLabel(con)} consensus`);
  if (an !== null) rest.push(`across ${plural(an, "analyst")}`);
  if (ss !== null) rest.push(`Smart Score ${ss}`);
  if (rest.length) parts.push(rest.join(", "));
  return joinSentence(parts);
}

/** list — a carousel of the window's strongest upsides (ci/hooks.mjs `# 7. LIST`). A ranking of
 *  standing figures, not an event: no "when", no colour. */
function listLine(post: Post): string {
  const f = post.facts;
  const count = num(f.count), leader = str(f.leader), leaderUp = num(f.leaderUpside), members = str(f.members);
  const parts: (string | null)[] = [];
  if (count !== null) parts.push(`${plural(count, "name")} cleared 30% upside today`);
  if (leader !== null && leaderUp !== null) parts.push(`led by ${leader} at ${pct(leaderUp)}`);
  if (members !== null) parts.push(`full board: ${members}`);
  return joinSentence(parts);
}

/** Fallback for a kind this file has no dedicated branch for (there should never be one — the
 *  seven above are every kind ci/hooks.mjs emits, and ci/test-generate-posts.mjs fails first if
 *  an eighth is ever added without a KIND_BRIEF entry). Still never degrades to the bare company
 *  name — the exact bug that made the old `supportLine` worth replacing. */
function genericLine(post: Post): string {
  const f = post.facts;
  const ssFrom = num(f.smartScoreFrom), ssTo = num(f.smartScoreTo);
  const upFrom = num(f.upsideFrom), upTo = num(f.upsideTo), up = num(f.upside), pt = num(f.priceTarget);
  const an = num(f.analysts);
  const parts: (string | null)[] = [];
  if (ssFrom !== null && ssTo !== null) parts.push(`Smart Score ${ssFrom} → ${ssTo}`);
  if (upFrom !== null && upTo !== null) parts.push(`upside ${pct(upFrom)} → ${pct(upTo)}`);
  else if (up !== null) parts.push(pt !== null ? `${pct(up)} upside to a ${money(pt)} target` : `${pct(up)} upside`);
  if (an !== null) parts.push(`${plural(an, "analyst")} covering it`);
  const line = joinSentence(parts);
  return line || `Fresh data on ${post.name} this update.`;
}

const KIND_CONTEXT: Record<string, (post: Post) => string> = {
  surprise: surpriseLine, contrarian: contrarianLine, movement: movementLine,
  record: recordLine, steady: steadyLine, newcomer: newcomerLine, list: listLine,
};

/** The rich commentary sentence rendered below the image — see the section header above for the
 *  full "derive, don't generate" + "when is only for a genuine change" reasoning. */
export function contextSentence(post: Post): string {
  const build = KIND_CONTEXT[post.kind] ?? genericLine;
  return build(post);
}

/** The canvas fallback — a light procedural scene keyed off the sector, seeded by the ticker
 *  so a given name always looks the same. Used whenever a post has no real `image` (Flux
 *  generation was off, the photo or the fusion step failed, or the post predates this
 *  feature). Purely decorative and carries no text of its own — the kind pill and timestamp
 *  next to it are plain DOM chrome (see PostFeed below), so this stays aria-hidden. */
function CanvasArt({ post }: { post: Post }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const redraw = () => paint(cv, post.sector, post.ticker);
    redraw();
    // The card is fluid, and the first paint can land before layout has a width.
    const ro = new ResizeObserver(redraw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [post.sector, post.ticker]);

  return <canvas ref={ref} className="feed-art" aria-hidden="true" />;
}

/** The card's image: a real photograph with the post's text already burned into its pixels
 *  (ci/post-compose.mjs) when ci/generate-posts.mjs made one (post.image — a filename only,
 *  never a path), the canvas scene otherwise (see CanvasArt). There is no text overlay here
 *  any more — the browser used to lay `text` over the art with a scrim for contrast, but the
 *  words are now part of the image file itself, which is the whole point: the same PNG can be
 *  posted to X or Instagram and the text travels with it.
 *
 *  `base` is Vite's BASE_URL, same as every other lazy-fetched public/ asset (forecasts,
 *  bullbear, reviews-recent) — production serves from `/MarketPulse/`, not `/`, and this is
 *  the one that 404s only in production if it is missed (see CLAUDE.md). It is a PROP, not
 *  read here via `import.meta.env`, for the exact reason share.ts documents on
 *  `buildShareUrl`: ci/run-tests.mjs compiles src/*.check.ts (postfeed.check.ts imports this
 *  file, for formatStamp/sortNewestFirst) with `--module commonjs`, where `import.meta` is a
 *  hard compile error — so App.tsx reads it and passes it down instead.
 *
 *  ACCESSIBILITY: since the post's text now exists only as pixels, `alt` carries the actual
 *  post text (not a generic sector label) — that text is the only thing here worth a screen
 *  reader announcing, and it is otherwise invisible to one. */
function PostArt({ post, base, onOpen }: { post: Post; base: string; onOpen: (t: string) => void }) {
  const art = post.image ? (
    <img
      className="feed-art"
      src={`${base}post-images/${post.image}`}
      alt={post.text}
      loading="lazy"
    />
  ) : (
    <CanvasArt post={post} />
  );

  /* A real <button>, not an onClick on the <img>: this is the only way into the stock's
     detail view from the feed, so it has to be reachable by keyboard and announced as a
     control. The label says where it goes, because the image's own alt is the post text. */
  return (
    <button type="button" className="feed-art-btn" onClick={() => onOpen(post.ticker)}
            aria-label={`Open ${post.name}`}>
      {art}
    </button>
  );
}

export function PostFeed({ base, onOpenTicker }: { base: string; onOpenTicker: (t: string) => void }) {
  // `as unknown as Post[]`, not `as Post[]`. With resolveJsonModule, tsc infers a UNION of
  // one object type per post in the file, and every branch of that union gets `key?: undefined`
  // for the `facts` keys the other branches have. Those optional-undefined members are not
  // assignable to `Record<string, string | number | boolean>`, so under `strict` a direct cast
  // is rejected with TS2352 — but only once posts.json holds two or more DIFFERENT hook kinds,
  // which is why an empty or single-kind file compiled fine. The inferred union is an artifact
  // of whatever happens to be in the committed JSON, not the runtime shape: ci/hooks.mjs emits
  // a flat bag of primitives per kind, which is exactly `Post["facts"]`. Widening through
  // `unknown` says that once, here, instead of making the type lie.
  const items = sortNewestFirst(posts as unknown as Post[]);

  if (!items.length) {
    return (
      <div className="feed-empty">
        <p>No posts yet.</p>
        <p className="feed-empty-sub">The next data refresh writes one.</p>
      </div>
    );
  }

  return (
    <ul className="feed">
      {items.map((p) => (
        <li key={p.id} className={`feed-card k-${p.kind}`}>
          {/* Chrome, not part of the meme: the kind pill and timestamp are plain DOM above
              the art now, not an overlay burned/positioned on top of it — the post's actual
              text lives only in the image's pixels (or nowhere, on the canvas fallback). */}
          <div className="feed-card-head">
            <span className="feed-kind">{p.kind}</span>
            <time className="feed-stamp" dateTime={p.ts}>{formatStamp(p.ts)}</time>
          </div>
          <PostArt post={p} base={base} onOpen={onOpenTicker} />
          {/* (5)/(6) the derived context sentence — BELOW the image, never burned into it, and
              styled (.feed-context, src/index.css) to read as MarketPulse's own commentary on
              the post rather than a caption belonging to the photo: the user's own words were
              "visually separated so that it doesn't appear directly related to the image
              itself". See contextSentence()'s own header comment above for the derivation rule. */}
          <p className="feed-context">{contextSentence(p)}</p>
        </li>
      ))}
    </ul>
  );
}
