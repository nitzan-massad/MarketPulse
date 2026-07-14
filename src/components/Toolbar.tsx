import { consLabel } from "../lib";
import MultiSelect from "./MultiSelect";

interface ToolbarProps {
  q: string;
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
  onQ: (v: string) => void;
  onSectors: (v: string[]) => void;
  onSectorNot: (v: boolean) => void;
  onConsensuses: (v: string[]) => void;
  onCap: (v: number) => void;
}

const CAPS = [
  { c: 0, label: "All" },
  { c: 300, label: "$300M" },
  { c: 2000, label: "$2B" },
  { c: 10000, label: "$10B" },
];

export default function Toolbar({
  q, sectors, sectorOptions, sectorNot, consensuses, consensusOptions, cap, count, activeCount, canReset,
  onReset, onQ, onSectors, onSectorNot, onConsensuses, onCap,
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
        <label className="field">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            className="search"
            id="q"
            placeholder="Search ticker or company…"
            autoComplete="off"
            value={q}
            onChange={(e) => onQ(e.target.value)}
          />
          {q && (
            <button type="button" className="clear" aria-label="Clear search" onClick={() => onQ("")}>
              ×
            </button>
          )}
        </label>

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
      </div>
    </details>
  );
}
