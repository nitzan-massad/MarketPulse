import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import type { BurstId } from "../share";

// The copy-confirmation animation. One of twenty, picked in StockModal.
//
// Division of labour: this component only builds the ELEMENTS a burst needs (particles,
// letters, rings) with their per-element CSS variables; every timing, colour and transform
// lives in index.css under `.mkm-modal[data-burst="<id>"]`. The modal sets that attribute,
// so a burst can also animate the share button itself (band, flip, hole) without this
// component knowing where the button is.
//
// Horizontal scatter is expressed in PERCENT, not px: the same burst plays over a 660px
// desktop modal and a ~344px phone modal, and px offsets tuned for one leave the other
// either clipped or bunched in the middle.

interface Spec {
  /** How long to keep the layer mounted, ms. Must cover the slowest child animation. */
  ms: number;
  /** The word this burst prints. Most bursts spell it out some other way and leave the
   *  span hidden (index.css only reveals it for the ones that use it) — but it is always
   *  RENDERED, because under prefers-reduced-motion it is the only confirmation left. */
  msg?: string;
  build?: () => ReactNode;
}

// CSS custom properties aren't in CSSProperties; this keeps the call sites honest without
// an `any` per particle.
type Vars = CSSProperties & Record<`--${string}`, string | number>;

const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const pc = (n: number): string => n.toFixed(2) + "%";
const px = (n: number): string => n.toFixed(1) + "px";
/** n elements, each handed its index. */
const many = (n: number, f: (i: number) => ReactNode): ReactNode[] => Array.from({ length: n }, (_, i) => f(i));

// The modal's own palette (src/index.css --t-*), inlined because these land on CSS vars.
const NAVY = "#1b3f73";
const NAVY2 = "#2a5695";
const TEAL = "#147c86";
const GREEN = "#17864f";
const RED = "#c73a2b";
const AMBER = "#b8860b";
const PARTY = [NAVY, NAVY2, TEAL, GREEN, AMBER, RED];

const PLANE = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M2 12l20-9-9 20-2.4-7.6z" />
  </svg>
);
const TICK = (
  <svg className="bf-tick" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 13l5.5 5.5L20 7" />
  </svg>
);

