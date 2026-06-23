"use client";

import { useState } from "react";
import Link from "next/link";
import { useNotifications } from "@/lib/notifications";
import { cx } from "./zerun/cx";

// Navbar bell: unread count badge, a dropdown of recent wins and updates, with
// mark-as-read and clear.
export function NotificationBell({ className = "" }: { className?: string }) {
  const { notifs, unread, markAllRead, clear } = useNotifications();
  const [open, setOpen] = useState(false);

  return (
    <div className={cx("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Notifications"
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-pill border-line border-ink bg-cloud text-ink shadow-pop-press transition hover:-translate-y-px"
      >
        <Bell />
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full border border-ink bg-coral px-1 font-body text-[10px] font-extrabold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 z-50 mt-2 w-72 overflow-hidden rounded-chunk border-line border-ink bg-cloud shadow-pop">
            <div className="flex items-center justify-between border-b-line border-ink/15 px-3 py-2">
              <span className="font-display text-sm text-ink">Notifications</span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={markAllRead}
                  disabled={unread === 0}
                  className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-3 transition enabled:hover:text-ink disabled:opacity-40"
                >
                  Mark read
                </button>
                <button
                  type="button"
                  onClick={clear}
                  disabled={notifs.length === 0}
                  className="font-body text-[11px] font-extrabold uppercase tracking-[0.02em] text-ink-3 transition enabled:hover:text-coral disabled:opacity-40"
                >
                  Clear
                </button>
              </div>
            </div>
            <ul className="max-h-80 overflow-y-auto">
              {notifs.length === 0 ? (
                <li className="px-3 py-6 text-center font-body text-[13px] text-ink-3">
                  Nothing yet. Wins and updates land here.
                </li>
              ) : (
                notifs.map((n) => (
                  <li key={n.id} className="border-t-line border-ink/10 first:border-t-0">
                    <Link
                      href={`/contest/${n.contestId}`}
                      onClick={() => setOpen(false)}
                      className={cx(
                        "block px-3 py-2.5 transition hover:bg-violet/5",
                        !n.read && "bg-violet/10",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-violet" aria-hidden />}
                        <span className="font-display text-[14px] text-ink">{n.title}</span>
                      </div>
                      <div className="mt-0.5 font-body text-[12px] text-ink-2">{n.body}</div>
                    </Link>
                  </li>
                ))
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function Bell() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5c0 3-1 4.5-1.5 5h12c-.5-.5-1.5-2-1.5-5A4.5 4.5 0 0 0 10 2.5z"
        fill="currentColor"
      />
      <path d="M8 15a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
