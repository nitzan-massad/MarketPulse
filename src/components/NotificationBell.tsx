import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type TouchEvent } from "react";
import { alertView } from "../alertEngine";
import type { Notification } from "../useNotifications";
import { fmtMarkDate } from "./ThumbMark";
import { DATE_LOCALE } from "../lib";

// "10/03" — the row's gray "since" date; the group header (Today / Earlier) carries the year
const fmtTrackedDate = (ms: number) => new Date(ms).toLocaleDateString(DATE_LOCALE, { month: "2-digit", day: "2-digit" });

interface Props {
  notifications: Notification[];
  unreadCount: number;
  onMarkAllRead: () => void;
  onClearAll: () => void;
  onOpen: (n: Notification) => void;
  reopenKey?: number; // bumped by the app to reopen the panel where the user left it
}

const BellIcon = (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);
const TrashIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </svg>
);
const DocIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8" /><path d="M8 17h5" />
  </svg>
);

const CheckIcon = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12l5 5L19 7" />
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
  onOpen,
  reopenKey = 0,
}: Props) {
  const [open, setOpen] = useState(false);
  // ids that were unread when the panel was opened — their coloured dots persist
  // for this viewing even though the panel-open marked them read.
  const [sessionNew, setSessionNew] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // phone: swipe the panel up to close it. dragY is the live offset (≤ 0) while a finger is down.
  const drag = useRef<{ y0: number; h: number } | null>(null);
  const [dragY, setDragY] = useState(0);

  function onTouchStart(e: TouchEvent<HTMLDivElement>) {
    const b = bodyRef.current;
    // inside the list, a swipe up scrolls it — only drag the panel once the list is at its end
    if (b && b.contains(e.target as Node) && b.scrollTop + b.clientHeight < b.scrollHeight - 1) return;
    drag.current = { y0: e.touches[0].clientY, h: e.currentTarget.offsetHeight };
  }
  function onTouchMove(e: TouchEvent) {
    if (drag.current) setDragY(Math.min(0, e.touches[0].clientY - drag.current.y0));
  }
  function onTouchEnd() {
    if (drag.current && -dragY > drag.current.h / 3) setOpen(false);
    drag.current = null;
    setDragY(0);
  }
  const savedScroll = useRef(0);

  // reopen without re-marking: the session's "new" dots and scroll position are kept
  useEffect(() => {
    if (reopenKey) setOpen(true);
  }, [reopenKey]);
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = savedScroll.current;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // A stock modal opened from a notification sits on top of the panel; clicks and Escape
    // inside it belong to the modal, and closing it lands back here with the panel still open.
    const modalUp = () => !!document.querySelector(".mkm-scrim");
    const onDoc = (e: MouseEvent) => {
      if (modalUp()) return;
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modalUp()) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // arrivals while the panel is open (RTDB landing after the boot cache, a review detected
  // after open) are seen now: they join the end of the "new" set (so nothing already shown
  // moves), slide in, and get marked read. Scrolled down, they're above the fold: count them
  // for the "↑ N new" chip.
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [jumpN, setJumpN] = useState(0);
  useEffect(() => {
    if (!open) return;
    const fresh = notifications.filter((n) => !n.read && !sessionNew.has(n.id)).map((n) => n.id);
    if (!fresh.length) return;
    setSessionNew((s) => new Set([...s, ...fresh]));
    setArrived((s) => new Set([...s, ...fresh]));
    if ((bodyRef.current?.scrollTop ?? 0) > 0) setJumpN((j) => j + fresh.length);
    onMarkAllRead();
  }, [open, notifications, sessionNew, onMarkAllRead]);

  // hold the scroll: pin the first visible row and undo however far a re-render moved it, so
  // rows landing above (or a group header appearing/going) never shift what's under the finger.
  // .nb-body has overflow-anchor:none — the browser's own anchoring would double this, and
  // Safari's is unreliable anyway.
  const anchor = useRef<{ el: HTMLElement; top: number } | null>(null);
  const pinAnchor = () => {
    const b = bodyRef.current;
    const el = b && [...b.querySelectorAll<HTMLElement>(".nb-row")].find((r) => r.offsetTop + r.offsetHeight > b.scrollTop);
    anchor.current = el ? { el, top: el.offsetTop } : null;
  };
  useLayoutEffect(() => {
    const b = bodyRef.current;
    const a = anchor.current;
    if (b && a?.el.isConnected && b.scrollTop > 0) b.scrollTop += a.el.offsetTop - a.top;
    pinAnchor();
  }, [open, notifications, sessionNew]);

  // "Clear all": rows sweep out first, then the store is cleared
  const [clearing, setClearing] = useState(false);
  function clearAll() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return onClearAll();
    setClearing(true);
    setTimeout(() => {
      setClearing(false);
      onClearAll();
    }, 420); // .22s animation + up to 8 x 25ms stagger
  }

  function toggle() {
    setOpen((o) => {
      const next = !o;
      if (next) {
        savedScroll.current = 0;
        setSessionNew(new Set(notifications.filter((n) => !n.read).map((n) => n.id)));
        setArrived(new Set());
        setJumpN(0);
        onMarkAllRead();
      }
      return next;
    });
  }

  // "New" = this viewing's unread rows, in the order they became new (sessionNew is a Set, so
  // insertion order): the snapshot at open newest-first, then arrivals appended at its bottom.
  const groups = useMemo(() => {
    const now = new Date();
    const byId = new Map(notifications.map((n) => [n.id, n]));
    const fresh = [...sessionNew].map((id) => byId.get(id)).filter((n): n is Notification => !!n);
    const today: Notification[] = [];
    const earlier: Notification[] = [];
    for (const n of notifications) if (!sessionNew.has(n.id)) (sameDay(n.at, now) ? today : earlier).push(n);
    return { fresh, today, earlier };
  }, [notifications, sessionNew]);

  const badge = unreadCount > 99 ? "99+" : String(unreadCount);
  const label = unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications";

  function renderRow(n: Notification, i: number) {
    const isNew = sessionNew.has(n.id);
    const cls = `${isNew ? "" : " read"}${arrived.has(n.id) ? " nb-in" : ""}`;
    const style = { "--i": Math.min(i, 8) } as CSSProperties; // Clear-all stagger
    const open = () => {
      savedScroll.current = bodyRef.current?.scrollTop ?? 0;
      onOpen(n); // the panel stays open underneath — see modalUp() above
    };
    if (n.type === "tracked") {
      return (
        <button key={n.id} className={`nb-row${cls}`} style={style} role="menuitem" onClick={open}>
          <span className="nb-ico review">{CheckIcon}</span>
          <span className="nb-mid">
            <span className="nb-msg">
              <span className="nb-tk">{n.ticker}</span> is now tracked
            </span>
            <span className="nb-rev">full analyst data is in</span>
            <span className="nb-date">{fmtMarkDate(n.at)}</span>
          </span>
        </button>
      );
    }
    if (n.type === "review") {
      const count = n.keys?.length ?? 1;
      return (
        <button key={n.id} className={`nb-row${cls}`} style={style} role="menuitem" onClick={open}>
          <span className="nb-ico review">{DocIcon}</span>
          <span className="nb-mid">
            <span className="nb-msg">
              <span className="nb-tk">{n.ticker}</span>
              {n.company ? <span className="nb-co"> · {n.company}</span> : null}
            </span>
            <span className="nb-rev">{count === 1 ? "new analyst review" : `${count} new analyst reviews`}</span>
            <span className="nb-date">{fmtMarkDate(n.at)}</span>
          </span>
        </button>
      );
    }
    const up = n.dir === "up";
    const view = alertView(n, fmtTrackedDate);
    return (
      <button
        key={n.id}
        className={`nb-row nb-price${cls}`}
        style={style}
        role="menuitem"
        aria-label={`${n.ticker} ${view.pct} since the last alert${view.total ? `, ${view.total}` : ""}, ${fmtMarkDate(n.at)}`}
        title={fmtMarkDate(n.at)}
        onClick={open}
      >
        <span className={`nb-blk ${up ? "up" : "dn"}`}>{view.pct}</span>
        <span className="nb-mid">
          <span className="nb-tk">{n.ticker}</span>
          {view.total && <span className="nb-date">{view.total}</span>}
        </span>
      </button>
    );
  }

  return (
    <div className="nb-root" ref={rootRef}>
      {open && <div className="nb-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      <button
        className="nb-bell"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        {BellIcon}
        {/* keyed by the count so the pop-in replays on each change. ponytail: it also replays on a
            drop to a non-zero count, which only a read on another device causes */}
        {unreadCount > 0 && <span key={unreadCount} className="nb-badge">{badge}</span>}
      </button>

      {open && (
        <div
          className={`nb-pop${dragY ? " nb-dragging" : ""}`}
          role="menu"
          aria-label="Notifications"
          style={dragY ? { transform: `translateY(${dragY}px)`, opacity: 1 + dragY / 400 } : undefined}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          <div className="nb-head">
            <span className="nb-htitle">Notifications</span>
            {groups.fresh.length > 0 && <span className="nb-count">{groups.fresh.length} new</span>}
            <button className="nb-x" type="button" aria-label="Close notifications" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>

          {notifications.length === 0 ? (
            <div className="nb-empty">
              <div className="nb-medallion">{BellIcon}</div>
              <div className="nb-empty-h">No alerts yet</div>
              <div className="nb-empty-s">We'll ping you when a watchlist stock moves 5% or more, or a new analyst review lands.</div>
            </div>
          ) : (
            <>
              <div
                className={`nb-body nb-fade${clearing ? " nb-out" : ""}`}
                ref={bodyRef}
                onScroll={(e) => {
                  pinAnchor();
                  if (jumpN && e.currentTarget.scrollTop < 4) setJumpN(0);
                }}
              >
                {jumpN > 0 && (
                  <button
                    className="nb-jump"
                    type="button"
                    onClick={() =>
                      bodyRef.current?.scrollTo({
                        top: 0,
                        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                      })
                    }
                  >
                    ↑ {jumpN} new
                  </button>
                )}
                {groups.fresh.length > 0 && <div className="nb-group new">New</div>}
                {groups.fresh.map(renderRow)}
                {groups.today.length > 0 && <div className="nb-group">Today</div>}
                {groups.today.map(renderRow)}
                {groups.earlier.length > 0 && <div className="nb-group">Earlier</div>}
                {groups.earlier.map(renderRow)}
              </div>
              <div className="nb-foot">
                <button className="nb-clear" type="button" onClick={clearAll} disabled={clearing}>
                  {TrashIcon}
                  Clear all notifications
                </button>
              </div>
            </>
          )}
          <div className="nb-grab" aria-hidden="true"><i /></div>
        </div>
      )}
    </div>
  );
}
