import { useEffect, useId, useRef } from "react";
import data from "../data/feargreed.json";
import { panelTarget } from "../share";
import { useShare } from "../useShare";
import ShareBurst from "./ShareBurst";
import CloseButton from "./CloseButton";
import ShareButton, { ShareFail } from "./ShareButton";
import { ariaSummary, bandOf, extremes, needlePoint, shortDate, sparkPath, trend,
  type FearGreed } from "../feargreed";

const fg = data as FearGreed;

// Fixed numeric chart dimensions, never responsive: the panel is a fixed-width surface,
// and a chart that measures its container renders at 0x0 while that container is still
// hidden. Nothing here reads getBoundingClientRect.
const SPARK_W = 288;
const SPARK_H = 44;
/** Headroom above and below the plot for the dated peak and trough labels. */
const LABEL_H = 15;

/** The arc, shared by both sizes. `big` also draws the value beneath the pivot. */
function Dial({ score, big }: { score: number; big?: boolean }) {
  const band = bandOf(score);
  // geometry: centre (100,100) r 80 for the big dial, (46,46) r 34 for the header one
  const [cx, cy, r, tipR, tailR] = big ? [100, 100, 80, 66, -8] : [46, 46, 34, 27, -4];
  const [tx, ty] = needlePoint(score, cx, cy, tipR);
  const [bx, by] = needlePoint(score, cx, cy, tailR);
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
  const gid = big ? "fg-ramp-lg" : "fg-ramp-sm";
  return (
    <svg
      className={big ? "fg-dial lg" : "fg-dial sm"}
      viewBox={big ? "0 0 200 152" : "0 0 152 58"}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--fg-ef)" />
          <stop offset="27%" stopColor="var(--fg-fe)" />
          <stop offset="50%" stopColor="var(--fg-nu)" />
          <stop offset="73%" stopColor="var(--fg-gr)" />
          <stop offset="100%" stopColor="var(--fg-eg)" />
        </linearGradient>
      </defs>
      <path d={arc} fill="none" stroke="var(--panel-2)" strokeWidth={big ? 17 : 8} strokeLinecap="round" />
      <path d={arc} fill="none" stroke={`url(#${gid})`} strokeWidth={big ? 17 : 8} strokeLinecap="round" opacity=".92" />
      <line
        x1={bx.toFixed(1)} y1={by.toFixed(1)} x2={tx.toFixed(1)} y2={ty.toFixed(1)}
        stroke="var(--ink)" strokeWidth={big ? 3.5 : 2.2} strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r={big ? 7 : 4} fill="var(--ink)" />
      {big && <circle cx={cx} cy={cy} r={2.6} fill="var(--bg)" />}
      {big ? (
        <>
          {/* below the pivot, where the needle can never sweep across it */}
          <text x={cx} y={136} textAnchor="middle" className="fg-num" fontSize="31">{Math.round(score)}</text>
          <text x={cx} y={149} textAnchor="middle" className={`fg-band ${band.key}`} fontSize="10">
            {band.label.toUpperCase()}
          </text>
        </>
      ) : (
        <>
          <text x={90} y={40} className="fg-num" fontSize="23">{Math.round(score)}</text>
          <text x={90} y={52} className={`fg-band ${band.key}`} fontSize="8">{band.label.toUpperCase()}</text>
        </>
      )}
    </svg>
  );
}

interface Props {
  /** Controlled by App so a `#!feargreed` link can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function FearGreedGauge({ open, onOpenChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();
  // The panel is the shareable thing here, not a ticker — `#!feargreed` reopens it.
  const share = useShare(panelTarget("feargreed"), open);

  // Non-modal: focus moves into the panel, but is not trapped. Escape and outside-press
  // both close, and Escape returns focus to the trigger (the panel has no focusable
  // children of its own, so it takes tabIndex=-1 to have somewhere to fire from).
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onOpenChange(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const band = bandOf(fg.score);
  const t = trend(fg.score, fg.previous.week);
  const spark = sparkPath(fg.history, SPARK_W, SPARK_H);
  const ext = extremes(fg.history, 2, 6);
  /** Keep an edge label inside the box — a peak in week 1 sits hard against the left. */
  const labelX = (x: number) => Math.max(22, Math.min(SPARK_W - 22, x));