const SPECS: Record<BurstId, Spec> = {
  // 01 — radial burst of paper, gravity on the way down
  confetti: {
    ms: 1500,
    build: () =>
      many(64, (i) => {
        const a = rnd(-Math.PI, 0);
        const d = rnd(90, 280);
        return (
          <i
            key={i}
            className="bf-p bf-conf"
            style={{
              "--x": px(Math.cos(a) * d),
              "--y": px(Math.sin(a) * d + rnd(120, 300)),
              "--r": rnd(-720, 720) + "deg",
              "--c": PARTY[i % PARTY.length],
              "--dur": rnd(0.9, 1.35) + "s",
              "--dl": rnd(0, 0.16) + "s",
            } as Vars}
          />
        );
      }),
  },
  // 02 — three rings out of the middle, the button rattles
  shock: { ms: 1200, build: () => many(3, (i) => <i key={i} className="bf-ring" style={{ "--dl": i * 0.14 + "s" } as Vars} />) },
  // 03 — a trading-floor tape unrolls across the modal
  tape: {
    ms: 1900,
    build: () => (
      <div className="bf-tape">
        <span>LINK COPIED&nbsp;·&nbsp;LINK COPIED&nbsp;·&nbsp;LINK COPIED&nbsp;·&nbsp;LINK COPIED&nbsp;·&nbsp;LINK COPIED</span>
      </div>
    ),
  },
  // 04 — the letters fly in from off-screen and land
  slam: {
    ms: 1500,
    build: () => {
      const w = "COPIED";
      const step = 46;
      const off = -((w.length - 1) * step) / 2;
      return [...w].map((ch, i) => {
        const a = rnd(0, Math.PI * 2);
        return (
          <i
            key={i}
            className="bf-l"
            style={{
              "--fx": px(Math.cos(a) * 460),
              "--fy": px(Math.sin(a) * 340),
              "--fr": rnd(-110, 110) + "deg",
              "--tx": px(off + i * step),
              "--dl": i * 0.055 + "s",
            } as Vars}
          >
            {ch}
          </i>
        );
      });
    },
  },
  // 05 — folded and thrown
  plane: { ms: 1500, build: () => <><i className="bf-trail" /><i className="bf-plane">{PLANE}</i></> },
  // 06 — the button gets eaten, then spat back out
  hole: { ms: 1700, msg: "COPIED", build: () => <i className="bf-hole" /> },
  // 07 — a blob swallows the middle and resolves into a tick
  liquid: { ms: 1700, build: () => <><i className="bf-blob" />{TICK}</> },
  // 08 — RGB split + scanlines
  glitch: {
    ms: 1200,
    build: () => (
      <>
        <i className="bf-g bf-gr">COPIED</i>
        <i className="bf-g bf-gc">COPIED</i>
        <i className="bf-g bf-gk">COPIED</i>
        <i className="bf-scan" />
      </>
    ),
  },
  // 09 — rocket up, two-stage burst
  fire: {
    ms: 1700,
    build: () => (
      <>
        <i className="bf-rocket" />
        <i className="bf-flash" />
        {many(44, (i) => {
          const a = (i / 44) * Math.PI * 2;
          const d = rnd(110, 260);
          return (
            <i
              key={i}
              className="bf-p bf-spark"
              style={{
                "--x": px(Math.cos(a) * d),
                "--y": px(Math.sin(a) * d + 90),
                "--r": "0deg",
                "--c": PARTY[i % PARTY.length],
                "--dur": rnd(0.7, 1) + "s",
                "--dl": "0.44s",
              } as Vars}
            />
          );
        })}
      </>
    ),
  },
  // 10 — it's a stock app
  money: {
    ms: 1800,
    msg: "COPIED",
    build: () =>
      many(34, (i) => (
        <i
          key={i}
          className="bf-fall"
          style={{
            "--x": pc(rnd(2, 96)),
            "--r": rnd(-320, 320) + "deg",
            "--sz": Math.round(rnd(16, 42)) + "px",
            "--c": i % 3 ? GREEN : NAVY,
            "--dur": rnd(1, 1.45) + "s",
            "--dl": rnd(0, 0.55) + "s",
          } as Vars}
        >
          {i % 5 === 0 ? "¢" : "$"}
        </i>
      )),
  },
  // 11 — sonar sweep
  radar: { ms: 1400, build: () => <><i className="bf-sweep" />{many(3, (i) => <i key={i} className="bf-ring bf-teal" style={{ "--dl": i * 0.18 + "s" } as Vars} />)}</> },
  // 12 — green candles print off the bottom edge
  candle: {
    ms: 1500,
    msg: "COPIED",
    build: () => (
      <>
        {many(17, (i) => (
          <i
            key={i}
            className="bf-candle"
            style={{ left: pc(3 + i * 5.6), height: px(rnd(40, 150)), "--dl": i * 0.04 + "s" } as Vars}
          >
            <b />
          </i>
        ))}
        <i className="bf-tag">+100.00%</i>
      </>
    ),
  },
  // 13 — digits fall and resolve into the word
  matrix: {
    ms: 1600,
    msg: "COPIED",
    build: () =>
      many(24, (i) => (
        <i key={i} className="bf-col" style={{ left: pc(1 + i * 4.1), "--dl": rnd(0, 0.4) + "s" } as Vars}>
          {Array.from({ length: 14 }, () => "01234567890$"[Math.floor(rnd(0, 12))]).join("")}
        </i>
      )),
  },
  // 14 — the button itself stretches and snaps
  band: {
    ms: 1400,
    msg: "copied",
    build: () =>
      many(18, (i) => {
        const a = rnd(-Math.PI, Math.PI);
        const d = rnd(60, 150);
        return (
          <i
            key={i}
            className="bf-p bf-tick-dot"
            style={{
              "--x": px(Math.cos(a) * d),
              "--y": px(Math.sin(a) * d),
              "--r": "0deg",
              "--dur": rnd(0.45, 0.7) + "s",
              "--dl": rnd(0.22, 0.4) + "s",
            } as Vars}
          />
        );
      }),
  },
  // 15 — a card flips to its other side
  flip: {
    ms: 1400,
    build: () => (
      <i className="bf-flipper">
        <b className="bf-face bf-front">SHARE</b>
        <b className="bf-face bf-back">COPIED ✓</b>
      </i>
    ),
  },
  // 16 — typed out, with a caret
  type: { ms: 1600, build: () => <i className="bf-tw">copied to clipboard</i> },
  // 17 — rotating rays and a white core
  nova: { ms: 1600, msg: "COPIED", build: () => <><i className="bf-rays" /><i className="bf-core" /></> },
  // 18 — bubbles up and out of the top
  bubble: {
    ms: 1900,
    msg: "COPIED",
    build: () =>
      many(26, (i) => (
        <i
          key={i}
          className="bf-bub"
          style={{
            "--x": pc(rnd(2, 96)),
            "--dx": px(rnd(-40, 40)),
            "--sz": px(rnd(12, 44)),
            "--dur": rnd(1.1, 1.6) + "s",
            "--dl": rnd(0, 0.5) + "s",
          } as Vars}
        />
      )),
  },
  // 19 — two links snap together
  chain: { ms: 1500, msg: "LINKED", build: () => <><i className="bf-lk bf-lkl" /><i className="bf-lk bf-lkr" /><i className="bf-gleam" /></> },
  // 20 — it's a bull market somewhere
  bull: {
    ms: 1700,
    msg: "COPIED",
    build: () => (
      <>
        <i className="bf-bull">🐂</i>
        {many(24, (i) => (
          <i key={i} className="bf-dust" style={{ "--x": pc(rnd(2, 96)), "--sz": px(rnd(8, 26)), "--dl": rnd(0.1, 0.8) + "s" } as Vars} />
        ))}
      </>
    ),
  },
};

/** How long the modal should keep `data-burst` set for this animation. */
export const burstMs = (id: BurstId): number => SPECS[id].ms;

interface ShareBurstProps {
  id: BurstId;
  /** Called once the animation is over so the parent can unmount the layer. */
  onDone: () => void;
}

export default function ShareBurst({ id, onDone }: ShareBurstProps) {
  const spec = SPECS[id];
  // Particle positions are random, so they must be generated ONCE per burst — regenerating
  // them on a re-render (a live quote tick mid-animation) would teleport every particle.
  const kids = useMemo(() => spec.build?.(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const t = setTimeout(onDone, spec.ms);
    return () => clearTimeout(t);
    // onDone is a stable useCallback in the parent; re-arming on every render would
    // restart the timer forever and the layer would never unmount.
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="mkm-burst" aria-hidden="true">
        {kids}
        <span className="bf-msg">{spec.msg ?? "COPIED"}</span>
      </div>
      {/* The animation is decorative; this is what a screen reader actually gets. */}
      <span className="mkm-sr" role="status">
        Link copied to clipboard
      </span>
    </>
  );
}
