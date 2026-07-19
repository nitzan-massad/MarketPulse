import meta from "../data/meta.json";
import { DATE_LOCALE } from "../lib";
import type { LiveStatus } from "../useLiveQuotes";

interface MastheadProps {
  poolN: number;
  liveStatus: LiveStatus;
  hasKey: boolean;
  onLive: () => void;
}

const SNAPSHOT = new Date(meta.generatedAt).toLocaleString(DATE_LOCALE, {
  month: "numeric", day: "numeric", year: "numeric",
  hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
});

export default function Masthead({ poolN, liveStatus, hasKey, onLive }: MastheadProps) {
  const liveLabel =
    liveStatus === "live"
      ? "● Live"
      : liveStatus === "closed"
        ? "● Market closed"
        : liveStatus === "error"
          ? "⚠ Live — check key"
          : hasKey
            ? "○ Live off"
            : "⚡ Go live";
  return (
    <div className="metaline">
      <span>Universe <b>{meta.universe.toLocaleString()}</b> US stocks</span>
      <span>Showing <b id="poolN">{poolN}</b> ranked names</span>
      <span>Source <b>top-analyst price targets</b></span>
      <span className="live">Snapshot · {SNAPSHOT}</span>
      <button type="button" className={`livebadge ${liveStatus}`} onClick={onLive} title="Live Day % via Finnhub (your key, stored only in this browser)">
        {liveLabel}
      </button>
    </div>
  );
}
