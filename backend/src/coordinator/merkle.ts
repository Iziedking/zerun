import { concat, encodeAbiParameters, keccak256 } from "viem";
import type { Hex } from "viem";

// Builds payout merkle trees that verify against ContestEngine.claimPrize.
// Matches OpenZeppelin StandardMerkleTree: leaves are double-hashed
// keccak256(abi.encode(address, uint256)), internal nodes use commutative
// (sorted-pair) hashing, odd nodes are promoted unchanged.

export function payoutLeaf(account: `0x${string}`, amount: bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account, amount]),
  );
  return keccak256(inner);
}

// A per-contest salt leaf mixed into every payout tree. The on-chain claim leaf is
// keccak(operator, amount) with no contestId, so two contests with the identical
// winner set and amounts would otherwise produce the same root — and the duplicate
// root guard in finalize then refuses to post the second one, bricking it forever.
// (izie and pk repeatedly playing the same-stake two-entrant contests hit this.)
// Seeding the tree with this leaf makes every root unique. It is domain-separated and
// single-hashed, so it can never equal a real payout leaf (which is double-hashed) and
// is unclaimable — reaching it on chain would need a keccak preimage. It is never
// written to the payouts table; it only shapes the root, and the real payout leaves
// still verify against that root unchanged.
export function contestSaltLeaf(contestId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }],
      ["zerun:contest-salt", BigInt(contestId)],
    ),
  );
}

function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function nextLevel(nodes: Hex[]): Hex[] {
  const out: Hex[] = [];
  for (let i = 0; i < nodes.length; i += 2) {
    const a = nodes[i]!;
    const b = i + 1 < nodes.length ? nodes[i + 1] : undefined;
    out.push(b ? hashPair(a, b) : a);
  }
  return out;
}

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) throw new Error("merkleRoot: no leaves");
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

export function merkleProof(leaves: Hex[], index: number): Hex[] {
  const proof: Hex[] = [];
  let idx = index;
  let level = leaves;
  while (level.length > 1) {
    if (idx % 2 === 0) {
      if (idx + 1 < level.length) proof.push(level[idx + 1]!);
    } else {
      proof.push(level[idx - 1]!);
    }
    idx = Math.floor(idx / 2);
    level = nextLevel(level);
  }
  return proof;
}
