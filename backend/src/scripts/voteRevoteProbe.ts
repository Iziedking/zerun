import { ethers } from "ethers";

// Can a wallet that already voted cast a SECOND castVote (i.e. upgrade a plain vote to a boost)?
//
// This is read-only. It never sends a transaction. It finds a wallet that already voted, then
// uses eth_call to SIMULATE that same wallet calling castVote again. If the simulation reverts,
// the contract blocks re-voting and a plain vote is locked forever. If it succeeds, a plain
// voter can come back and boost, and the recovery flow is worth building.
//
//   npx tsx src/scripts/voteRevoteProbe.ts

const RPC = process.env.VOTE_GAS_RPC_URL || process.env.COMPUTE_MAINNET_RPC_URL || "https://evmrpc.0g.ai";
const CONTRACT = process.env.ZERO_CUP_CONTRACT ?? "0x46bB4fFd3F61d59126ca1814B7c57FFF1db0a65B";
const SELECTOR = "0xb4b0713e"; // castVote(bytes32 candidateId, uint256 weight)

const LOOKBACK = Number(process.env.ZERO_CUP_LOOKBACK ?? "200000");
const CHUNK = Number(process.env.ZERO_CUP_CHUNK ?? "40000");

const pad32 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const head = await provider.getBlockNumber();
  const from = Math.max(0, head - LOOKBACK);

  // Find one real voter and the candidate they voted for.
  let voter: string | null = null;
  let candidate: string | null = null;
  let weight = 0;
  for (let start = head; start >= from && !voter; start -= CHUNK) {
    const logs = await provider.getLogs({
      address: CONTRACT,
      fromBlock: Math.max(from, start - CHUNK + 1),
      toBlock: start,
    });
    for (const l of logs) {
      if (l.topics.length < 3) continue;
      voter = `0x${l.topics[1]!.slice(-40)}`;
      candidate = `0x${pad32(l.topics[2]!)}`;
      weight = Number(BigInt(l.data.slice(0, 66)));
      break;
    }
  }

  if (!voter || !candidate) {
    console.log("no votes found in the scanned window; cannot probe.");
    return;
  }

  console.log(`\nprobe: does the Zero Cup contract allow a second vote?\n`);
  console.log(`  contract    ${CONTRACT}`);
  console.log(`  test voter  ${voter}  (already voted, weight ${weight})`);
  console.log(`  candidate   ${candidate.slice(0, 18)}…`);

  const ZERUN = "cca28a9fddc8ecbee7b1bb4b6b2ee4968e8d1b63182d1989ea2607d20d425f4c";

  // Simulate this same wallet voting AGAIN, as a boost (weight 2), for the same candidate.
  const data = SELECTOR + pad32(candidate) + pad32("0x2");
  try {
    await provider.call({ from: voter, to: CONTRACT, data });
    console.log(`\n  RE-VOTE: eth_call SUCCEEDED — the contract accepts a second vote.`);
    console.log(`           A plain voter CAN come back and boost. Recovery flow is worth building.`);
  } catch (err) {
    const msg = (err as Error).message;
    console.log(`\n  RE-VOTE: eth_call REVERTED — the contract blocks a second vote.`);
    console.log(`           A plain vote is locked forever. No upgrade is possible.`);
    console.log(`           revert: ${msg.slice(0, 120)}`);
  }

  // Now a fresh, never-voted address voting for Zerun. If THIS succeeds, the revert above is
  // specifically an already-voted guard (not a closed poll), which makes eth_call a clean
  // "can this wallet still vote?" oracle we can use to stop the faucet funding dead wallets.
  const fresh = "0x000000000000000000000000000000000000dEaD";
  const freshData = SELECTOR + pad32(ZERUN) + pad32("0x2");
  try {
    await provider.call({ from: fresh, to: CONTRACT, data: freshData });
    console.log(`\n  FRESH:   eth_call SUCCEEDED — poll is open and the guard is per-voter.`);
    console.log(`           eth_call is a valid fundability oracle: revert = already voted = do not fund.\n`);
  } catch (err) {
    console.log(`\n  FRESH:   eth_call REVERTED — ${(err as Error).message.slice(0, 120)}`);
    console.log(`           A fresh wallet cannot simulate a vote either; oracle is NOT safe to use.\n`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("probe failed:", (e as Error).message);
    process.exit(1);
  });
