// Single-elimination bracket for a chess tournament (up to 8 agents). Pure and
// self-contained: it seeds players by strength, produces the rounds, advances winners,
// and computes final placements (used for the prize split and the room UI). No engine,
// no chain — the tournament runner drives it by playing each pending match and reporting
// the winner. Unit-tested in chessPerft.ts.

export interface Seedable {
  agentId: number;
  tier: number; // higher = stronger, seeded to meet late
}

export interface BracketMatch {
  round: number; // 0 = first round (QF for 8), last round = final
  index: number; // match index within the round
  a: number | null; // agentId, or null until fed by a prior round
  b: number | null;
  winner: number | null; // agentId once decided
}

export interface Bracket {
  size: number; // padded to a power of two
  rounds: BracketMatch[][];
}

// Standard seeding position order for a power-of-two bracket, so the top seeds only meet
// in the later rounds (1 plays the weakest, and 1 and 2 can only meet in the final).
function seedOrder(size: number): number[] {
  let order = [0];
  while (order.length < size) {
    const next: number[] = [];
    const pairSum = order.length * 2 - 1;
    for (const s of order) {
      next.push(s);
      next.push(pairSum - s);
    }
    order = next;
  }
  return order;
}

// Build the bracket from the field. Players are seeded by tier (strongest first), then
// placed into the standard bracket slots; a field smaller than the next power of two
// gets byes (null opponents that auto-advance).
export function buildBracket(players: Seedable[]): Bracket {
  const seeded = [...players].sort((a, b) => b.tier - a.tier || a.agentId - b.agentId);
  let size = 1;
  while (size < seeded.length) size *= 2;
  size = Math.max(2, size);

  const order = seedOrder(size);
  const slots: (number | null)[] = order.map((seed) => seeded[seed]?.agentId ?? null);

  const rounds: BracketMatch[][] = [];
  const first: BracketMatch[] = [];
  for (let i = 0; i < size / 2; i++) {
    const a = slots[i * 2] ?? null;
    const b = slots[i * 2 + 1] ?? null;
    // A bye (one side null) auto-advances the present player.
    const winner = a !== null && b === null ? a : b !== null && a === null ? b : null;
    first.push({ round: 0, index: i, a, b, winner });
  }
  rounds.push(first);

  let count = size / 2;
  let round = 1;
  while (count > 1) {
    count /= 2;
    const matches: BracketMatch[] = [];
    for (let i = 0; i < count; i++) matches.push({ round, index: i, a: null, b: null, winner: null });
    rounds.push(matches);
    round += 1;
  }
  propagateByes(rounds);
  return { size, rounds };
}

// Feed any already-decided winners (including byes) into the next round's slots.
function propagateByes(rounds: BracketMatch[][]): void {
  for (let r = 0; r < rounds.length - 1; r++) {
    for (const m of rounds[r]!) {
      if (m.winner !== null) feedForward(rounds, r, m.index, m.winner);
    }
  }
}

function feedForward(rounds: BracketMatch[][], round: number, index: number, winner: number): void {
  const next = rounds[round + 1];
  if (!next) return;
  const slot = next[Math.floor(index / 2)]!;
  if (index % 2 === 0) slot.a = winner;
  else slot.b = winner;
}

// The next match that is ready to play (both sides known, no winner yet), or null if the
// tournament is complete.
export function nextMatch(bracket: Bracket): BracketMatch | null {
  for (const round of bracket.rounds) {
    for (const m of round) {
      if (m.winner === null && m.a !== null && m.b !== null) return m;
    }
  }
  return null;
}

// Record a match result and advance the winner into the next round.
export function recordResult(bracket: Bracket, round: number, index: number, winner: number): void {
  const m = bracket.rounds[round]?.[index];
  if (!m) return;
  m.winner = winner;
  feedForward(bracket.rounds, round, index, winner);
}

export function isComplete(bracket: Bracket): boolean {
  const final = bracket.rounds[bracket.rounds.length - 1]?.[0];
  return Boolean(final && final.winner !== null);
}

export function champion(bracket: Bracket): number | null {
  return bracket.rounds[bracket.rounds.length - 1]?.[0]?.winner ?? null;
}

// Final placement for every agent: 1 = champion, 2 = runner-up, then tied by the round
// they were eliminated in (semifinal losers share 3rd, quarterfinal losers share 5th).
// Used for the prize split and the bracket UI.
export function placements(bracket: Bracket): { agentId: number; place: number }[] {
  const out: { agentId: number; place: number }[] = [];
  const nRounds = bracket.rounds.length;
  const champ = champion(bracket);
  if (champ !== null) out.push({ agentId: champ, place: 1 });

  for (let r = 0; r < nRounds; r++) {
    // Losers eliminated in round r share the place just below the number of players who
    // reached round r+1. Final (r = last) contributes the runner-up at place 2.
    const survivors = bracket.size / Math.pow(2, r + 1); // players advancing past round r
    const place = survivors + 1;
    for (const m of bracket.rounds[r]!) {
      if (m.winner === null) continue;
      const loser = m.a === m.winner ? m.b : m.a;
      if (loser !== null) out.push({ agentId: loser, place });
    }
  }
  return out.sort((a, b) => a.place - b.place);
}
