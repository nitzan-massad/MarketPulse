import { useMemo, useState } from "react";
import Masthead from "./components/Masthead";
import StockTable from "./components/StockTable";
import Toolbar from "./components/Toolbar";
import stocksData from "./data/stocks.json";
import { passes, sortRows, VIEWS } from "./lib";
import type { Stock, ViewId } from "./types";

const STOCKS = stocksData as Stock[];

export default function App() {
  const [view, setView] = useState<ViewId>("analyst");
  const [sort, setSort] = useState<keyof Stock>("up");
  const [dir, setDir] = useState<number>(-1);
  const [q, setQ] = useState("");
  const [sector, setSector] = useState("");
  // analyst tab defaults to Strong Buy to match the real page
  const [consensus, setConsensus] = useState("StrongBuy");
  const [cap, setCap] = useState(0);

  const sectors = useMemo(
    () => [...new Set(STOCKS.map((s) => s.sec).filter(Boolean))].sort(),
    [],
  );

  const rows = useMemo(() => {
    const filtered = STOCKS.filter((s) => passes(s, { q, sector, consensus, cap }));
    return sortRows(filtered, sort, dir);
  }, [q, sector, consensus, cap, sort, dir]);

  function selectView(id: ViewId) {
    const v = VIEWS[id];
    setView(id);
    setSort(v.sort);
    setDir(v.dir);
    setConsensus(id === "analyst" ? "StrongBuy" : "");
  }

  function handleSort(k: string) {
    if (sort === k) {
      setDir((d) => d * -1);
    } else {
      setSort(k as keyof Stock);
      setDir(k === "sec" || k === "con" ? 1 : -1);
    }
  }

  return (
    <div className="wrap">
      <Masthead view={view} poolN={STOCKS.length} />

      <div className="tabs" id="tabs">
        {(Object.entries(VIEWS) as [ViewId, (typeof VIEWS)[ViewId]][]).map(([id, v]) => (
          <button
            key={id}
            className={`tab ${id === view ? "on" : ""}`}
            data-v={id}
            onClick={() => selectView(id)}
          >
            <span>{v.tab}</span>
            <small>{v.sub}</small>
          </button>
        ))}
      </div>

      <Toolbar
        q={q}
        sector={sector}
        consensus={consensus}
        cap={cap}
        sectors={sectors}
        count={rows.length}
        onQ={setQ}
        onSector={setSector}
        onConsensus={setConsensus}
        onCap={setCap}
      />

      <StockTable rows={rows} sort={sort} dir={dir} hl={VIEWS[view].hl} onSort={handleSort} />

      <footer>
        Data pulled from TipRanks' public screener API (<code>/api/apps/stock/screener</code>) — the
        same feed that powers the paywalled tables. Upside = top-analyst average price target vs.
        last close. Smart Score is TipRanks' 1–10 quant rank; AI score is their AI Analyst model
        (0–100). <br />
        Snapshot is point-in-time and <b>not investment advice</b>. Many extreme-upside names are
        sub-$500M micro-caps — high upside, high risk. Use the Min-cap filter for liquid names.
      </footer>
    </div>
  );
}
