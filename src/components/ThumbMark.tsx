import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Mark, MarkEntry } from "../watchlist";
import { DATE_LOCALE } from "../lib";

export function fmtMarkDate(ms: number): string {
  return new Date(ms).toLocaleDateString(DATE_LOCALE, { year: "numeric", month: "numeric", day: "numeric" });
}

const UP = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
  </svg>
);
const DOWN = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h2.67A2 2 0 0 1 22 4v7a2 2 0 0 1-2 2h-3" />
  </svg>
);

// filled thumb used by the flying press animation (coloured by direction via CSS)
const FILL_THUMB = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M2 21h4V9H2v12zM23 10c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.6 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
  </svg>
);

// ---- the 20 press animations. On each press a random one plays (no immediate
// repeat), fired from the pressed thumb and coloured by direction. ----
type Kind =
  | "thumb" | "thumb-ring" | "thumb-ring2" | "thumb-glow"
  | "burst" | "rocket" | "rain" | "mega" | "hello" | "grip" | "sparkle";
interface Anim {
  cls: string;
  kind: Kind;
  spread?: "cone" | "radial";
  frames?: [string, string]; // intermediate hand poses (final thumb is direction-based)
}
const ANIMS: Anim[] = [
  { cls: "a-spin", kind: "thumb-ring" },
  { cls: "a-coin", kind: "thumb" },
  { cls: "a-backflip", kind: "thumb" },
  { cls: "a-barrel", kind: "thumb" },
  { cls: "a-hello", kind: "hello", frames: ["✋", "👋"] },
  { cls: "a-grip", kind: "grip", frames: ["✊", "🖐️"] },
  { cls: "a-confetti", kind: "burst", spread: "cone" },
  { cls: "a-firework", kind: "burst", spread: "radial" },
  { cls: "a-jelly", kind: "thumb-glow" },
  { cls: "a-rocket", kind: "rocket" },
  { cls: "a-stamp", kind: "thumb-ring" },
  { cls: "a-tumble", kind: "thumb" },
  { cls: "a-ripple", kind: "thumb-ring2" },
  { cls: "a-orbit", kind: "thumb" },
  { cls: "a-glitch", kind: "thumb" },
  { cls: "a-rain", kind: "rain" },
  { cls: "a-heart", kind: "thumb-glow" },
  { cls: "a-sparkle", kind: "sparkle", frames: ["", "👋"] },
  { cls: "a-boom", kind: "thumb" },
  { cls: "a-mega", kind: "mega", spread: "radial" },
];
let lastAnim = -1; // module-level: no immediate repeat, even across different thumbs

const cssv = (o: Record<string, string>) => o as unknown as React.CSSProperties;

function particles(spread: "cone" | "radial") {
  return Array.from({ length: 12 }, (_, i) => {
    const ang = spread === "cone" ? -140 + (i / 11) * 100 : (i / 12) * 360;
    const r = 46 + (i % 3) * 8;
    const rad = (ang * Math.PI) / 180;
    return <span key={"p" + i} className="tf-p" style={cssv({ "--dx": Math.round(Math.cos(rad) * r) + "px", "--dy": Math.round(Math.sin(rad) * r) + "px" })} />;
  });
}
function sparkles() {
  const pos: [number, number][] = [[-30, -24], [28, -26], [-34, 10], [32, 8], [0, -38], [6, 26]];
  return pos.map((p, i) => (
    <span key={"s" + i} className="tf-sp" style={cssv({ "--dx": p[0] + "px", "--dy": p[1] + "px" })}>✨</span>
  ));
}
function rain(dir: Mark) {
  return Array.from({ length: 9 }, (_, i) => {
    const dx = Math.round(-40 + (i / 8) * 80);
    const dy = -30 - (i % 3) * 22;
    const rot = -40 + i * 11 + "deg";
    return <span key={"r" + i} className="tf-rp" style={cssv({ "--dx": dx + "px", "--dy": dy + "px", "--rot": rot })}>{dir === "up" ? "👍" : "👎"}</span>;
  });
}
function layers(a: Anim, dir: Mark) {
  const big = <span key="big" className="tf-big">{FILL_THUMB}</span>;
  const end = dir === "up" ? "👍" : "👎";
  switch (a.kind) {
    case "thumb": return [big];
    case "thumb-ring": return [big, <span key="r" className="tf-ring" />];
    case "thumb-ring2": return [big, <span key="r" className="tf-ring" />, <span key="r2" className="tf-ring2" />];
    case "thumb-glow": return [big, <span key="g" className="tf-glow" />];
    case "burst": return [big, <span key="g" className="tf-glow" />, ...particles(a.spread!)];
    case "rocket": return [big, <span key="r" className="tf-ring" />];
    case "rain": return [big, ...rain(dir)];
    case "mega": return [<span key="f" className="tf-flash" />, big, <span key="r" className="tf-ring" />, <span key="r2" className="tf-ring2" />, ...particles(a.spread!)];
    case "hello": return [
      <span key="h" className="tf-halo" />,
      <span key="f1" className="tf-frame tf-f1">{a.frames![0]}</span>,
      <span key="f2" className="tf-frame tf-f2">{a.frames![1]}</span>,
      <span key="f3" className="tf-frame tf-f3">{end}</span>,
    ];
    case "grip": return [
      <span key="f1" className="tf-frame tf-f1">{a.frames![0]}</span>,
      <span key="f2" className="tf-frame tf-f2">{a.frames![1]}</span>,
      <span key="f3" className="tf-frame tf-f3">{end}</span>,
    ];
    case "sparkle": return [
      <span key="f2" className="tf-frame tf-f2">{a.frames![1]}</span>,
      <span key="f3" className="tf-frame tf-f3">{end}</span>,
      ...sparkles(),
    ];
  }
}

