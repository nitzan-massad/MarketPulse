import meta from "../data/meta.json";
import { DATE_LOCALE } from "../lib";
import type { LiveStatus } from "../useLiveQuotes";

interface MastheadProps {
  poolN: number;
  liveStatus: LiveStatus;
  onLive: () => void;
}

const SNAPSHOT = new Date(meta.generatedAt).toLocaleString(DATE_LOCALE, {
  month: "numeric", day: "numeric", year: "numeric",
  hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
});

export default function Masthead({ poolN, liveStatus, onLive }: MastheadProps) {
  const liveLabel =
    liveStatus === "live"
      ? "● Live"
      : liveStatus === "backup"
        ? "● Live (backup)"
        : liveStatus === "pre"
          ? "◐ Pre-market"
          : liveStatus === "post"
            ? "◐ After hours"
            : liveStatus === "closed"
              ? "● Market closed"
              : liveStatus === "connecting"
                ? "◐ Connecting…"
                : liveStatus === "error"
                  ? "⚠ Live unavailable"
                  : "○ Live off";
  const liveTitle =
    liveStatus === "error"
      ? "CNBC quotes and the Finnhub backup are both unavailable — click to turn live off"
      : "Live prices via CNBC, with Finnhub as the backup — click to turn off/on";
  return (
    <div className="metaline">
      <span>Universe <b>{meta.universe.toLocaleString()}</b> US stocks</span>
      <span>Showing <b id="poolN">{poolN}</b> ranked names</span>
      <span className="live">Snapshot · {SNAPSHOT}</span>
      <button type="button" className={`livebadge ${liveStatus}`} onClick={onLive} title={liveTitle}>
        {liveLabel}
      </button>
    </div>
  );
}