  return (
    <div className="fg-root" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="fg-trigger"
        aria-label={ariaSummary(fg)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => onOpenChange(!open)}
      >
        <Dial score={fg.score} />
      </button>

      {open && (
        <div
          className="fg-pop"
          id={panelId}
          data-burst={share.burst ?? undefined}
          ref={panelRef}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div className="fg-body">
          <div className="fg-head">
            <h2 className="fg-title" id={titleId}>Fear &amp; Greed Index</h2>
            <ShareButton what="the Fear &amp; Greed index" onShare={share.onShare} compact />
            <CloseButton
              what="the Fear &amp; Greed index"
              onClose={() => {
                onOpenChange(false);
                btnRef.current?.focus();
              }}
            />
          </div>
          {share.copyFailed && <ShareFail url={share.url} />}

          <Dial score={fg.score} big />

          <div className="fg-rule" />

          <div className="fg-sect">52-week trend</div>
          {spark && (
            <>
              {/* aria-hidden: the caption below is the text alternative, so a screen
                  reader hears the numbers once rather than twice. */}
              <svg
                className="fg-spark"
                viewBox={`-9 -${LABEL_H} ${SPARK_W + 30} ${SPARK_H + LABEL_H * 2}`}
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  {/* the fill is split at the 50 line so each half can take its own
                      colour — greed above, fear below */}
                  <clipPath id="fg-clip-up">
                    <rect x={-12} y={0} width={SPARK_W + 28} height={spark.mid} />
                  </clipPath>
                  <clipPath id="fg-clip-dn">
                    <rect x={-12} y={spark.mid} width={SPARK_W + 28} height={SPARK_H - spark.mid} />
                  </clipPath>
                </defs>

                {/* Anchored at 50, not at the floor: the area then means "how far from
                    neutral, and which way" instead of the empty space under an
                    arbitrary baseline. */}
                <path d={`${spark.d} L ${SPARK_W} ${spark.mid} L 0 ${spark.mid} Z`}
                      fill="var(--fg-gr)" opacity=".26" clipPath="url(#fg-clip-up)" />
                <path d={`${spark.d} L ${SPARK_W} ${spark.mid} L 0 ${spark.mid} Z`}
                      fill="var(--fg-fe)" opacity=".26" clipPath="url(#fg-clip-dn)" />

                {/* 52-week high and low, with the value in the right margin */}
                <line x1="0" y1={spark.hiY} x2={SPARK_W} y2={spark.hiY}
                      stroke="var(--fg-gr)" strokeWidth=".9" strokeDasharray="3 3" opacity=".7" />
                <line x1="0" y1={spark.loY} x2={SPARK_W} y2={spark.loY}
                      stroke="var(--fg-ef)" strokeWidth=".9" strokeDasharray="3 3" opacity=".7" />
                <text x={SPARK_W + 4} y={spark.hiY + 2.5} className="fg-ax hi">{Math.round(spark.hi)}</text>
                <text x={SPARK_W + 4} y={spark.loY + 2.5} className="fg-ax lo">{Math.round(spark.lo)}</text>

                <line x1="0" y1={spark.mid} x2={SPARK_W} y2={spark.mid} stroke="var(--faint)" strokeWidth="1" />

                <path d={spark.d} fill="none" stroke="var(--ink)" strokeWidth="1.6" strokeLinejoin="round" />

                {/* the year's two biggest peaks above the line, two deepest troughs
                    below it — the vertical split is what keeps them from colliding
                    when, as this year, a peak and a trough are six weeks apart */}
                {ext.peaks.map((i) => (
                  <g key={`p${i}`}>
                    <circle cx={spark.points[i].x} cy={spark.points[i].y} r="2.5"
                            fill="var(--fg-gr)" stroke="var(--bg)" strokeWidth="1.3" />
                    <text x={labelX(spark.points[i].x)} y={spark.points[i].y - 6} className="fg-pk hi">
                      {shortDate(fg.history[i].d)}
                    </text>
                  </g>
                ))}
                {ext.troughs.map((i) => (
                  <g key={`t${i}`}>
                    <circle cx={spark.points[i].x} cy={spark.points[i].y} r="2.5"
                            fill="var(--fg-ef)" stroke="var(--bg)" strokeWidth="1.3" />
                    <text x={labelX(spark.points[i].x)} y={spark.points[i].y + 12} className="fg-pk lo">
                      {shortDate(fg.history[i].d)}
                    </text>
                  </g>
                ))}

                <circle cx={spark.lastX} cy={spark.lastY} r="3.4"
                        fill={`var(--fg-${band.key})`} stroke="var(--bg)" strokeWidth="1.8" />
              </svg>

              {/* the caption is the text alternative, and carries the dates too so a
                  screen reader gets what the labels show */}
              <p className="fg-cap">
                High <b>{Math.round(spark.hi)}</b> on {shortDate(fg.history[ext.peaks[ext.peaks.length - 1]].d)}
                {" · "}low <b>{Math.round(spark.lo)}</b> on {shortDate(fg.history[ext.troughs[0]].d)}
                <br />
                now <b>{Math.round(fg.score)}</b>
                {t.dir !== "flat" && <> · {t.delta} {t.dir} on the week</>}
              </p>
            </>
          )}

          <div className="fg-rule" />

          <div className="fg-sect">What's driving it</div>
          <ul className="fg-comps">
            {fg.components.map((c) => {
              const cb = bandOf(c.score);
              return (
                <li key={c.key} className="fg-crow">
                  <span className="fg-cname">{c.label}</span>
                  <span className={`fg-cval ${cb.key}`}>{Math.round(c.score)}</span>
                  <span className={`fg-cband ${cb.key}`}>{cb.short}</span>
                  <span className="fg-cbar">
                    <i className={cb.key} style={{ width: `${Math.max(2, c.score)}%` }} />
                  </span>
                </li>
              );
            })}
          </ul>

          </div>

          {share.burst && <ShareBurst id={share.burst} onDone={share.onBurstDone} />}
        </div>
      )}
    </div>
  );
}
