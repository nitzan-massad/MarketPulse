import meta from "../data/meta.json";
import { VIEWS } from "../lib";
import type { ViewId } from "../types";

interface MastheadProps {
  view: ViewId;
  poolN: number;
}

const SNAPSHOT = new Date(meta.generatedAt).toLocaleString("en-US", {
  month: "short", day: "numeric", year: "numeric",
  hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
});

export default function Masthead({ view, poolN }: MastheadProps) {
  const v = VIEWS[view];
  return (
    <>
      <div className="kicker">
        TipRanks <span className="dot">/</span> Unlocked View <span className="dot">/</span> No Paywall
      </div>
      <div className="masthead">
        <h1 id="title" dangerouslySetInnerHTML={{ __html: v.title }} />
        <div className="dek" id="dek">{v.dek}</div>
      </div>
      <div className="rule"></div>
      <div className="metaline">
        <span>Universe <b>{meta.universe.toLocaleString()}</b> US stocks</span>
        <span>Showing <b id="poolN">{poolN}</b> ranked names</span>
        <span>Source <b>top-analyst price targets</b></span>
        <span className="live">Snapshot · {SNAPSHOT}</span>
      </div>
    </>
  );
}
