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
// It starts on a real user gesture, "Enter the arena" or the navbar toggle, never
// on the landing, since browsers block autoplay and it is polite. Drop a track at
// public/audio/zerun-theme.mp3 or set NEXT_PUBLIC_MUSIC_URL.
const SRC = process.env.NEXT_PUBLIC_MUSIC_URL || "/audio/zerun-theme.mp3";

interface MusicState {
  playing: boolean;
  available: boolean;
  toggle: () => void;
  play: () => void;
}

const MusicContext = createContext<MusicState | null>(null);

export function MusicProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [available, setAvailable] = useState(true);

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

  const play = useCallback(() => {
    const a = audioRef.current;
    if (!a || !a.paused) return;
    a.play().catch(() => setAvailable(false));
  }, []);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!a.paused) {
      a.pause();
      return;
    }
    a.play().catch(() => setAvailable(false));
  }, []);

  return (
    <MusicContext.Provider value={{ playing, available, toggle, play }}>
      {children}
    </MusicContext.Provider>
  );
}

export function useMusic(): MusicState {
  const ctx = useContext(MusicContext);
  // Tolerate use outside the provider with a no-op, so callers stay simple.
  if (!ctx) return { playing: false, available: false, toggle: () => {}, play: () => {} };
  return ctx;
}
