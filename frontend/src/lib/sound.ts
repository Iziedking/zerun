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
    default:
      // Solver (and any other): a bright rising think-blip.
      tones([
        { f: 520, t: 0.0, dur: 0.07, gain: 0.08 },
        { f: 720, t: 0.05, dur: 0.09, gain: 0.08 },
      ]);
  }
}
