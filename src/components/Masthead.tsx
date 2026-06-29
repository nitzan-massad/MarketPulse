import { VIEWS } from "../lib";
import type { ViewId } from "../types";

interface MastheadProps {
  view: ViewId;
  poolN: number;
}

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
        <span>Universe <b>5,351</b> US stocks</span>
        <span>Showing <b id="poolN">{poolN}</b> ranked names</span>
        <span>Source <b>top-analyst price targets</b></span>
        <span className="live">Live snapshot · Jun 29, 2026</span>
      </div>
    </>
  );
}
