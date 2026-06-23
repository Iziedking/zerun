import { query } from "../db/pool.js";
import { rollTraits, type Traits } from "./traits.js";

// The agent's compute level: the single 0G-funded skill dial. Every agent starts
// at 0 (identical at claim); training with 0G raises it.
export async function getAgentCompute(agentId: number): Promise<number> {
  const { rows } = await query<{ compute_level: number }>(
    "select compute_level from agents_meta where agent_id = $1",
    [agentId],
  );
  return rows[0]?.compute_level ?? 0;
}

// Traits live in the database (anchored into the 0G Storage audit per contest).
// The first time an agent competes, its genome is rolled from its id and saved,
// so it is stable from then on and training can build on it.
export async function getAgentTraits(agentId: number): Promise<Traits> {
  const { rows } = await query<{
    trait_precision: number | null;
    trait_focus: number | null;
    trait_speed: number | null;
    trait_resilience: number | null;
  }>(
    "select trait_precision, trait_focus, trait_speed, trait_resilience from agents_meta where agent_id = $1",
    [agentId],
  );
  const r = rows[0];
  if (r && r.trait_precision != null && r.trait_focus != null && r.trait_speed != null && r.trait_resilience != null) {
    return {
      precision: r.trait_precision,
      focus: r.trait_focus,
      speed: r.trait_speed,
      resilience: r.trait_resilience,
    };
  }

  const t = rollTraits(agentId);
  await query(
    `update agents_meta set trait_precision = $2, trait_focus = $3, trait_speed = $4, trait_resilience = $5
       where agent_id = $1`,
    [agentId, t.precision, t.focus, t.speed, t.resilience],
  );
  return t;
}
