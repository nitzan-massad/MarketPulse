interface ToolbarProps {
  q: string;
  sector: string;
  sectorNot: boolean;
  consensus: string;
  cap: number;
  sectors: string[];
  count: number;
  onQ: (v: string) => void;
  onSector: (v: string) => void;
  onSectorNot: (v: boolean) => void;
  onConsensus: (v: string) => void;
  onCap: (v: number) => void;
}

const CAPS = [
  { c: 0, label: "All" },
  { c: 300, label: "$300M" },
  { c: 2000, label: "$2B" },
  { c: 10000, label: "$10B" },
];

export default function Toolbar({
  q, sector, sectorNot, consensus, cap, sectors, count,
  onQ, onSector, onSectorNot, onConsensus, onCap,
}: ToolbarProps) {
  return (
    <details className="filters">
      <summary>
        <span className="filters-title">Filters</span>
        <span className="count"><b id="cnt">{count}</b> matches</span>
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
          disabled={!sector}
          onClick={() => onSectorNot(false)}
        >
          Only
        </button>
        <button
          type="button"
          className={sectorNot ? "exc" : ""}
          disabled={!sector}
          onClick={() => onSectorNot(true)}
        >
          Not
        </button>
      </div>
      <select id="sector" value={sector} onChange={(e) => onSector(e.target.value)}>
        <option value="">All sectors</option>
        {sectors.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <select id="consensus" value={consensus} onChange={(e) => onConsensus(e.target.value)}>
        <option value="">All ratings</option>
        <option value="StrongBuy">Strong Buy only</option>
        <option value="buyplus">Buy &amp; up</option>
        <option value="Hold">Hold</option>
        <option value="sellany">Sell / Strong Sell</option>
      </select>
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
