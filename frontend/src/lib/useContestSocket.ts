"use client";

import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./config";
import type { WsMessage } from "./types";

export type SocketState = "connecting" | "open" | "closed";

interface Options {
  onMessage: (msg: WsMessage) => void;
}

// Subscribes to the backend WS and forwards typed messages for one contest.
// Reconnects with backoff; the consumer filters by contestId.
export function useContestSocket(contestId: number | string, { onMessage }: Options) {
  const [state, setState] = useState<SocketState>("connecting");
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      setState("connecting");
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempt = 0;
        setState("open");
        // Best-effort subscribe; backend may broadcast all contests regardless.
        try {
          ws?.send(JSON.stringify({ type: "subscribe", contestId: Number(contestId) }));
        } catch {
          /* ignore */
        }
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as WsMessage;
          if (msg && typeof msg === "object" && "type" in msg) {
            if (String(msg.contestId) === String(contestId)) {
              handlerRef.current(msg);
            }
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      ws.onclose = () => {
        setState("closed");
        scheduleReconnect();
      };

      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };

    const scheduleReconnect = () => {
      if (closed) return;
      attempt += 1;
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 4), 8000);
      timer = setTimeout(connect, delay);
    };

    connect();

    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [contestId]);

  return state;
}
