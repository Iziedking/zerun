"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { formatUsdc, ordinal } from "./format";

export interface Notif {
  id: string;
  contestId: number;
  type: "win" | "settled";
  title: string;
  body: string;
  amount?: string;
  rank?: number;
  ts: number;
  read: boolean;
}

interface NotifState {
  notifs: Notif[];
  unread: number;
  markAllRead: () => void;
  clear: () => void;
  celebration: Notif | null;
  dismissCelebration: () => void;
}

const NotifContext = createContext<NotifState | null>(null);
const isDone = (s: string) => ["settled", "scored"].includes((s || "").toLowerCase());

// Watches the connected operator's contests and raises a notification when one
// they entered settles, with a win celebration when they placed in the money. It
// baselines on first load so old results never re-fire, and remembers everything
// per wallet in localStorage so the bell and read state survive a refresh.
export function NotificationProvider({ children }: { children: ReactNode }) {
  const { address } = useAccount();
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [celebration, setCelebration] = useState<Notif | null>(null);
  const seenRef = useRef<Set<number>>(new Set());
  const initedRef = useRef(false);

  const listKey = address ? `zerun:notif:list:${address.toLowerCase()}` : null;
  const seenKey = address ? `zerun:notif:seen:${address.toLowerCase()}` : null;

  useEffect(() => {
    setCelebration(null);
    initedRef.current = false;
    seenRef.current = new Set();
    if (!listKey || !seenKey) {
      setNotifs([]);
      return;
    }
    try {
      const seenRaw = localStorage.getItem(seenKey);
      seenRef.current = new Set(seenRaw ? JSON.parse(seenRaw) : []);
      initedRef.current = seenRaw !== null;
      setNotifs(JSON.parse(localStorage.getItem(listKey) ?? "[]"));
    } catch {
      setNotifs([]);
    }
  }, [listKey, seenKey]);

  const profileQ = useQuery({
    queryKey: ["notif-operator", address],
    queryFn: () => api.operator(address!),
    enabled: Boolean(address),
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (!address || !profileQ.data || !listKey || !seenKey) return;
    const settled = profileQ.data.matches.filter((m) => isDone(m.status));
    const seen = seenRef.current;

    // First poll for this wallet: baseline everything, fire nothing.
    if (!initedRef.current) {
      for (const m of settled) seen.add(m.contest_id);
      initedRef.current = true;
      try {
        localStorage.setItem(seenKey, JSON.stringify([...seen]));
      } catch {
        /* ignore */
      }
      return;
    }

    const fresh: Notif[] = [];
    for (const m of settled) {
      if (seen.has(m.contest_id)) continue;
      seen.add(m.contest_id);
      const won = Boolean(m.amount && Number(m.amount) > 0);
      const place = m.rank ?? 0;
      const placed = won && place > 1 ? `You took ${ordinal(place)}` : "You won";
      fresh.push({
        id: `c${m.contest_id}-${m.settled_at ?? ""}`,
        contestId: m.contest_id,
        type: won ? "win" : "settled",
        title: won ? `${placed}, ${formatUsdc(m.amount)} tUSDC` : `Contest #${m.contest_id} settled`,
        body: won
          ? `Contest #${m.contest_id} is in. Claim your reward.`
          : `A contest you entered has settled.`,
        amount: m.amount ?? undefined,
        rank: place || undefined,
        ts: Date.now(),
        read: false,
      });
    }
    if (!fresh.length) return;

    setNotifs((prev) => {
      const next = [...fresh, ...prev].slice(0, 30);
      try {
        localStorage.setItem(listKey, JSON.stringify(next));
        localStorage.setItem(seenKey, JSON.stringify([...seen]));
      } catch {
        /* ignore */
      }
      return next;
    });
    const win = fresh.find((n) => n.type === "win");
    if (win) setCelebration(win);
  }, [profileQ.data, address, listKey, seenKey]);

  const persist = useCallback(
    (next: Notif[]) => {
      setNotifs(next);
      try {
        if (listKey) localStorage.setItem(listKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [listKey],
  );

  const markAllRead = useCallback(
    () => persist(notifs.map((n) => ({ ...n, read: true }))),
    [notifs, persist],
  );
  const clear = useCallback(() => persist([]), [persist]);
  const dismissCelebration = useCallback(() => setCelebration(null), []);

  const value = useMemo<NotifState>(
    () => ({
      notifs,
      unread: notifs.filter((n) => !n.read).length,
      markAllRead,
      clear,
      celebration,
      dismissCelebration,
    }),
    [notifs, markAllRead, clear, celebration, dismissCelebration],
  );

  return <NotifContext.Provider value={value}>{children}</NotifContext.Provider>;
}

export function useNotifications(): NotifState {
  const ctx = useContext(NotifContext);
  if (!ctx)
    return {
      notifs: [],
      unread: 0,
      markAllRead: () => {},
      clear: () => {},
      celebration: null,
      dismissCelebration: () => {},
    };
  return ctx;
}
