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
  /**
   * Duck the theme without touching the mute setting.
   *
   * A live contest has its own sound — chess pieces, poker chips — and the theme playing over
   * it is two pieces of music at once. Ducking pauses the theme for the duration and restores
   * it afterwards, WITHOUT flipping `muted`, so the user's own choice survives: someone who
   * muted the theme stays muted when they leave the contest, and someone who had it on gets it
   * back.
   */
  duck: (on: boolean) => void;
}

const MusicContext = createContext<MusicState | null>(null);

export function MusicProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mutedRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tabIdRef = useRef(Math.random().toString(36).slice(2));
  const wasPlayingRef = useRef(false);
  const [muted, setMutedState] = useState(false); // default: sound on
  // Whether the theme was playing when a contest ducked it, so it can be restored on exit.
  const duckedRef = useRef(false);
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

  // Only play in the visible tab: pause when this tab is hidden (switched away or
  // the browser is minimized), and resume when it comes back if it was playing.
  useEffect(() => {
    const onVisibility = () => {
      const a = audioRef.current;
      if (!a) return;
      if (document.hidden) {
        wasPlayingRef.current = !a.paused;
        if (!a.paused) a.pause();
      } else if (wasPlayingRef.current && !mutedRef.current) {
        a.play().then(() => announcePlay()).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [announcePlay]);

  // Sound is on by default. Browsers block audible autoplay until the page has been
  // interacted with, so: try immediately (Chrome allows it once a visitor has a history of
  // playing media on the origin), and otherwise wait for the first gesture.
  //
  // Two bugs lived here. The listeners were registered `once`, so if the very first gesture
  // arrived before the <audio> could play — or play() was rejected — the handler was gone and
  // the theme never started for the rest of the session. And a touch that never becomes a
  // pointerdown (a scroll flick) left it silent. Keep listening until a play actually resolves.
  useEffect(() => {
    let done = false;

    const start = () => {
      if (done) return;
      const a = audioRef.current;
      if (!a || !a.paused || mutedRef.current) return;
      a.play()
        .then(() => {
          done = true;
          detach();
          announcePlay();
        })
        .catch(() => {
          /* still blocked: leave the listeners attached and wait for the next gesture */
        });
    };

    const detach = () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("touchstart", start);
      window.removeEventListener("keydown", start);
      window.removeEventListener("click", start);
    };

    // The optimistic attempt. Silently rejected on a first-ever visit; that is fine.
    start();

    window.addEventListener("pointerdown", start);
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("keydown", start);
    window.addEventListener("click", start);
    return detach;
  }, [announcePlay]);

  const duck = useCallback((on: boolean) => {
    const a = audioRef.current;
    if (!a) return;
    if (on) {
      duckedRef.current = !a.paused;
      if (!a.paused) {
        a.pause();
        setPlaying(false);
      }
      return;
    }
    // Restore only if we were the ones who paused it, and the user has not muted meanwhile.
    if (duckedRef.current && !mutedRef.current) {
      a.play().then(() => announcePlay()).catch(() => {});
    }
    duckedRef.current = false;
  }, [announcePlay]);

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
    <MusicContext.Provider value={{ muted, playing, available, toggle, play, duck }}>
      {children}
    </MusicContext.Provider>
  );
}

export function useMusic(): MusicState {
  const ctx = useContext(MusicContext);
  if (!ctx) return { muted: false, playing: false, available: false, toggle: () => {}, play: () => {}, duck: () => {} };
  return ctx;
}
