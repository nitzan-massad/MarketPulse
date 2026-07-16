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
  /** modal: keep both thumbs visible. table/rows: hide the unpicked one (but
   *  still reserve its space) once a choice is made. */
  both?: boolean;
}

// Thumbs-up/down "read & liked it" control. Both thumb slots and a date line are
// ALWAYS rendered (the unpicked thumb is only made invisible in row mode, never
// removed), so pressing colours + dates in place without any layout jump.
export default function ThumbMark({ mark, onMark, both }: Props) {
  const v = mark?.v;
  const col = (which: Mark, icon: React.ReactNode) => {
    const hidden = !both && !!v && v !== which; // row: reserve space but hide the other
    return (
      <span className={`tmk-c ${hidden ? "tmk-hidden" : ""}`}>
        <button
          type="button"
          className={`tmk-b ${which} ${v === which ? "on" : ""}`}
          aria-label={which === "up" ? "Read it — liked" : "Read it — disliked"}
          aria-pressed={v === which}
          onClick={() => onMark(which)}
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
    </span>
  );
}