interface Props {
  mark?: MarkEntry;
  onMark: (v: Mark) => void;
  /** modal: keep both thumbs visible. table/rows: hide the unpicked one (but
   *  still reserve its space) once a choice is made. */
  both?: boolean;
}

interface Burst { x: number; y: number; dir: Mark; anim: number; k: number }

// Thumbs-up/down "read & liked it" control. Both thumb slots and a date line are
// ALWAYS rendered (the unpicked thumb is only made invisible in row mode, never
// removed), so pressing colours + dates in place without any layout jump.
export default function ThumbMark({ mark, onMark, both }: Props) {
  const v = mark?.v;
  const [burst, setBurst] = useState<Burst | null>(null);
  const kRef = useRef(0);

  // clear the overlay after the longest animation (~1.2s) finishes
  useEffect(() => {
    if (!burst) return;
    const t = setTimeout(() => setBurst(null), 1300);
    return () => clearTimeout(t);
  }, [burst?.k]);

  function press(which: Mark, e: React.MouseEvent<HTMLButtonElement>) {
    // pressing the already-picked thumb clears the colour — no animation for that
    const setting = v !== which;
    onMark(which);
    if (!setting) return;
    const r = e.currentTarget.getBoundingClientRect();
    let n = Math.floor(Math.random() * ANIMS.length);
    if (n === lastAnim) n = (n + 1) % ANIMS.length; // never the same one twice in a row
    lastAnim = n;
    kRef.current += 1;
    setBurst({ x: r.left + r.width / 2, y: r.top + r.height / 2, dir: which, anim: n, k: kRef.current });
  }

  const col = (which: Mark, icon: React.ReactNode) => {
    const hidden = !both && !!v && v !== which; // row: reserve space but hide the other
    return (
      <span className={`tmk-c ${hidden ? "tmk-hidden" : ""}`}>
        <button
          type="button"
          className={`tmk-b ${which} ${v === which ? "on" : ""}`}
          aria-label={which === "up" ? "Read it — liked" : "Read it — disliked"}
          aria-pressed={v === which}
          onClick={(e) => press(which, e)}
        >
          {icon}
        </button>
        <i className={`tmk-d ${which}`}>{v === which && mark ? fmtMarkDate(mark.d) : ""}</i>
      </span>
    );
  };
  return (
    <span className={`tmk ${v ? "set" : ""} ${both ? "both" : ""}`} onClick={(e) => e.stopPropagation()}>
      {col("up", UP)}
      {col("down", DOWN)}
      {burst &&
        createPortal(
          <div
            key={burst.k}
            className={`tf-layer play ${ANIMS[burst.anim].cls} ${burst.dir}`}
            style={{ left: burst.x, top: burst.y }}
            aria-hidden="true"
          >
            {layers(ANIMS[burst.anim], burst.dir)}
          </div>,
          document.body,
        )}
    </span>
  );
}
