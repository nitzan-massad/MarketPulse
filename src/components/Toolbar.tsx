import { consLabel } from "../lib";
import MultiSelect from "./MultiSelect";
import type { MarkFilter } from "../App";

interface ToolbarProps {
  sectors: string[];
  sectorOptions: string[];
  sectorNot: boolean;
  consensuses: string[];
  consensusOptions: string[];
  cap: number;
  count: number;
  activeCount: number;
  canReset: boolean;
  onReset: () => void;
  onSectors: (v: string[]) => void;
  onSectorNot: (v: boolean) => void;
  onConsensuses: (v: string[]) => void;
  onCap: (v: number) => void;
  markFilter: MarkFilter;
  onMarkFilter: (v: MarkFilter) => void;
  showMarkFilter: boolean;
}

const MARK_OPTS: { v: MarkFilter; label: string }[] = [
  { v: "all", label: "All" },
  { v: "up", label: "👍 Liked" },
  { v: "down", label: "👎 Disliked" },
  { v: "reviewed", label: "Reviewed" },
  { v: "unseen", label: "Not seen" },
];

const CAPS = [
  { c: 0, label: "All" },
  { c: 300, label: "$300M" },
  { c: 2000, label: "$2B" },
  { c: 10000, label: "$10B" },
];

export default function Toolbar({
  sectors, sectorOptions, sectorNot, consensuses, consensusOptions, cap, count, activeCount, canReset,
  onReset, onSectors, onSectorNot, onConsensuses, onCap,
  markFilter, onMarkFilter, showMarkFilter,
}: ToolbarProps) {
  return (
    <details className="filters">
      <summary>
        <span className="filters-title">Filters</span>
        {activeCount > 0 && (
          <span className="filters-badge" title={`${activeCount} active filter${activeCount > 1 ? "s" : ""}`}>
            {activeCount}
          </span>
        )}
        <span className="count"><b id="cnt">{count}</b> matches</span>
        {canReset && (
          <button
            type="button"
            className="filter-reset"
            title="Reset all filters"
            // don't let the click toggle the <details> open/closed
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onReset();
            }}
          >
            ↺ Reset
          </button>
        )}
      </summary>
      <div className="toolbar">
        <div className="mode" role="group" aria-label="Sector match mode">
          <button
            type="button"
            className={sectorNot ? "" : "inc"}
            disabled={sectors.length === 0}
            onClick={() => onSectorNot(false)}
          >
            Only
          </button>
          <button
            type="button"
            className={sectorNot ? "exc" : ""}
            disabled={sectors.length === 0}
            onClick={() => onSectorNot(true)}
          >
            Not
          </button>
        </div>

        <MultiSelect
          id="sector"
          placeholder="All sectors"
          options={sectorOptions}
          selected={sectors}
          onChange={onSectors}
          noun="sectors"
        />
        <MultiSelect
          id="consensus"
          placeholder="All ratings"
          options={consensusOptions}
          selected={consensuses}
          onChange={onConsensuses}
          label={consLabel}
          noun="ratings"
        />

        <span className="lbl">Min cap</span>
        <div className="seg" id="cap">
          {CAPS.map((b) => (
            <button
              key={b.c}
              data-c={b.c}
              className={cap === b.c ? "on" : ""}
              onClick={() => onCap(b.c)}
            >
              {b.label}
            </button>
          ))}
        </div>

        {showMarkFilter && (
          <>
            <span className="lbl">My marks</span>
            <div className="seg" id="marks">
              {MARK_OPTS.map((o) => (
                <button
                  key={o.v}
                  className={markFilter === o.v ? "on" : ""}
                  onClick={() => onMarkFilter(o.v)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
