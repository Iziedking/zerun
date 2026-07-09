// Cartoon game sounds synthesized with Web Audio, so there is no asset to ship and
// nothing to preload. Each is a short, friendly blip that matches the sticker-book
// feel; everything fails silently if the browser blocks or lacks audio. A single
// shared AudioContext is reused (and resumed after the first user gesture) so frequent
// action sounds do not spin up a new context each time.

let sharedCtx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!sharedCtx) sharedCtx = new Ctx();
    // Browsers start the context suspended until a user gesture; resume best effort.
    if (sharedCtx.state === "suspended") void sharedCtx.resume();
    return sharedCtx;
  } catch {
    return null;
  }
}

// Play a short sequence of tones. Each note is a tiny enveloped oscillator, so the
// whole thing stays crisp and light rather than droning.
function tones(
  notes: { f: number; t: number; dur?: number; type?: OscillatorType; gain?: number }[],
): void {
  const ctx = audioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const n of notes) {
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = n.type ?? "triangle";
      osc.frequency.value = n.f;
      const start = now + n.t;
      const dur = n.dur ?? 0.12;
      const peak = n.gain ?? 0.14;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0008, start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    } catch {
      /* ignore a single bad note */
    }
  }
}

// ---------------------------------------------------------------------------
// Sample layer
// ---------------------------------------------------------------------------
//
// The synthesized knocks below are the FALLBACK, and they always work. Drop a real recording
// at the paths in CHESS_SFX and it is used instead, with no code change. A missing file must
// never produce silence: a chess tournament with no move sound is worse than a synthetic one.
//
// Files are optional. Nothing is fetched until the first time a sound is asked for.

export const CHESS_SFX = {
  gameStart: "/audio/chess/game-start.mp3",
  move: "/audio/chess/move.mp3",
  capture: "/audio/chess/capture.mp3",
  gameEnd: "/audio/chess/game-end.mp3",
} as const;

export const POKER_SFX = {
  fold: "/audio/poker/fold.mp3",
  check: "/audio/poker/check.mp3",
  call: "/audio/poker/call.mp3",
  raise: "/audio/poker/raise.mp3",
  showdown: "/audio/poker/showdown.mp3",
} as const;

type SampleState = "unknown" | "ready" | "missing";
const samples = new Map<string, { el: HTMLAudioElement; state: SampleState }>();

function sample(url: string): { el: HTMLAudioElement; state: SampleState } | null {
  if (typeof window === "undefined") return null;
  let s = samples.get(url);
  if (!s) {
    const el = new Audio(url);
    el.preload = "auto";
    s = { el, state: "unknown" };
    el.addEventListener("canplaythrough", () => (s!.state = "ready"), { once: true });
    el.addEventListener("error", () => (s!.state = "missing"), { once: true });
    samples.set(url, s);
  }
  return s;
}

/** Warm the cache so the very first move is not the one that discovers the file is missing. */
export function preloadChessSfx(): void {
  for (const url of Object.values(CHESS_SFX)) sample(url);
}

export function preloadPokerSfx(): void {
  for (const url of Object.values(POKER_SFX)) sample(url);
}

/**
 * A poker action. The runner writes a label like "raises to 60", "folds", "checks",
 * "calls 20", or a showdown line, so match on the verb and play its sample when one exists.
 * Falls back to the synthesized chip clicks, which is what shipped before any assets did.
 */
export function playPokerAction(label = ""): void {
  const l = label.toLowerCase();
  const url = l.startsWith("fold")
    ? POKER_SFX.fold
    : l.startsWith("check")
      ? POKER_SFX.check
      : l.startsWith("call")
        ? POKER_SFX.call
        : l.startsWith("raise") || l.startsWith("bet") || l.includes("all-in")
          ? POKER_SFX.raise
          : l.startsWith("showdown")
            ? POKER_SFX.showdown
            : "";
  if (url && playSample(url, 0.45)) return;
  playActionSound("poker");
}

