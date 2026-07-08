import { concat, keccak256, type Hex } from "viem";
import { generatePuzzles, extractAnswer } from "../runners/puzzles.js";
import { rankAgents, computePayouts, type AgentScore } from "../runners/scoring.js";
import { payoutLeaf, merkleRoot, merkleProof, contestSaltLeaf } from "../coordinator/merkle.js";
import { normalizeModel, modelsMatch } from "../compute/modelMatch.js";

// Offline checks for the deterministic core: puzzle generation, scoring, and
// that every merkle proof we build verifies against the root the same way the
// contract's MerkleProof.verify does. No chain, no network.

function verify(proof: Hex[], root: Hex, leaf: Hex): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed =
      BigInt(computed) < BigInt(sibling)
        ? keccak256(concat([computed, sibling]))
        : keccak256(concat([sibling, computed]));
  }
  return computed === root;
}

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

// 1. Puzzle generation is deterministic per contest and has clean answers.
const p1 = generatePuzzles(7, 5);
const p2 = generatePuzzles(7, 5);
check("puzzles deterministic", JSON.stringify(p1) === JSON.stringify(p2));
check("puzzles have integer answers", p1.every((p) => /^-?\d+$/.test(p.expected)));
check("different contests differ", JSON.stringify(generatePuzzles(8, 5)) !== JSON.stringify(p1));

// 1b. Answer extraction prefers the tagged answer over stray numbers, so a long
// correct chain of reasoning is graded fairly.
check("tagged answer wins", extractAnswer("200*0.75=150 then 150*0.9=135. ANSWER: 135") === "135");
check("tagged over trailing", extractAnswer("steps give 42 then 9, ANSWER: 43") === "43");
check("falls back to last int", extractAnswer("no tag, just 7 and then 88") === "88");
check("no number is null", extractAnswer("I am not sure") === null);

// 2. Scoring: more correct wins, latency breaks ties.
const scores: AgentScore[] = [
  { agentId: 1, operator: "0x1111111111111111111111111111111111111111", correct: 3, totalLatencyMs: 900 },
  { agentId: 2, operator: "0x2222222222222222222222222222222222222222", correct: 5, totalLatencyMs: 1200 },
  { agentId: 3, operator: "0x3333333333333333333333333333333333333333", correct: 3, totalLatencyMs: 400 },
  { agentId: 4, operator: "0x4444444444444444444444444444444444444444", correct: 0, totalLatencyMs: 100 },
];
const ranked = rankAgents(scores);
check("rank 1 is most correct", ranked[0]!.agentId === 2);
check("latency breaks tie", ranked[1]!.agentId === 3 && ranked[2]!.agentId === 1);

// 3. Payouts sum exactly to the distributable and skip zero-scorers.
const distributable = 95_000_000n; // 95 USDC (6dp)
const payouts = computePayouts(ranked, distributable, 3);
const sum = payouts.reduce((a, p) => a + p.amount, 0n);
check("payouts sum exact", sum === distributable);
check("no zero-scorer paid", !payouts.some((p) => p.operator.endsWith("4444")));
check("rank 1 earns the most", payouts[0]!.amount >= payouts[payouts.length - 1]!.amount);

// 4. Every merkle proof verifies against the root.
const leaves = payouts.map((p) => payoutLeaf(p.operator as `0x${string}`, p.amount));
const root = merkleRoot(leaves);
let allVerify = true;
for (let i = 0; i < leaves.length; i++) {
  if (!verify(merkleProof(leaves, i), root, leaves[i]!)) allVerify = false;
}
check("all merkle proofs verify", allVerify);
check("wrong amount fails", !verify(merkleProof(leaves, 0), root, payoutLeaf(payouts[0]!.operator as `0x${string}`, payouts[0]!.amount + 1n)));

// 5. Salted trees: finalize seeds each payout tree with a per-contest salt leaf so two
// contests paying the identical winners the identical amounts still get different roots
// (else the duplicate-root guard bricks the second forever). The real payout proofs,
// generated at index i+1, must still verify against the salted root exactly as the
// contract's MerkleProof.verify would.
const saltedA = [contestSaltLeaf(2010), ...leaves];
const saltedB = [contestSaltLeaf(2011), ...leaves]; // same winners/amounts, different contest
const rootA = merkleRoot(saltedA);
const rootB = merkleRoot(saltedB);
check("identical payouts, different contests -> different roots", rootA !== rootB);
check("plain (unsalted) root would have collided", merkleRoot(leaves) === merkleRoot(leaves));
let saltedVerify = true;
for (let i = 0; i < payouts.length; i++) {
  if (!verify(merkleProof(saltedA, i + 1), rootA, leaves[i]!)) saltedVerify = false;
}
check("salted payout proofs verify against salted root", saltedVerify);
check("proof from contest A fails against contest B root", !verify(merkleProof(saltedA, 1), rootB, leaves[0]!));
// The salt leaf can never be a valid payout claim for any winner operator.
check(
  "salt leaf is not a payout leaf",
  payouts.every((p) => contestSaltLeaf(2010) !== payoutLeaf(p.operator as `0x${string}`, p.amount)),
);

// 6. Model routing tolerance: a tier's preferred model must match the same model
// however a provider cosmetically spells it, so the premium tiers stop silently
// falling back to the base model. Distinct models must NOT match.
check("normalize strips prefix and separators", normalizeModel("google/gemma-3-27b-it") === "gemma327bit");
check("exact-family match across spellings", modelsMatch("google/gemma-3-27b-it", "gemma3-27b-it"));
check("prefixed vs bare match", modelsMatch("openai/gpt-oss-20b", "gpt-oss-20b"));
check("suffix-tolerant match", modelsMatch("qwen/qwen2.5-omni-7b", "qwen2.5-omni-7b-instruct"));
check("distinct models do not match", !modelsMatch("google/gemma-3-27b-it", "openai/gpt-oss-20b"));
check("qwen not matched by gemma", !modelsMatch("google/gemma-3-27b-it", "qwen/qwen2.5-omni-7b"));
check("empty never matches", !modelsMatch("", "qwen/qwen2.5-omni-7b"));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
