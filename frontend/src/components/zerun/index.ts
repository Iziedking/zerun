export { cx } from "./cx";
export { PopButton } from "./PopButton";
export { StickerCard } from "./StickerCard";
export { Chip, type ChipTone } from "./Chip";
export { CoinStat } from "./CoinStat";
export { ThoughtBubble } from "./ThoughtBubble";
export { ProgressGoo } from "./ProgressGoo";
export { Agent, type AgentVariant, type AgentMood } from "./Agent";
export { SkinnedAgent } from "./SkinnedAgent";
export { Confetti } from "./Confetti";
export { LoadMore } from "./LoadMore";

import type { AgentVariant } from "./Agent";

const VARIANTS: AgentVariant[] = ["violet", "amber", "mint", "cyan", "coral"];

// Stable costume color for an agent from its id, so the same agent always reads
// as the same character across the app.
export function agentVariant(id: number | string): AgentVariant {
  const n = typeof id === "number" ? id : Number(String(id).replace(/\D/g, "")) || 0;
  return VARIANTS[Math.abs(n) % VARIANTS.length];
}
