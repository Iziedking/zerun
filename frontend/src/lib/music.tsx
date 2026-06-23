"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

// One shared soundtrack for the whole app. The audio element lives in this
// provider (mounted in the layout), so it keeps playing across page navigations.
// Sound is ON by default; the operator can mute, and that choice is remembered.
// Browsers block autoplay without a gesture, so when unmuted it starts on the
// first interaction (and immediately on "Enter the arena"). Drop a track at
// public/audio/zerun-theme.mp3 or set NEXT_PUBLIC_MUSIC_URL.
const SRC = process.env.NEXT_PUBLIC_MUSIC_URL || "/audio/zerun-theme.mp3";
const MUTED_KEY = "zerun:music:muted";

interface MusicState {
  muted: boolean;
  playing: boolean;
  available: boolean;
  toggle: () => void;
  play: () => void;
}

const MusicContext = createContext<MusicState | null>(null);

export function MusicProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tabIdRef = useRef(Math.random().toString(36).slice(2));
  const [muted, setMutedState] = useState(false); // default: sound on
  const [playing, setPlaying] = useState(false);
  const [available, setAvailable] = useState(true);

  // Only one tab streams the music: when this tab starts, it tells the others to
  // yield, and when another tab starts, this one pauses.
  const announcePlay = useCallback(() => {
    channelRef.current?.postMessage({ type: "play", id: tabIdRef.current });
  }, []);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("zerun-music");
    ch.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "play" && e.data.id !== tabIdRef.current) {
        const a = audioRef.current;
        if (a && !a.paused) a.pause();
      }
    };
    channelRef.current = ch;
    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, []);

  const setMuted = useCallback((m: boolean) => {
    mutedRef.current = m;
    setMutedState(m);
    try {
      localStorage.setItem(MUTED_KEY, m ? "1" : "0");
    } catch {
      /* private mode: choice stays in memory */
    }
  }, []);

  // Remember the mute choice across visits.
  useEffect(() => {
    try {
      if (localStorage.getItem(MUTED_KEY) === "1") setMuted(true);
    } catch {
      /* ignore */
    }
  }, [setMuted]);

  // The shared audio element, created once.
  useEffect(() => {
    const a = new Audio(SRC);
    a.loop = true;
    a.volume = 0.3;
    a.preload = "auto";
    const onError = () => setAvailable(false);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener("error", onError);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    audioRef.current = a;
    return () => {
      a.removeEventListener("error", onError);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.pause();
      audioRef.current = null;
    };
  }, []);

  // Sound is on by default, so start at the first user gesture (autoplay-safe).
  useEffect(() => {
    const start = () => {
      const a = audioRef.current;
      if (a && a.paused && !mutedRef.current) a.play().then(() => announcePlay()).catch(() => {});
    };
    window.addEventListener("pointerdown", start, { once: true });
    window.addEventListener("keydown", start, { once: true });
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
  }, []);

  const play = useCallback(() => {
    const a = audioRef.current;
    if (!a || mutedRef.current || !a.paused) return;
    a.play().then(() => announcePlay()).catch(() => setAvailable(false));
  }, [announcePlay]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!a.paused) {
      a.pause();
      setMuted(true);
      return;
    }
    setMuted(false);
    a.play().then(() => announcePlay()).catch(() => setAvailable(false));
  }, [setMuted, announcePlay]);

  return (
    <MusicContext.Provider value={{ muted, playing, available, toggle, play }}>
      {children}
    </MusicContext.Provider>
  );
}

export function useMusic(): MusicState {
  const ctx = useContext(MusicContext);
  if (!ctx) return { muted: false, playing: false, available: false, toggle: () => {}, play: () => {} };
  return ctx;
}
