import { useCallback, useEffect, useRef, useState } from "react";
import { buildShareUrl, copyText, pickBurst, type BurstId, type ShareTarget } from "./share";

/**
 * Everything the share flow needs, for any host that wants a share button.
 * Lifted out of StockModal so the Fear & Greed panel (and whatever comes next) gets the
 * same behaviour rather than a second copy of it.
 *
 * The host stays in charge of two things on purpose:
 *   • it puts `data-burst={burst}` on whichever element should host the animation — the
 *     layer is clipped to that element, and index.css reaches *down* from it to animate
 *     the button itself (that is why the attribute is not on the button);
 *   • it places <ShareBurst> and <ShareFail> wherever they belong in its own layout.
 *
 * `resetKey` clears a running burst when the host's subject changes — paging ‹ › to
 * another stock must not finish a burst over the new ticker, which would read as
 * "this one was copied too".
 */
export interface Share {
  burst: BurstId | null;
  copyFailed: boolean;
  /** The URL that was (or would be) copied — shown verbatim when the copy fails. */
  url: string;
  onShare: () => void;
  onBurstDone: () => void;
}

export function useShare(target: ShareTarget, resetKey?: unknown): Share {
  const [burst, setBurst] = useState<BurstId | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  // Remembered so pickBurst can exclude it — two identical animations back to back read
  // as "there is only one", which defeats having twenty.
  const lastBurst = useRef<BurstId | null>(null);

  const url = buildShareUrl(target, location.origin, import.meta.env.BASE_URL);

  const onShare = useCallback(() => {
    void (async () => {
      const ok = await copyText(url);
      setCopyFailed(!ok);
      // Never play a success animation over a clipboard that did not take.
      if (!ok) return;
      const next = pickBurst(lastBurst.current);
      lastBurst.current = next;
      setBurst(next); // ShareBurst unmounts itself via onBurstDone when the animation ends
    })();
  }, [url]);

  const onBurstDone = useCallback(() => setBurst(null), []);

  useEffect(() => {
    setBurst(null);
    setCopyFailed(false);
  }, [resetKey]);

  return { burst, copyFailed, url, onShare, onBurstDone };
}
