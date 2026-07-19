import { useEffect, useMemo, useRef, useState } from "react";
import type { Notification } from "../useNotifications";
import { fmtMarkDate } from "./ThumbMark";

interface Props {
  notifications: Notification[];
  unreadCount: number;
  onMarkAllRead: () => void;
  onClearAll: () => void;
  onOpenTicker: (ticker: string) => void;
}

const BellIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);
const ArrowUp = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5" /><path d="M5 12l7-7 7 7" />
  </svg>
);
const ArrowDown = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14" /><path d="M19 12l-7 7-7-7" />
  </svg>
);
const TrashIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);

function sameDay(ms: number, now: Date): boolean {
  const d = new Date(ms);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export default function NotificationBell({
  notifications,
  unreadCount,
  onMarkAllRead,
  onClearAll,
  onOpenTicker,
}: Props) {
  const [open, setOpen] = useState(false);
  // ids that were unread when the panel was opened — their coloured dots persist
  // for this viewing even though the panel-open marked them read.
  const [sessionNew, setSessionNew] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) {
        setSessionNew(new Set(notifications.filter((n) => !n.read).map((n) => n.id)));
        onMarkAllRead();
      }
      return next;
    });
  }

  const groups = useMemo(() => {
    const now = new Date();
    const today: Notification[] = [];
    const earlier: Notification[] = [];
    for (const n of notifications) (sameDay(n.at, now) ? today : earlier).push(n);
    return { today, earlier };
  }, [notifications]);

  const badge = unreadCount > 99 ? "99+" : String(unreadCount);
  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications";

  function renderRow(n: Notification) {
    const isNew = sessionNew.has(n.id);
    const up = n.dir === "up";
    const msg = up ? "I hope you bought this: " : "it's time to buy: ";
    const sign = n.pct >= 0 ? "+" : "−";
    return (
      <button
        key={n.id}
        className={`nb-row${isNew ? "" : " read"}`}
        role="menuitem"
        onClick={() => {
          onOpenTicker(n.ticker);
          setOpen(false);
        }}
      >
        <span className={`nb-dot ${up ? "up" : "dn"}`} />
        <span className="nb-mid">
          <span className="nb-msg">
            {msg}
            <span className="nb-tk">{n.ticker}</span>
          </span>
          <span className="nb-date">{fmtMarkDate(n.at)}</span>
        </span>
        <span className={`nb-pct ${up ? "up" : "dn"}`}>
          {up ? ArrowUp : ArrowDown}
          {sign}
          {Math.abs(n.pct)}%
        </span>
      </button>
    );
  }

  return (
    <div className="nb-root" ref={rootRef}>
      <button
        className="nb-bell"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {BellIcon}
        {unreadCount > 0 && <span className="nb-badge">{badge}</span>}
      </button>

      {open && (
        <div className="nb-pop" role="menu" aria-label="Notifications">
          <div className="nb-head">
            <span className="nb-htitle">Notifications</span>
            {sessionNew.size > 0 && <span className="nb-count">{sessionNew.size} new</span>}
          </div>

          {notifications.length === 0 ? (
            <div className="nb-empty">
              <div className="nb-medallion">{BellIcon}</div>
              <div className="nb-empty-h">No alerts yet</div>
              <div className="nb-empty-s">We'll ping you the moment a watchlist stock moves 5% or more.</div>
            </div>
          ) : (
            <>
              <div className="nb-body nb-fade">
                {groups.today.length > 0 && <div className="nb-group">Today</div>}
                {groups.today.map(renderRow)}
                {groups.earlier.length > 0 && <div className="nb-group">Earlier</div>}
                {groups.earlier.map(renderRow)}
              </div>
              <div className="nb-foot">
                <button className="nb-clear" type="button" onClick={onClearAll}>
                  {TrashIcon}
                  Clear all notifications
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
