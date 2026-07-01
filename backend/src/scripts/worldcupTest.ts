import { tallyForecasts, type Forecast } from "../runners/worldcup.js";
import { rankAgents, type AgentScore } from "../runners/scoring.js";
import { canResearch, freeAllotment } from "../runners/worldcupIntel.js";

// Pure checks for World Cup mission grading: forecasts are graded against the real
// outcomes into correct-call counts, and the field ranks the same way the rest of the
// arena does (most correct, then bigger 0G investment, then faster). No DB or network.

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass += 1;
    console.log(`ok    ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}`);
  }
}

// Two markets: idx 0 resolves Yes (winnerIndex 0), idx 1 resolves No (winnerIndex 1).
const outcomes = [
  { marketIdx: 0, winnerIndex: 0 },
  { marketIdx: 1, winnerIndex: 1 },
];

// Agent 1 nails both (0.8 -> Yes correct, 0.2 -> No correct).
// Agent 2 gets one (0.9 -> Yes correct, 0.7 -> Yes wrong on a No market).
// Agent 3 forecasts nothing usable (null) -> zero correct, but latency still counts.
const forecasts: Forecast[] = [
  { agentId: 1, marketIdx: 0, probYes: 0.8, latencyMs: 100 },
  { agentId: 1, marketIdx: 1, probYes: 0.2, latencyMs: 100 },
  { agentId: 2, marketIdx: 0, probYes: 0.9, latencyMs: 100 },
  { agentId: 2, marketIdx: 1, probYes: 0.7, latencyMs: 100 },
  { agentId: 3, marketIdx: 0, probYes: null, latencyMs: 50 },
  { agentId: 3, marketIdx: 1, probYes: null, latencyMs: 50 },
];

const tally = tallyForecasts(forecasts, outcomes);
ok(tally.get(1)?.correct === 2, "agent that called both correctly scores 2");
ok(tally.get(2)?.correct === 1, "agent that called one correctly scores 1");
ok(tally.get(3)?.correct === 0, "agent with no usable forecast scores 0");
ok(tally.get(3)?.totalLatencyMs === 100, "latency still accumulates for null forecasts");
ok((tally.get(1)?.totalLatencyMs ?? 0) === 200, "latency sums across markets");

// Exactly 0.5 is treated as leaning Yes, so it is correct on a Yes market.
const edge = tallyForecasts([{ agentId: 9, marketIdx: 0, probYes: 0.5, latencyMs: 0 }], outcomes);
ok(edge.get(9)?.correct === 1, "prob exactly 0.5 counts as a Yes call");

// Ranking: build scores from the tally and confirm the order, with a compute-level
// tiebreak when two agents have the same correct count.
const scores: AgentScore[] = [1, 2, 3].map((id) => {
  const t = tally.get(id)!;
  return { agentId: id, operator: `0x${id}`, correct: t.correct, totalLatencyMs: t.totalLatencyMs, computeLevel: 0 };
});
const ranked = rankAgents(scores);
ok(ranked[0]!.agentId === 1, "most correct calls ranks first");

const tie: AgentScore[] = [
  { agentId: 10, operator: "0xa", correct: 1, totalLatencyMs: 100, computeLevel: 5 },
  { agentId: 11, operator: "0xb", correct: 1, totalLatencyMs: 100, computeLevel: 1 },
];
const rankedTie = rankAgents(tie);
ok(rankedTie[0]!.agentId === 10, "a tie on correct breaks to the higher compute level");

// Tiered intel access: research is a tier-3-and-up capability, and the free allotment
// steps up with the 0G investment (tier 5 unlimited).
ok(!canResearch(0) && !canResearch(2), "tiers 0-2 have no research capability");
ok(canResearch(3) && canResearch(5), "tiers 3+ can research");
ok(freeAllotment(2) === 0, "tier 2 gets no free intel");
ok(freeAllotment(3) === 1, "tier 3 gets one free intel per mission");
ok(freeAllotment(4) === 3, "tier 4 gets three free intel per mission");
ok(freeAllotment(5) === Number.POSITIVE_INFINITY, "tier 5 has unlimited free intel");

console.log(`\n${fail === 0 ? "all worldcup checks passed" : `${fail} check(s) failed`} (${pass}/${pass + fail})`);
if (fail > 0) process.exit(1);
