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

/** The line under the art, built from the post's own facts. Deliberately NOT generated: a
 *  second model field would need its own prompt, scoring and failure mode to produce what is
 *  really just data formatting. */
export function supportLine(post: Post): string {
  const f = post?.facts ?? {};
  const parts: string[] = [];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  const ssFrom = num(f.smartScoreFrom), ssTo = num(f.smartScoreTo);
  if (ssFrom !== null && ssTo !== null) parts.push(`Smart Score ${ssFrom} → ${ssTo}`);
  else if (num(f.smartScore) !== null && num(f.aiScore) !== null)
    parts.push(`Smart Score ${f.smartScore}, AI ${f.aiScore}`);

  const up = num(f.upside) ?? num(f.upsideTo);
  const pt = num(f.priceTarget);
  if (up !== null) parts.push(pt !== null ? `${up}% to $${pt}` : `${up}%`);

  const an = num(f.analysts);
  if (an !== null) parts.push(`${an} analyst${an === 1 ? "" : "s"}`);

  return [post?.name, ...parts].filter(Boolean).join(" · ");
}

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
  const items = sortNewestFirst(posts as Post[]);

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
          <div className="feed-card-head">
            <span className="feed-kind">{p.kind}</span>
            <time className="feed-stamp" dateTime={p.ts}>{formatStamp(p.ts)}</time>
          </div>
          <h3 className="feed-hook">{p.text}</h3>
          <PostArt post={p} />
          <p className="feed-support">{supportLine(p)}</p>
        </li>
      ))}
    </ul>
  );
}
