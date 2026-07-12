import { useEffect, useRef, useState } from "react";

export type NavId = "table" | "best" | "new" | "watch";

interface NavMenuProps {
  nav: NavId;
  onNav: (id: NavId) => void;
}

const ITEMS: { id: NavId; label: string; sub: string }[] = [
  { id: "table", label: "Top Stocks", sub: "The ranked screener" },
  { id: "best", label: "Best of the Best", sub: "Curated highest conviction" },
  { id: "new", label: "New Arrivals", sub: "Recently added to the lists" },
  { id: "watch", label: "Watchlist", sub: "Stocks you're tracking" },
];

export default function NavMenu({ nav, onNav }: NavMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(id: NavId) {
    onNav(id);
    setOpen(false);
  }

  return (
    <div className="nav-menu" ref={rootRef}>
      <button
        type="button"
        className={`nav-burger ${open ? "on" : ""}`}
        aria-label="Open navigation menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="nav-bars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>

      {open && (
        <div className="nav-pop" role="menu" aria-label="Views">
          {ITEMS.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitemradio"
              aria-checked={nav === it.id}
              className={`nav-item ${nav === it.id ? "on" : ""}`}
              onClick={() => pick(it.id)}
            >
              <span className="nav-item-label">{it.label}</span>
              <small>{it.sub}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
