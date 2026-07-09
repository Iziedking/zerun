import { callModel } from "../../compute/client.js";
import { emptySession, type MemorySession } from "../memoryMarket.js";
import { storageConfigured, uploadJson } from "../../storage/zgStorage.js";
import { query } from "../../db/pool.js";
import { computePlan } from "../computeLevels.js";
import { policyForTier, type Policy } from "./strategy.js";
import type { PokerStats } from "./dossier.js";

// P3 of the poker ladder: the agent's STRATEGY is authored on 0G Compute and anchored
// on 0G Storage. The deterministic engine still grinds the hands at machine speed
// (that is what makes a match always terminate), but the small policy TUNING it grinds
// with is produced by a 0G Compute call routed to the agent's tier model, then uploaded
// to 0G Storage. So "this agent's strategy was authored on 0G" is provable from the
// stored root, and a stronger tier model authors a stronger tuning — the ladder proves
// it. The tuning is bounded (a few small deltas, clamped), so a bad model reply can
// nudge play but never break the strategy or make an illegal move.
//
// Off by default so matches stay instant (each authoring call is one paced 0G request);
// turn on with POKER_0G_POLICY=on to route strategy authoring through 0G.

export function policy0gEnabled(): boolean {
  return (process.env.POKER_0G_POLICY ?? "off").toLowerCase() === "on";
}

const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : 0));

export interface AuthoredPolicy {
  override: Partial<Policy>;
  root: string | null; // 0G Storage root of the authored artifact
  model: string;
  chatID: string | null;
}

const SYSTEM =
  "You are a heads-up No-Limit Hold'em strategy coach. Given a read on the opponent, " +
  "output a small tuning for the bot's play as compact JSON and nothing else: " +
  '{"callMargin": n, "valueBet": n, "bluff": n, "semibluff": n}. ' +
  "callMargin, valueBet and bluff are in [-0.03, 0.03]; semibluff is in [-0.1, 0.1]. " +
  "Positive callMargin calls wider; positive valueBet value-bets thinner; positive bluff " +
  "and semibluff bluff more. Exploit a loose/passive opponent by value-betting thinner and " +
  "calling wider; tighten against an aggressive one. Reply with the JSON only, no prose.";

function summarizeOpponent(opp: PokerStats | null): string {
  const decisions = opp ? opp.folds + opp.checks + opp.calls + opp.raises : 0;
  if (!opp || decisions === 0) return "No prior read on the opponent.";
  const pct = (n: number) => Math.round((n / decisions) * 100);
  return (
    `Opponent over ${opp.hands} hands: folds ${pct(opp.folds)}%, calls ${pct(opp.calls)}%, ` +
    `raises ${pct(opp.raises)}%, all-ins ${opp.allins}, showdowns won ${opp.showdownsWon}/${opp.showdowns}.`
  );
}

function parseAdjust(
  text: string,
): { callMargin: number; valueBet: number; bluff: number; semibluff: number } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    return {
      callMargin: Number(o.callMargin) || 0,
      valueBet: Number(o.valueBet) || 0,
      bluff: Number(o.bluff) || 0,
      semibluff: Number(o.semibluff) || 0,
    };
  } catch {
    return null;
  }
}

// Author a bounded policy tuning on 0G Compute, anchor it on 0G Storage, persist it, and
// return the override for the runner to play with. Returns null on any failure so the
// caller can fall back to the deterministic scouting override.
export async function author0gPolicy(
  contestId: number,
  agentId: number,
  tier: number,
  opp: PokerStats | null,
  memory: MemorySession = emptySession,
): Promise<AuthoredPolicy | null> {
  const plan = computePlan(tier);
  const oppSummary = summarizeOpponent(opp);
  // Poker's memory is the strategy note the agent wrote about its own leaks. It goes into
  // the one 0G call that authors this contest's tuning, which is where it can actually
  // change how the agent plays every hand. `take()` charges for it; "" means the agent
  // could not pay, and it tunes from the opponent read alone, exactly as before.
  const note = memory.take();
  let res: Awaited<ReturnType<typeof callModel>>;
  try {
    res = await callModel({
      systemPrompt: SYSTEM + note,
      userPrompt: `${oppSummary}\nTune your play to exploit this. Reply with the JSON only.`,
      maxTokens: 120,
      temperature: 0.3,
      models: plan.models,
    });
  } catch {
    memory.refund(); // paid for a call that never landed
    return null;
  }
  const adjust = parseAdjust(res.text);
  if (!adjust) return null;

  const base = policyForTier(tier);
  const override: Partial<Policy> = {
    callMarginBase: base.callMarginBase + clamp(adjust.callMargin, -0.03, 0.03),
    valueBet: clamp(base.valueBet + clamp(adjust.valueBet, -0.03, 0.03), 0.4, 0.9),
    cbetBluff: clamp(base.cbetBluff + clamp(adjust.bluff, -0.03, 0.03), 0, 0.25),
    semibluffBet: clamp(base.semibluffBet + clamp(adjust.semibluff, -0.1, 0.1), 0, 0.9),
  };

  // Anchor the authored artifact on 0G Storage so the strategy's provenance is provable.
  let root: string | null = null;
  if (storageConfigured()) {
    try {
      const up = await uploadJson({
        kind: "poker-policy",
        contestId,
        agentId,
        tier,
        model: res.model,
        chatID: res.chatID,
        opponent: oppSummary,
        adjust,
        override,
      });
      root = up.rootHash || null;
    } catch {
      /* storage is best effort; the override still stands */
    }
  }

  await query(
    `insert into poker_policies (agent_id, contest_id, override, storage_root, model, chat_id, created_at)
       values ($1, $2, $3, $4, $5, $6, now())
     on conflict (contest_id, agent_id) do update set
       override = excluded.override, storage_root = excluded.storage_root,
       model = excluded.model, chat_id = excluded.chat_id`,
    [agentId, contestId, JSON.stringify(override), root, res.model, res.chatID],
  ).catch(() => {});

  return { override, root, model: res.model, chatID: res.chatID };
}
