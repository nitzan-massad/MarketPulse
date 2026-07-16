import { useMemo, type ReactNode } from "react";
import { consClass, consLabel, fmtMc, fmtPx, scoreColor } from "../lib";
import stocksData from "../data/stocks.json";
import type { Stock } from "../types";
import type { Mark, MarkEntry } from "../watchlist";
import ThumbMark from "./ThumbMark";

const STOCKS = stocksData as Stock[];

const isStrongBuy = (r: Stock): boolean => (r.con || "").toLowerCase() === "strongbuy";

interface BestOfBestProps {
  onOpen: (s: Stock) => void;
  marks: Record<string, MarkEntry>;
  onMark: (t: string, v: Mark) => void;
}

function UpBar({ up }: { up: number | null }) {
  if (up == null) return <span className="dash">—</span>;
  const neg = up < 0;
  const c = scoreColor(up, 100) ?? undefined;
  const val = (up > 0 ? "+" : "") + up.toFixed(up >= 100 ? 0 : 1) + "%";
  return (
    <div className="bob-up">
      <span className="bob-upval" style={neg ? undefined : { color: c }}>
        {val}
      </span>
    </div>
  );
}

function Chip({ v, max }: { v: number | null; max: number }) {
  if (v == null) return <span className="dash">—</span>;
  const c = scoreColor(v, max)!;
  const text = v % 1 ? v : v | 0;
  return (
    <span className="chip" style={{ color: c, borderColor: c + "44", background: c + "14" }}>
      {text}
    </span>
  );
}

export function Card({
  s,
  onOpen,
  crown,
  badge,
  marks,
  onMark,
}: {
  s: Stock;
  onOpen: (s: Stock) => void;
  crown?: boolean;
  badge?: ReactNode;
  marks: Record<string, MarkEntry>;
  onMark: (t: string, v: Mark) => void;
}) {
  const mv = marks[s.t]?.v;
  return (
    // a div (not button) so the thumb buttons can nest inside; still fully clickable
    <div
      role="button"
      tabIndex={0}
      className={`bob-card ${crown ? "crown" : ""}`}
      onClick={() => onOpen(s)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(s);
        }
      }}
      aria-label={`Open ${s.t} — ${s.n} detail`}
    >
      <div className="bob-card-head">
        <div className="bob-ident">
          {crown && <span className="bob-star" aria-hidden="true">★</span>}
          <span className={`bob-tk ${mv === "up" ? "mk-up" : mv === "down" ? "mk-down" : ""}`}>{s.t}</span>
          {badge}
          <span className="bob-co">{s.n || ""}</span>
          <ThumbMark mark={marks[s.t]} onMark={(v) => onMark(s.t, v)} />
        </div>
        <span className="bob-sec">{s.sec ? consLabel(s.sec) : "—"}</span>
      </div>

      <div className="bob-metrics">
        <div className="bob-m">
          <span className="bob-k">Price</span>
          <span className="bob-v mono">{fmtPx(s.px)}</span>
        </div>
        <div className="bob-m">
          <span className="bob-k">Upside</span>
          <UpBar up={s.up} />
        </div>
        <div className="bob-m">
          <span className="bob-k">Consensus</span>
          <span className="bob-v">
            <span className={`pill ${consClass(s.con)}`}>{consLabel(s.con)}</span>
            <span className="bob-dist">
              {s.b}·{s.h}·{s.s}
            </span>
          </span>
        </div>
        <div className="bob-m">
          <span className="bob-k">Smart Score</span>
          <span className="bob-v">
            <Chip v={s.ss} max={10} />
          </span>
        </div>
        <div className="bob-m">
          <span className="bob-k">AI Score</span>
          <span className="bob-v">
            {s.ai == null ? (
              <span className="dash">—</span>
            ) : (
              <span className="bob-ai" style={{ color: scoreColor(s.ai, 100)! }}>
                {s.ai}
                {s.air ? <small>{s.air}</small> : null}
              </span>
            )}
          </span>
        </div>
        <div className="bob-m">
          <span className="bob-k">Mkt Cap</span>
          <span className="bob-v mono">{fmtMc(s.mc)}</span>
        </div>
      </div>
    </div>
  );
}

export default function BestOfBest({ onOpen, marks, onMark }: BestOfBestProps) {
  const { crown, alsoSs10, aiThreshold } = useMemo(() => {
    const ai = STOCKS.map((r) => r.ai)
      .filter((x): x is number => x != null)
      .sort((a, b) => a - b);
    const aiThreshold = ai[Math.ceil(0.9 * ai.length) - 1];

    const crown = STOCKS.filter(
      (r) => isStrongBuy(r) && r.ss === 10 && r.ai != null && r.ai >= aiThreshold,
    ).sort((a, b) => (b.ai! - a.ai!) || ((b.up ?? -Infinity) - (a.up ?? -Infinity)));

    const crownSet = new Set(crown.map((r) => r.t));
    const alsoSs10 = STOCKS.filter((r) => r.ss === 10 && !crownSet.has(r.t)).sort(
      (a, b) => (b.ai ?? -Infinity) - (a.ai ?? -Infinity),
    );

    return { crown, alsoSs10, aiThreshold };
  }, []);

  return (
    <div className="bob">
      <header className="bob-masthead">
        <h2 className="bob-title">
          Best of the <span className="em">Best</span>
        </h2>
        <p className="bob-dek">
          Strong Buy consensus · Smart Score 10 · AI Analyst in the top 10%
          <span className="bob-thr"> (AI ≥ {aiThreshold})</span>
        </p>
        <div className="bob-counts">
          <span>
            <b>{crown.length}</b> Triple Crown
          </span>
          <span className="dot">·</span>
          <span>
            <b>{alsoSs10.length}</b> more with a perfect Smart Score
          </span>
        </div>
      </header>

      <section className="bob-section crown-section">
        <div className="bob-sechdr">
          <h2>
            <span className="bob-star" aria-hidden="true">★</span> Triple Crown
          </h2>
          <p>Strong Buy · Smart Score 10 · AI Analyst top 10% — all three at once.</p>
        </div>
        {crown.length === 0 ? (
          <div className="bob-empty">No names currently clear all three bars.</div>
        ) : (
          <div className="bob-grid">
            {crown.map((s) => (
              <Card key={s.t} s={s} onOpen={onOpen} crown marks={marks} onMark={onMark} />
            ))}
          </div>
        )}
      </section>

      <section className="bob-section">
        <div className="bob-sechdr">
          <h2>Smart Score 10 — also strong</h2>
          <p>Perfect Smart Score, just below the AI Analyst top-10% cut.</p>
        </div>
        {alsoSs10.length === 0 ? (
          <div className="bob-empty">Nothing else at a perfect Smart Score.</div>
        ) : (
          <div className="bob-grid">
            {alsoSs10.map((s) => (
              <Card key={s.t} s={s} onOpen={onOpen} marks={marks} onMark={onMark} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
