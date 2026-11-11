// The close control, shared by every overlay. Pair it with a host that is
// `position:relative` and NOT `overflow:hidden` — the button rides the host's top-right
// corner, half outside it, so a clipping host would cut it in half.
//
// Styling is `.mp-close`, alongside `.mp-share`: both are overlay chrome now rather than
// stock-modal chrome, so neither belongs in the `.mkm-` namespace.

interface CloseButtonProps {
  /** What is being closed, for the accessible name — "EVTL", "the Fear & Greed index". */
  what?: string;
  onClose: () => void;
}

export default function CloseButton({ what, onClose }: CloseButtonProps) {
  return (
    <button
      type="button"
      className="mp-close"
      aria-label={what ? `Close ${what}` : "Close"}
      onClick={onClose}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}
