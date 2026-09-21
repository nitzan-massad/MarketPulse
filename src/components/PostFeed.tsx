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

type Facts = Record<string, string | number | boolean>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** surprise / contrarian / trend / movement — the four kinds this line was originally
 *  written for. They all carry some combination of a Smart Score pair (or Smart Score +
 *  AI Score), an upside (plain or a "from/to" reading), a price target and an analyst
 *  count, so one generic reading covers all four. Also the fallback for any kind (or
 *  missing kind) that matches none of the dedicated branches below. */
function genericLine(f: Facts): string[] {
  const parts: string[] = [];

  const ssFrom = num(f.smartScoreFrom), ssTo = num(f.smartScoreTo);
  if (ssFrom !== null && ssTo !== null) parts.push(`Smart Score ${ssFrom} → ${ssTo}`);
  else if (num(f.smartScore) !== null && num(f.aiScore) !== null)
    parts.push(`Smart Score ${f.smartScore}, AI ${f.aiScore}`);

  const up = num(f.upside) ?? num(f.upsideTo);
  const pt = num(f.priceTarget);
  if (up !== null) parts.push(pt !== null ? `${up}% to $${pt}` : `${up}%`);

  const an = num(f.analysts);
  if (an !== null) parts.push(plural(an, "analyst"));

  return parts;
}

/** list — a carousel of the window's strongest upsides (ci/hooks.mjs `# 9. LIST`). `members`
 *  is the full "TICK (up% to $target)" rundown for every name in the carousel — far too long
 *  for one line under a card — so the line states the count and who is leading it instead. */
function listLine(f: Facts): string[] {
  const parts: string[] = [];
  const count = num(f.count);
  const leader = typeof f.leader === "string" && f.leader ? f.leader : null;
  const leaderUpside = num(f.leaderUpside);
  if (count !== null) parts.push(plural(count, "name"));
  if (leader !== null) parts.push(leaderUpside !== null ? `${leader} leads at ${leaderUpside}%` : `${leader} leads`);
  return parts;
}

/** churn — the quant model flip-flopped across the window (ci/hooks.mjs `# 7. CHURN`). The
 *  post-worthy fact is how many distinct scores it cycled through, and the range. */
function churnLine(f: Facts): string[] {
  const parts: string[] = [];
  const distinct = num(f.distinctScores), days = num(f.days);
  const low = num(f.low), high = num(f.high);
  if (distinct !== null && days !== null) parts.push(`${plural(distinct, "different score")} in ${plural(days, "day")}`);
  const an = num(f.analysts);
  if (low !== null && high !== null) parts.push(`${low} to ${high}`);
  if (an !== null) parts.push(plural(an, "analyst"));
  return parts;
}

/** steady — never left the top of the scale for the whole window (ci/hooks.mjs `# 6. STEADY`).
 *  The streak length IS the story; a bare Smart Score says nothing a snapshot wouldn't. */
function steadyLine(f: Facts): string[] {
  const parts: string[] = [];
  const ss = num(f.smartScore), days = num(f.days);
  if (ss !== null && days !== null) parts.push(`Smart Score ${ss} for ${plural(days, "day")}`);
  const up = num(f.upside);
  if (up !== null) parts.push(`${up}% upside`);
  const an = num(f.analysts);
  if (an !== null) parts.push(plural(an, "analyst"));
  return parts;
}

/** record — today's upside is the window high (ci/hooks.mjs `# 4. RECORD`). `upside` is
 *  ~= `windowHigh` (the rule requires it), so the line reads as the window low climbing to
 *  today's reading, which is the "high" that makes this worth posting. */
function recordLine(f: Facts): string[] {
  const parts: string[] = [];
  const low = num(f.windowLow), up = num(f.upside), days = num(f.days);
  if (low !== null && up !== null && days !== null) parts.push(`${low}% → ${up}%, a ${days}-day high`);
  else if (up !== null) parts.push(`${up}%`);
  const an = num(f.analysts);
  if (an !== null) parts.push(plural(an, "analyst"));
  return parts;
}

/** newcomer — absent when the window opened, here now (ci/hooks.mjs `# 8. NEWCOMER`). The
 *  arrival itself is the fact; the upside/analyst pair is the same shape used elsewhere. */
function newcomerLine(f: Facts): string[] {
  const parts: string[] = [];
  const days = num(f.days);
  if (days !== null) parts.push(`New ${plural(days, "day")} ago`);
  const up = num(f.upside);
  if (up !== null) parts.push(`${up}% upside`);
  const an = num(f.analysts);
  if (an !== null) parts.push(plural(an, "analyst"));
  return parts;
}

const KIND_LINES: Record<string, (f: Facts) => string[]> = {
  list: listLine, churn: churnLine, steady: steadyLine, record: recordLine, newcomer: newcomerLine,
};

/** The line under the art, built from the post's own facts. Deliberately NOT generated: a
 *  second model field would need its own prompt, scoring and failure mode to produce what is
 *  really just data formatting.
 *
 *  Dispatches on `kind` because the nine hooks in ci/hooks.mjs emit nine different fact
 *  shapes — surprise/contrarian/trend/movement share one (handled by `genericLine`, also the
 *  fallback for anything else); list/churn/steady/record/newcomer each need their own reading
 *  or the line comes out bare (see src/postfeed.check.ts for the regression this guards). */
export function supportLine(post: Post): string {
  const f = post?.facts ?? {};
  const line = KIND_LINES[post?.kind as string] ?? genericLine;
  return [post?.name, ...line(f)].filter(Boolean).join(" · ");
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
