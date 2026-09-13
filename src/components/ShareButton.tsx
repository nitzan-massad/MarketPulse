// The share control, reusable by any modal or panel. Pair it with useShare().
//
// Styling lives on `.mp-share`, deliberately NOT `.mkm-` — that prefix is documented in
// index.css as scoped to the stock modal, and this button is no longer modal-only. The
// host supplies its own placement (the stock modal right-pushes it in the title bar; the
// Fear & Greed panel pins it to the top-right corner).

/** The bare 3-node share glyph (approved look: outlined-chip chrome, this icon). */
export const ShareIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" aria-hidden="true">
    <circle cx="18" cy="5" r="2.6" />
    <circle cx="6" cy="12" r="2.6" />
    <circle cx="18" cy="19" r="2.6" />
    <path d="M8.4 10.8l7.2-4.2M8.4 13.2l7.2 4.2" />
  </svg>
);

interface ShareButtonProps {
  /** What the link points at, for the tooltip — e.g. "AAPL" or "the Fear & Greed index". */
  what: string;
  onShare: () => void;
  /** Hide the visible word on narrow screens but keep it for screen readers. */
  compact?: boolean;
  className?: string;
}

export default function ShareButton({ what, onShare, compact, className }: ShareButtonProps) {
  return (
    <button
      type="button"
      className={`mp-share${compact ? " compact" : ""}${className ? " " + className : ""}`}
      title={`Copy link to ${what}`}
      onClick={onShare}
    >
      <ShareIcon />
      <span>Share</span>
    </button>
  );
}

/**
 * Shown when the clipboard refused. Carries `role="alert"` because the success path is
 * announced (ShareBurst's role="status") and a silent failure would be the wrong way
 * round — the one case a screen-reader user most needs to hear is the one that failed.
 */
export function ShareFail({ url }: { url: string }) {
  return (
    <div className="mp-copyfail" role="alert">
      Couldn't copy — here's the link: <code>{url}</code>
    </div>
  );
}