/** Play a sample if it is loaded. Returns false when it is absent, so a caller can synthesize. */
function playSample(url: string, volume = 0.5): boolean {
  const s = sample(url);
  if (!s || s.state !== "ready") return false;
  try {
    // Clone so overlapping moves do not cut each other off.
    const node = s.el.cloneNode(true) as HTMLAudioElement;
    node.volume = volume;
    void node.play().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// A short burst of filtered noise. Oscillators can only sing; a chess piece meeting a board
// is a transient, and no pure tone will ever sound like wood. Band-passing white noise gives
// the knock its body, and the tight envelope gives it the click.
let noiseBuf: AudioBuffer | null = null;
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = Math.floor(ctx.sampleRate * 0.2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

function knock(opts: { t?: number; freq: number; q?: number; dur?: number; gain?: number }): void {
  const ctx = audioCtx();
  if (!ctx) return;
  try {
    const start = ctx.currentTime + (opts.t ?? 0);
    const dur = opts.dur ?? 0.045;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = opts.freq;
    band.Q.value = opts.q ?? 4;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(opts.gain ?? 0.09, start + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0006, start + dur);

    src.connect(band).connect(gain).connect(ctx.destination);
    src.start(start);
    src.stop(start + dur + 0.02);
  } catch {
    /* ignore a single bad knock */
  }
}

/**
 * A piece landing on the board.
 *
 * A quiet move is one wooden tap: a noise knock for the click, plus a low sine for the body
 * of the piece meeting the board. A capture is two — the captured piece lifted away, then the
 * capturing piece set down harder, pitched lower so it reads as heavier, not merely louder.
 * Both are brief: a tournament plays a few hundred of these and it must never become nagging.
 */
export function playChessMove(capture = false): void {
  // A real recording if one was dropped in; the synth otherwise.
  if (playSample(capture ? CHESS_SFX.capture : CHESS_SFX.move, capture ? 0.55 : 0.42)) return;

  if (!capture) {
    knock({ freq: 1500, q: 3, dur: 0.04, gain: 0.075 });
    tones([{ f: 190, t: 0, dur: 0.06, type: "sine", gain: 0.05 }]);
    return;
  }
  // The captured piece, lifted and set aside.
  knock({ freq: 2100, q: 5, dur: 0.03, gain: 0.055 });
  // Then the capturing piece, landing where it stood.
  knock({ t: 0.075, freq: 1100, q: 2.5, dur: 0.06, gain: 0.1 });
  tones([{ f: 140, t: 0.075, dur: 0.09, type: "sine", gain: 0.07 }]);
}

/**
 * A game beginning: the first ply of a duel, or of each match in a bracket.
 * Fallback is a light rising two-note, distinct from the descending end cadence.
 */
export function playChessGameStart(): void {
  if (playSample(CHESS_SFX.gameStart, 0.5)) return;
  knock({ freq: 1200, q: 2.5, dur: 0.05, gain: 0.07 });
  tones([
    { f: 329.63, t: 0.03, dur: 0.16, type: "sine", gain: 0.08 }, // E4
    { f: 493.88, t: 0.14, dur: 0.24, type: "sine", gain: 0.08 }, // B4
  ]);
}

/** Checkmate, or a game decided on the clock. A short, settled two-note cadence. */
export function playChessGameEnd(): void {
  if (playSample(CHESS_SFX.gameEnd, 0.5)) return;

  knock({ freq: 900, q: 2, dur: 0.07, gain: 0.09 });
  tones([
    { f: 261.63, t: 0.02, dur: 0.28, type: "sine", gain: 0.1 }, // C4
    { f: 392.0, t: 0.16, dur: 0.4, type: "sine", gain: 0.1 }, // G4
  ]);
}

// A rising major arpeggio for a win. Kept as the original celebratory chime.
export function playWinnerChime(): void {
  tones([
    { f: 523.25, t: 0.0, dur: 0.35, gain: 0.18 }, // C5
    { f: 659.25, t: 0.12, dur: 0.35, gain: 0.18 }, // E5
    { f: 783.99, t: 0.24, dur: 0.35, gain: 0.18 }, // G5
    { f: 1046.5, t: 0.36, dur: 0.45, gain: 0.18 }, // C6
  ]);
}

// A short effect that matches the contest kind, played as the live action lands: a
// crisp chip double-click for poker, a bright think-blip for the Solver, a soft
// two-tone for the Analyst, and a quick pip for World Cup. All are brief and quiet so
// a fast feed stays pleasant, not noisy.
export function playActionSound(kind: string): void {
  switch (kind) {
    case "poker":
      // Two clipped square clicks, like chips settling on the felt.
      tones([
        { f: 660, t: 0.0, dur: 0.05, type: "square", gain: 0.07 },
        { f: 440, t: 0.05, dur: 0.06, type: "square", gain: 0.07 },
      ]);
      break;
    case "analyst":
      // A soft, thoughtful two-tone.
      tones([
        { f: 440, t: 0.0, dur: 0.1, gain: 0.08 },
        { f: 587.33, t: 0.08, dur: 0.12, gain: 0.08 },
      ]);
      break;
    case "worldcup":
      // A quick upward pip, a nod to a ref's whistle.
      tones([{ f: 880, t: 0.0, dur: 0.09, type: "sawtooth", gain: 0.06 }]);
      break;
    case "chess":
      // A quiet move. Callers that know whether the move captured should prefer
      // playChessMove(capture) directly, which is what the live board does.
      playChessMove(false);
      break;
    default:
      // Solver (and any other): a bright rising think-blip.
      tones([
        { f: 520, t: 0.0, dur: 0.07, gain: 0.08 },
        { f: 720, t: 0.05, dur: 0.09, gain: 0.08 },
      ]);
  }
}
