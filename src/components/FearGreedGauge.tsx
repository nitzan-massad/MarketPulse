import { useEffect, useId, useRef, useState } from "react";
import data from "../data/feargreed.json";
import { ariaSummary, bandOf, needlePoint, sparkPath, trend, type FearGreed } from "../feargreed";

const fg = data as FearGreed;

// Fixed numeric chart dimensions, never responsive: the panel is a fixed-width surface,
// and a chart that measures its container renders at 0x0 while that container is still
// hidden. Nothing here reads getBoundingClientRect.
const SPARK_W = 288;
const SPARK_H = 44;

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

export default function FearGreedGauge() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  // Non-modal: focus moves into the panel, but is not trapped. Escape and outside-press
  // both close, and Escape returns focus to the trigger (the panel has no focusable
  // children of its own, so it takes tabIndex=-1 to have somewhere to fire from).
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const band = bandOf(fg.score);
  const t = trend(fg.score, fg.previous.week);
  const spark = sparkPath(fg.history, SPARK_W, SPARK_H);

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
        onClick={() => setOpen((o) => !o)}
      >
        <Dial score={fg.score} />
      </button>

      {open && (
        <div
          className="fg-pop"
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <h2 className="fg-title" id={titleId}>Fear &amp; Greed Index</h2>

          <Dial score={fg.score} big />

          <div className="fg-rule" />

          <div className="fg-sect">52-week trend</div>
          {spark && (
            <>
              {/* aria-hidden: the caption below is the text alternative, so a screen
                  reader hears the numbers once rather than twice. */}
              <svg
                className="fg-spark"
                viewBox={`-2 -4 ${SPARK_W + 6} ${SPARK_H + 10}`}
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  <linearGradient id="fg-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={`var(--fg-${band.key})`} stopOpacity=".26" />
                    <stop offset="100%" stopColor={`var(--fg-${band.key})`} stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={`${spark.d} L ${SPARK_W} ${SPARK_H} L 0 ${SPARK_H} Z`} fill="url(#fg-fill)" />
                <path d={spark.d} fill="none" stroke={`var(--fg-${band.key})`} strokeWidth="1.8" strokeLinejoin="round" />
                <circle cx={spark.lastX} cy={spark.lastY} r="3.2" fill={`var(--fg-${band.key})`} stroke="var(--bg)" strokeWidth="1.6" />
              </svg>
              {/* the caption is the axis — micro-charts carry no axis of their own */}
              <p className="fg-cap">
                52 weeks · low {Math.round(spark.min)} · high {Math.round(spark.max)} · now{" "}
                <b>{Math.round(fg.score)}</b>
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

          <p className="fg-src">CNN Business · {fg.asOf.slice(0, 10)}</p>
        </div>
      )}
    </div>
  );
}
