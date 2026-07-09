import { formatEther } from "viem";
import { callModel } from "../../compute/client.js";
import { computePlan } from "../computeLevels.js";

// Whether to buy the next tier of an opponent's dossier.
//
// This is the agent deciding how to spend its own money, so the decision is made on 0G by
// the agent's own tier model — the base qwen for levels 0-3, a stronger model above. The
// prompt states the rules plainly (what each tier reveals, what it costs, what the agent
// can afford, how many tiers its Compute level permits) so the model can weigh the edge
// against the price rather than guess.
//
// The bias is deliberate: BUY when the read would plausibly change how it plays. An agent
// that hoards its 0G and plays blind against an opponent it could have scouted is playing
// badly, and the system prompt says so. But it must not spend on a read it cannot use, so
// "no history to scout" and "already know enough" are real answers.

const SYSTEM =
  "You are an AI poker agent about to play a heads-up duel, deciding whether to spend your own 0G " +
  "on the next tier of a scouting dossier about your opponent.\n\n" +
  "The rules, exactly:\n" +
  "- Tier 1 is a coarse read: their style and looseness as bands, no exact numbers.\n" +
  "- Tier 2 adds the real numbers: raise-to-call ratio, fold frequency, hands and duels. " +
  "This is the first tier that lets you tune your strategy against them mechanically.\n" +
  "- Tier 3 adds their showdown profile: how often they shove, how often they win at showdown.\n" +
  "- A dossier is never the full picture. You can never learn as much about them as they know about themselves.\n" +
  "- Your Compute level caps how many tiers you may ever buy against one opponent. You cannot exceed it.\n" +
  "- Each tier costs more than the last. Spending leaves less for the memory you reason with.\n\n" +
  "Take the edge when it is worth taking. A read you can act on is worth paying for, and playing blind " +
  "against an opponent you could have scouted is a mistake. But do not buy a tier whose information you " +
  "cannot use, and do not buy when there is no history to read.\n\n" +
  "Answer with exactly one word on the first line: BUY or SKIP. Then one short sentence of reasoning.";

export interface ScoutDecision {
  buy: boolean;
  reason: string;
  model: string;
  chatID: string | null;
}

// Parse the verdict from the first line. Anything that is not a clear BUY is a SKIP: the
// agent's money, so ambiguity resolves toward not spending it.
function parseVerdict(text: string): { buy: boolean; reason: string } {
  const lines = text.trim().split("\n");
  const head = (lines[0] ?? "").trim().toUpperCase();
  const buy = /^BUY\b/.test(head);
  const reason = lines.slice(1).join(" ").trim() || (buy ? "sees an edge worth paying for" : "holds its 0G");
  return { buy, reason: reason.slice(0, 140) };
}

export async function decideBuyDossier(params: {
  tier: number; // the tier being offered (1-based)
  cap: number; // how many tiers this agent's Compute level allows
  priceWei: bigint;
  balanceWei: bigint;
  known: string; // what the agent already knows: the tiers it has bought so far, or "nothing"
  opponentName: string;
  tierModelLevel: number;
}): Promise<ScoutDecision> {
  const plan = computePlan(params.tierModelLevel);
  const prompt = [
    `Opponent: ${params.opponentName}.`,
    `What you already know about them: ${params.known}`,
    `On offer: dossier tier ${params.tier} of ${params.cap} your Compute level allows.`,
    `Price: ${formatEther(params.priceWei)} 0G. Your balance: ${formatEther(params.balanceWei)} 0G.`,
    `Buy it?`,
  ].join("\n");

  try {
    const res = await callModel({
      systemPrompt: SYSTEM,
      userPrompt: prompt,
      maxTokens: 80,
      temperature: 0.3,
      models: plan.models,
    });
    const { buy, reason } = parseVerdict(res.text ?? "");
    return { buy, reason, model: res.model, chatID: res.chatID };
  } catch {
    // 0G unavailable: do not spend the agent's money on a decision it never made. Tier 1
    // is the exception — it is the cheapest read and an agent with no information at all
    // is strictly worse off, so take it and let the deterministic path use it.
    return {
      buy: params.tier === 1,
      reason: "0G unavailable; fell back to the standing rule",
      model: "fallback",
      chatID: null,
    };
  }
}
