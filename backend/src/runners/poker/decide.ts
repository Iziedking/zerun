import type { Action, Legal, PlayerView } from "./table.js";

// Turns a poker game view into a 0G Compute prompt, and parses the model's reply
// back into a legal-ish action. Pure and testable: the engine coerces anything
// still illegal, so parsing only needs to be best-effort.

export const POKER_SYSTEM = [
  "You are a sharp, disciplined heads-up No-Limit Texas Hold'em player.",
  "You get one decision at a time. Think about hand strength, position, pot odds,",
  "stack depth, and what your opponent's line represents, then choose one action.",
  "Legal actions are FOLD, CHECK, CALL, RAISE <amount>, or ALLIN. RAISE amount is the",
  "total chips you want your bet for this street to reach.",
  "Reason briefly, then end your reply with a final line in exactly this form:",
  "ACTION: <FOLD|CHECK|CALL|RAISE n|ALLIN>",
].join(" ");

// Build the user prompt from the current view, optionally with a scouting report
// (the opponent dossier) that the agent has bought.
export function buildUserPrompt(view: PlayerView, dossier?: string): string {
  const L = view.legal;
  const options: string[] = ["FOLD"];
  if (L.canCheck) options.push("CHECK");
  if (L.canCall) options.push(`CALL ${L.callAmount}`);
  if (L.canRaise) options.push(`RAISE ${L.minRaiseTo}..${L.maxRaiseTo} (ALLIN = ${L.maxRaiseTo})`);

  const lines = [
    `You are seat ${view.seat} in a heads-up No-Limit Hold'em hand.`,
    `Street: ${view.street}. Your hole cards: ${view.holeCards}. Board: ${view.board || "(none yet)"}.`,
    `Your stack: ${view.myStack}. Opponent stack: ${view.oppStack}. Pot: ${view.pot}. To call: ${view.toCall}.`,
    `Legal actions: ${options.join(", ")}.`,
    `Action so far this hand: ${view.history.slice(1).join("; ") || "(none)"}.`,
  ];
  if (dossier && dossier.trim()) {
    lines.push(`Scouting report on your opponent (edge information you paid for): ${dossier.trim()}`);
  }
  lines.push("Decide the single best action now.");
  lines.push("End with: ACTION: <FOLD|CHECK|CALL|RAISE n|ALLIN>");
  return lines.join("\n");
}

// Parse a model reply into an action. Prefers the trailing "ACTION:" line, then
// falls back to scanning the whole text. The caller passes the legal set so ALLIN
// and a bare RAISE map to concrete amounts; the engine still coerces if illegal.
export function parseAction(text: string, legal: Legal): Action {
  const full = (text ?? "").toLowerCase();
  // Use the LAST "action:" directive (the model's final decision), not an earlier
  // mention buried in a long chain of reasoning. This matters most for high-token
  // agents, whose lengthy reasoning would otherwise mis-parse.
  const matches = [...full.matchAll(/action:\s*([^\n]+)/gi)];
  const seg = matches.length ? matches[matches.length - 1]![1]! : "";
  const fromSegment = seg ? readAction(seg, legal) : null;
  if (fromSegment) return fromSegment;
  // Fallback: read only the tail (the conclusion), not the whole ramble.
  const fromTail = readAction(full.slice(-160), legal);
  if (fromTail) return fromTail;
  return legal.canCheck ? { type: "check" } : { type: "call" };
}

// The self-consistency verdict across several independent reads of the same spot:
// the majority action type wins, and a raise uses the median size. This is the
// compute edge in poker: more passes vote across more diverse reads, so a blunder in
// any single sample is outvoted. Ties prefer the cheaper, lower-variance action.
export function consensusAction(actions: Action[]): Action {
  if (actions.length <= 1) return actions[0] ?? { type: "check" };
  const counts = new Map<Action["type"], number>();
  for (const a of actions) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  let bestType: Action["type"] = "check";
  let bestCount = -1;
  // Tie-break order: stay in cheaply before committing chips or folding a live hand.
  for (const t of ["call", "check", "raise", "fold"] as Action["type"][]) {
    const c = counts.get(t) ?? 0;
    if (c > bestCount) {
      bestType = t;
      bestCount = c;
    }
  }
  if (bestType === "raise") {
    const sizes = actions
      .filter((a): a is { type: "raise"; to: number } => a.type === "raise")
      .map((a) => a.to)
      .sort((x, y) => x - y);
    return { type: "raise", to: sizes[Math.floor(sizes.length / 2)] ?? 0 };
  }
  return { type: bestType };
}

function readAction(s: string, legal: Legal): Action | null {
  if (/\bfold\b/.test(s)) return { type: "fold" };
  if (/\ball[\s-]?in\b|\bshove\b|\bjam\b/.test(s)) return { type: "raise", to: legal.maxRaiseTo };
  const raise = s.match(/\b(?:raise|bet)\b[^\d]*(\d+)/);
  if (raise) return { type: "raise", to: Number(raise[1]) };
  if (/\bcall\b/.test(s)) return { type: "call" };
  if (/\bcheck\b/.test(s)) return { type: "check" };
  return null;
}
