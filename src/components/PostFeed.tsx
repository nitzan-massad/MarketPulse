import { useEffect, useRef } from "react";
import posts from "../data/posts.json";
import { paint } from "../postArt";

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
  /** Filename only (e.g. "ALAB-2026-09-22T14-35-30-122Z.png"), never a path — set by
   *  ci/generate-posts.mjs when the photo (ci/post-image.mjs) AND the fusion step
   *  (ci/post-compose.mjs, which burns `text` into the photo's pixels) both succeed, absent
   *  otherwise. This is a PNG, not the raw Flux JPEG — the post's words are already part of
   *  the pixels, which is the whole point (the file can be posted elsewhere and the text
   *  travels with it). The filename is already sanitised at write time
   *  (ci/post-image.mjs's postImageFilename), so nothing here re-derives it from `id` — see
   *  PostArt below. */
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
function PostArt({ post, base }: { post: Post; base: string }) {
  if (post.image) {
    return (
      <img
        className="feed-art"
        src={`${base}post-images/${post.image}`}
        alt={post.text}
        loading="lazy"
      />
    );
  }
  return <CanvasArt post={post} />;
}

export function PostFeed({ base }: { base: string }) {
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
          <PostArt post={p} base={base} />
        </li>
      ))}
    </ul>
  );
}
