import { ethers } from "ethers";
import { query } from "../db/pool.js";

// What did our vote gas actually buy?
//
// The faucet cannot withhold gas until it knows how someone will vote: they need the gas in
// order to vote at all. So abuse is not preventable, only measurable. It happens to be very
// measurable, because 0G's Zero Cup contract emits one log per vote, keyed by the voter's
// address, and every wallet we funded is in `vote_gas_claims`.
//
// Join the two and you know, per wallet: did they vote, and for whom.
//
//   npx tsx src/scripts/voteAudit.ts
//
// Read-only. Touches no wallet and spends nothing.

const RPC = process.env.VOTE_GAS_RPC_URL || process.env.COMPUTE_MAINNET_RPC_URL || "https://evmrpc.0g.ai";

// 0G's Zero Cup vote contract on 0G mainnet.
//
//   castVote(bytes32 candidateId, uint256 weight)   selector 0xb4b0713e
//   log: topic1 = voter, topic2 = candidateId, data word 0 = weight (1 plain, 2 boosted)
//
// Both weights are paid by the voter: there is no relayer, so a gasless supporter cannot vote
// at all. That is why the faucet exists, and why it cannot wait to see how someone votes before
// funding them. Abuse is therefore not preventable, only measurable. This measures it.
const CONTRACT = process.env.ZERO_CUP_CONTRACT ?? "0x46bB4fFd3F61d59126ca1814B7c57FFF1db0a65B";

// The candidate ids for our quarter-final. Confirmed by finding a wallet we control in the logs.
const ZERUN = (process.env.ZERO_CUP_ZERUN ?? "0xcca28a9fddc8ecbee7b1bb4b6b2ee4968e8d1b63182d1989ea2607d20d425f4c").toLowerCase();
const OPPONENT = (process.env.ZERO_CUP_OPPONENT ?? "0x9328642a13f5b0fc9191c30ab47a46cb4c45bdf6442e8e9a55b8aa3ebdab23e6").toLowerCase();

// How far back to scan. The cup opened well inside this window; raise it if the faucet outlives it.
const LOOKBACK_BLOCKS = Number(process.env.ZERO_CUP_LOOKBACK ?? "200000");
const CHUNK = Number(process.env.ZERO_CUP_CHUNK ?? "40000");

interface Vote {
  voter: string;
  candidate: string;
  weight: number;
}

async function fetchVotes(provider: ethers.JsonRpcProvider): Promise<Vote[]> {
  const head = await provider.getBlockNumber();
  const from = Math.max(0, head - LOOKBACK_BLOCKS);
  const votes: Vote[] = [];
  // Chunked, because a public RPC will refuse an unbounded range.
  for (let start = from; start <= head; start += CHUNK) {
    const logs = await provider.getLogs({
      address: CONTRACT,
      fromBlock: start,
      toBlock: Math.min(head, start + CHUNK - 1),
    });
    for (const l of logs) {
      if (l.topics.length < 3) continue;
      votes.push({
        voter: `0x${l.topics[1]!.slice(-40)}`.toLowerCase(),
        candidate: l.topics[2]!.toLowerCase(),
        weight: Number(BigInt(l.data.slice(0, 66))),
      });
    }
  }
  return votes;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const votes = await fetchVotes(provider);

  const byVoter = new Map<string, Vote>();
  for (const v of votes) byVoter.set(v.voter, v); // a wallet's latest vote wins

  const { rows: claims } = await query<{ address: string; amount_wei: string; tx_hash: string | null }>(
    "select address, amount_wei::text, tx_hash from vote_gas_claims order by created_at asc",
  );

  let forUs = 0;
  let forThem = 0;
  let silent = 0;
  let spentWei = 0n;
  let wastedWei = 0n;
  const traitors: string[] = [];

  for (const c of claims) {
    spentWei += BigInt(c.amount_wei);
    const v = byVoter.get(c.address.toLowerCase());
    if (!v) {
      silent += 1;
      wastedWei += BigInt(c.amount_wei);
    } else if (v.candidate === ZERUN) {
      forUs += 1;
    } else if (v.candidate === OPPONENT) {
      forThem += 1;
      wastedWei += BigInt(c.amount_wei);
      traitors.push(c.address);
    } else {
      // Voted in the other quarter-final. Not against us, just not for us either.
      silent += 1;
      wastedWei += BigInt(c.amount_wei);
    }
  }

  const og = (w: bigint) => Number(ethers.formatEther(w)).toFixed(4);

  console.log(`\nzero cup vote audit  (contract ${CONTRACT.slice(0, 10)}…, ${votes.length} votes on chain)\n`);

  // The public tally, regardless of who funded whom.
  const tally = new Map<string, number>();
  for (const v of byVoter.values()) tally.set(v.candidate, (tally.get(v.candidate) ?? 0) + v.weight);
  console.log(`  weighted tally`);
  console.log(`    Zerun      ${String(tally.get(ZERUN) ?? 0).padStart(5)}`);
  console.log(`    opponent   ${String(tally.get(OPPONENT) ?? 0).padStart(5)}`);
  console.log(`    voters     ${byVoter.size} wallets, ${votes.length} votes\n`);

  if (!claims.length) {
    console.log(`  no gas claimed yet. Nothing to audit.\n`);
    return;
  }

  const pct = (n: number) => `${Math.round((100 * n) / claims.length)}%`;
  console.log(`  what our gas bought  (${claims.length} wallets funded, ${og(spentWei)} 0G spent)`);
  console.log(`    voted for Zerun ....... ${String(forUs).padStart(4)}  ${pct(forUs)}`);
  console.log(`    voted for opponent .... ${String(forThem).padStart(4)}  ${pct(forThem)}   <- funded a vote against us`);
  console.log(`    never voted ........... ${String(silent).padStart(4)}  ${pct(silent)}`);
  console.log(`    wasted ................ ${og(wastedWei)} 0G\n`);

  // The number that decides whether the faucet is worth running.
  const net = forUs - forThem;
  console.log(
    net > 0
      ? `  NET +${net} votes. The faucet is winning; keep it open.`
      : net === 0
        ? `  NET 0 votes. The faucet is paying for a draw. Consider gating it.`
        : `  NET ${net} votes. The faucet is funding the opposition. Set VOTE_GAS=off.`,
  );

  if (traitors.length) {
    console.log(`\n  wallets we funded that voted against us:`);
    for (const t of traitors.slice(0, 20)) console.log(`    ${t}`);
    if (traitors.length > 20) console.log(`    …and ${traitors.length - 20} more`);
  }
  console.log();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("voteAudit failed:", (e as Error).message);
    process.exit(1);
  });
