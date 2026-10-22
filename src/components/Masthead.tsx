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
                  ? "⚠ Live — add key"
                  : hasKey
                    ? "○ Live off"
                    : "⚡ Go live";
  const liveTitle =
    liveStatus === "error"
      ? "CNBC quotes are unavailable and the Finnhub backup needs a free API key (stored only in this browser)"
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
