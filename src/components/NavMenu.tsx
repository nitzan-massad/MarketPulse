import type { ReactNode } from "react";

export type NavId = "table" | "best" | "new" | "watch";

interface NavMenuProps {
  nav: NavId;
  onNav: (id: NavId) => void;
}

// compact glyphs for the bottom bar
const ICON: Record<NavId, ReactNode> = {
  table: (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 21V11" />
      <path d="M12 21V4" />
      <path d="M19 21v-6" />
    </svg>
  ),
  best: (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden="true">
      <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01z" />
    </svg>
  ),
  new: (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor" aria-hidden="true">
      <path d="M12 1.8l1.9 7.3 7.3 1.9-7.3 1.9L12 20.2l-1.9-7.3L2.8 11l7.3-1.9z" />
    </svg>
  ),
  watch: (
    <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M6 3h12v18l-6-4-6 4z" />
    </svg>
  ),
};

const ITEMS: { id: NavId; label: string }[] = [
  { id: "table", label: "Stocks" },
  { id: "best", label: "Best" },
  { id: "new", label: "New" },
  { id: "watch", label: "Watchlist" },
];

export default function NavMenu({ nav, onNav }: NavMenuProps) {
  return (
    <nav className="nav-bottom" aria-label="Sections">
      <div className="nav-bottom-inner">
        {ITEMS.map((it) => (
          <button
            key={it.id}
            type="button"
            className={`nav-tab ${nav === it.id ? "on" : ""}`}
            aria-current={nav === it.id ? "page" : undefined}
            onClick={() => onNav(it.id)}
          >
            <span className="nav-tab-ic">{ICON[it.id]}</span>
            <span className="nav-tab-lb">{it.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
