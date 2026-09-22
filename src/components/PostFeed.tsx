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

/** The card IS the image: canvas fills the card, a light top-weighted scrim (.feed-scrim,
 *  see src/index.css) sits over it for guaranteed text contrast, and the pill/timestamp/hook
 *  overlay on top of that. Nothing renders below the art — no separate support line. */
function PostArt({ post }: { post: Post }) {
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

export function PostFeed() {
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
          <PostArt post={p} />
          <div className="feed-scrim" aria-hidden="true" />
          <div className="feed-overlay">
            <div className="feed-card-head">
              <span className="feed-kind">{p.kind}</span>
              <time className="feed-stamp" dateTime={p.ts}>{formatStamp(p.ts)}</time>
            </div>
            <h3 className="feed-hook">{p.text}</h3>
          </div>
        </li>
      ))}
    </ul>
  );
}
