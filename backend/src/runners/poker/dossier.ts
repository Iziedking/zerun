import { query } from "../../db/pool.js";
import { storageConfigured, uploadJson } from "../../storage/zgStorage.js";

// Opponent dossiers: how an agent tends to play, accumulated from its past duels.
// Stats live in the poker_stats table (fast to read before a match) and a snapshot
// is mirrored to 0G Storage so the scouting data is owned and provable. Another
// agent buys and reads the dossier as edge information before a duel.

export interface PokerStats {
  agentId: number;
  hands: number;
  folds: number;
  checks: number;
  calls: number;
  raises: number;
  allins: number;
  showdowns: number;
  showdownsWon: number;
  duels: number;
  duelsWon: number;
}

interface MatchAction {
  seat: number;
  action: string; // the applied action label, e.g. "raises to 60"
  allin?: boolean;
}
interface MatchHand {
  actions: MatchAction[];
  result?: { winner: number | null; showdown: boolean } | null;
}

function actionType(label: string): "fold" | "check" | "call" | "raise" | null {
  if (label.startsWith("folds")) return "fold";
  if (label.startsWith("checks")) return "check";
  if (label.startsWith("calls")) return "call";
  if (label.startsWith("raises")) return "raise";
  return null;
}

const zero = (agentId: number): PokerStats => ({
  agentId,
  hands: 0,
  folds: 0,
  checks: 0,
  calls: 0,
  raises: 0,
  allins: 0,
  showdowns: 0,
  showdownsWon: 0,
  duels: 0,
  duelsWon: 0,
});

// Accumulate one finished duel into both agents' records, then mirror each updated
// dossier to 0G Storage. seatAgent maps seat 0/1 to its agent id; winnerSeat is who
// had more chips at the end (null on a dead-even match).
export async function recordDuel(
  hands: MatchHand[],
  seatAgent: [number, number],
  winnerSeat: number | null,
): Promise<void> {
  const inc: [PokerStats, PokerStats] = [zero(seatAgent[0]), zero(seatAgent[1])];
  for (const seat of [0, 1] as const) {
    inc[seat].duels = 1;
    if (winnerSeat === seat) inc[seat].duelsWon = 1;
  }
  for (const hand of hands) {
    inc[0].hands += 1;
    inc[1].hands += 1;
    for (const a of hand.actions ?? []) {
      const seat = a.seat === 1 ? 1 : 0;
      const t = actionType(a.action);
      if (t === "fold") inc[seat].folds += 1;
      else if (t === "check") inc[seat].checks += 1;
      else if (t === "call") inc[seat].calls += 1;
      else if (t === "raise") inc[seat].raises += 1;
      if (a.allin) inc[seat].allins += 1;
    }
    if (hand.result?.showdown) {
      inc[0].showdowns += 1;
      inc[1].showdowns += 1;
      if (hand.result.winner === 0) inc[0].showdownsWon += 1;
      else if (hand.result.winner === 1) inc[1].showdownsWon += 1;
    }
  }

  for (const seat of [0, 1] as const) {
    await upsertStats(inc[seat]).catch((err) =>
      console.error(`poker dossier: stats update for agent ${inc[seat].agentId} failed:`, (err as Error).message),
    );
    await snapshotDossier(inc[seat].agentId).catch(() => {});
  }
}

async function upsertStats(inc: PokerStats): Promise<void> {
  await query(
    `insert into poker_stats
       (agent_id, hands, folds, checks, calls, raises, allins, showdowns, showdowns_won, duels, duels_won, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (agent_id) do update set
       hands = poker_stats.hands + excluded.hands,
       folds = poker_stats.folds + excluded.folds,
       checks = poker_stats.checks + excluded.checks,
       calls = poker_stats.calls + excluded.calls,
       raises = poker_stats.raises + excluded.raises,
       allins = poker_stats.allins + excluded.allins,
       showdowns = poker_stats.showdowns + excluded.showdowns,
       showdowns_won = poker_stats.showdowns_won + excluded.showdowns_won,
       duels = poker_stats.duels + excluded.duels,
       duels_won = poker_stats.duels_won + excluded.duels_won,
       updated_at = now()`,
    [
      inc.agentId, inc.hands, inc.folds, inc.checks, inc.calls, inc.raises,
      inc.allins, inc.showdowns, inc.showdownsWon, inc.duels, inc.duelsWon,
    ],
  );
}

export async function readPokerStats(agentId: number): Promise<PokerStats | null> {
  const { rows } = await query<{
    hands: number; folds: number; checks: number; calls: number; raises: number;
    allins: number; showdowns: number; showdowns_won: number; duels: number; duels_won: number;
  }>(
    `select hands, folds, checks, calls, raises, allins, showdowns, showdowns_won, duels, duels_won
       from poker_stats where agent_id = $1`,
    [agentId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    agentId,
    hands: r.hands, folds: r.folds, checks: r.checks, calls: r.calls, raises: r.raises,
    allins: r.allins, showdowns: r.showdowns, showdownsWon: r.showdowns_won,
    duels: r.duels, duelsWon: r.duels_won,
  };
}

// Plain-language scouting note derived from the stats. Deterministic, so the same
// history always reads the same way.
export function summarizeDossier(s: PokerStats): string {
  const decisions = s.folds + s.checks + s.calls + s.raises;
  if (s.hands === 0 || decisions === 0) return "No prior duels on record.";
  const af = s.raises / Math.max(1, s.calls);
  const foldPct = Math.round((s.folds / decisions) * 100);
  const sdWinPct = s.showdowns > 0 ? Math.round((s.showdownsWon / s.showdowns) * 100) : 0;
  const style = af > 1.5 ? "aggressive" : af < 0.6 ? "passive" : "balanced";
  const looseness = foldPct > 40 ? "tight" : foldPct < 15 ? "loose" : "measured";
  return [
    `${s.duels} duels (${s.duelsWon} won), ${s.hands} hands.`,
    `Plays ${looseness} and ${style} (raise-to-call ratio ${af.toFixed(2)}, folds ${foldPct}% of spots).`,
    `Goes all-in ${s.allins} times. Reaches showdown ${s.showdowns} times, winning ${sdWinPct}% of them.`,
  ].join(" ");
}

// Build the dossier another agent would read on this opponent. Null if the opponent
// has no history yet (nothing to scout).
export async function buildDossier(opponentAgentId: number): Promise<{ stats: PokerStats; text: string } | null> {
  const stats = await readPokerStats(opponentAgentId);
  if (!stats || stats.hands === 0) return null;
  return { stats, text: summarizeDossier(stats) };
}

// Mirror an agent's current dossier to 0G Storage and keep its root on the agent, so
// the scouting data is owned and provable. Best effort.
async function snapshotDossier(agentId: number): Promise<void> {
  if (!storageConfigured()) return;
  const stats = await readPokerStats(agentId);
  if (!stats) return;
  const up = await uploadJson({ agentId, stats, text: summarizeDossier(stats) });
  await query("update agents_meta set dossier_root = $2 where agent_id = $1", [agentId, up.rootHash]).catch(() => {});
}
