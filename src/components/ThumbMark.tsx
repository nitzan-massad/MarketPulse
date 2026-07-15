import type { Mark, MarkEntry } from "../watchlist";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function fmtMarkDate(ms: number): string {
  const d = new Date(ms);
  return `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
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

interface Props {
  mark?: MarkEntry;
  onMark: (v: Mark) => void;
  /** modal: always show both thumbs. table: only the chosen thumb once set. */
  both?: boolean;
}

// Thumbs-up/down "read & liked it" control. Row variant hides the unpicked
// thumb once a choice is made; modal variant always shows both. The chosen one
// is coloured with the date under it. Clicks never bubble to the row.
export default function ThumbMark({ mark, onMark, both }: Props) {
  const v = mark?.v;
  const showUp = both || !v || v === "up";
  const showDown = both || !v || v === "down";
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <span className={`tmk ${v ? "set" : ""} ${both ? "both" : ""}`} onClick={stop}>
      {showUp && (
        <span className="tmk-c">
          <button
            type="button"
            className={`tmk-b up ${v === "up" ? "on" : ""}`}
            aria-label="Read it — liked"
            aria-pressed={v === "up"}
            onClick={() => onMark("up")}
          >
            {UP}
          </button>
          {v === "up" && <i className="tmk-d up">{fmtMarkDate(mark!.d)}</i>}
        </span>
      )}
      {showDown && (
        <span className="tmk-c">
          <button
            type="button"
            className={`tmk-b down ${v === "down" ? "on" : ""}`}
            aria-label="Read it — disliked"
            aria-pressed={v === "down"}
            onClick={() => onMark("down")}
          >
            {DOWN}
          </button>
          {v === "down" && <i className="tmk-d down">{fmtMarkDate(mark!.d)}</i>}
        </span>
      )}
    </span>
  );
}
