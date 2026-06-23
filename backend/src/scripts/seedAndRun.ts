import { createWalletClient, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { config } from "../config/index.js";
import { query, closePool } from "../db/pool.js";
import { openContest } from "../coordinator/contestOps.js";
import { runContest } from "../coordinator/runContest.js";
import { runAnalystContest } from "../coordinator/runAnalystContest.js";
import {
  CONTEST_TYPE,
  GAS_PRICE,
  agentRegistryAbi,
  contestEngineAbi,
  testUsdcAbi,
  coordinatorWallet,
  coordinatorAccount,
  loadDeployment,
  ogGalileo,
  publicClient,
} from "../chain/contracts.js";

// Spread the field across tiers so the gradient is visible, e.g. 3 agents get
// tiers 0, 2, 4. A higher tier costs more test USDC to reach but thinks better.
function tierSpread(n: number): number[] {
  if (n <= 1) return [2];
  return Array.from({ length: n }, (_, i) => Math.round((i * 4) / (n - 1)));
}

// Friendly agent names so a seeded field reads like real distinct operators,
// not a row of identical test entries.
const NAMES = [
  "Pixel", "Nova", "Byte", "Echo", "Quark", "Volt",
  "Sage", "Riff", "Juno", "Mochi", "Pip", "Cosmo",
];

type Operator = { account: ReturnType<typeof privateKeyToAccount>; wallet: ReturnType<typeof createWalletClient> };

// Seeds a field of agents and runs a contest end to end against the live
// contracts. Each agent is owned by its own throwaway operator wallet, funded
// with a little 0G for gas, so the field looks like real separate operators.
// Use it to drive a demo, or as an on-chain integration check.
//
//   pnpm tsx src/scripts/seedAndRun.ts [agents] [prizeUsdc] [durationSecs] [puzzles] [analyst] [norun]

const AGENTS = Number(process.argv[2] ?? 3);
const PRIZE_USDC = Number(process.argv[3] ?? 50);
const DURATION = Number(process.argv[4] ?? 120);
const PUZZLES = Number(process.argv[5] ?? 4);
// Pass "analyst" anywhere in the args for a prediction-market contest, and
// "norun" to seed the field without running it (so the UI can trigger the run).
const KIND: "solver" | "analyst" = process.argv.includes("analyst") ? "analyst" : "solver";
const RUN = !process.argv.includes("norun");
const TIER_TYPE = KIND === "analyst" ? CONTEST_TYPE.ANALYST : CONTEST_TYPE.SOLVER;

// Buy an agent from tier 0 up to the target: mint the test USDC it costs,
// approve the registry, then upgrade one step at a time.
async function upgradeAgentTo(
  wallet: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  agentId: number,
  target: number,
): Promise<void> {
  const dep = loadDeployment();
  let total = 0n;
  for (let t = 0; t < target; t++) {
    const price = await publicClient.readContract({
      address: dep.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "upgradePrice",
      args: [TIER_TYPE, t],
    });
    total += price;
  }

  const mintHash = await wallet.writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "mint",
    args: [account.address, total],
    account,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  const approveHash = await wallet.writeContract({
    address: dep.testUSDC,
    abi: testUsdcAbi,
    functionName: "approve",
    args: [dep.agentRegistry, total],
    account,
    chain: undefined,
    gasPrice: GAS_PRICE,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  for (let t = 0; t < target; t++) {
    const h = await wallet.writeContract({
      address: dep.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "upgradeAgent",
      args: [BigInt(agentId), TIER_TYPE, t + 1],
      account,
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
}

async function main() {
  const dep = loadDeployment();
  const funder = coordinatorWallet();
  const funderAccount = coordinatorAccount();

  const itemWord = KIND === "analyst" ? "markets" : "puzzles";
  console.log(`opening a ${KIND} contest: ${PRIZE_USDC} tUSDC, ${DURATION}s, ${PUZZLES} ${itemWord}`);
  const contestId = await openContest({
    prizePoolUsdc: PRIZE_USDC,
    durationSecs: DURATION,
    topN: Math.min(3, AGENTS),
    puzzleCount: PUZZLES,
    kind: KIND,
  });
  console.log(`contest ${contestId} open`);

  const operators = new Map<string, Operator>();
  const tiers = tierSpread(AGENTS);

  for (let i = 1; i <= AGENTS; i++) {
    const targetTier = tiers[i - 1] ?? 0;
    const account = privateKeyToAccount(generatePrivateKey());
    const operator = account.address;
    const wallet = createWalletClient({ account, chain: ogGalileo, transport: http(config.chain.rpcUrl) });
    operators.set(operator.toLowerCase(), { account, wallet });

    // Fund the operator with a little 0G for gas. Higher tiers need a few more
    // transactions (mint, approve, upgrade steps), so fund proportionally.
    const fundHash = await funder.sendTransaction({
      to: operator,
      value: parseEther(String(0.006 + 0.006 * targetTier)),
      account: funderAccount,
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });

    // The id the registry will assign next becomes this agent's id.
    const agentId = await publicClient.readContract({
      address: dep.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "nextAgentId",
    });

    const name = NAMES[(i - 1) % NAMES.length] ?? `Agent ${i}`;
    const createHash = await wallet.writeContract({
      address: dep.agentRegistry,
      abi: agentRegistryAbi,
      functionName: "createAgent",
      args: [`zerun:agent:${name}`],
      account,
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await publicClient.waitForTransactionReceipt({ hash: createHash });

    await query(
      `insert into agents_meta (agent_id, owner, name) values ($1,$2,$3)
         on conflict (agent_id) do update set name = excluded.name`,
      [Number(agentId), operator.toLowerCase(), name],
    );

    // Buy the agent up to its target tier so the field has a real skill spread.
    if (targetTier > 0) {
      await upgradeAgentTo(wallet, account, Number(agentId), targetTier);
    }

    const enterHash = await wallet.writeContract({
      address: dep.contestEngine,
      abi: contestEngineAbi,
      functionName: "registerEntry",
      args: [BigInt(contestId), agentId, 0n],
      account,
      chain: undefined,
      gasPrice: GAS_PRICE,
    });
    await publicClient.waitForTransactionReceipt({ hash: enterHash });

    await query(
      `insert into contest_entries (contest_id, agent_id, operator) values ($1,$2,$3)
         on conflict (contest_id, agent_id) do nothing`,
      [contestId, Number(agentId), operator.toLowerCase()],
    );
    console.log(`  ${name} (agent ${agentId}, tier ${targetTier}) entered as ${operator}`);
  }

  await query(
    `update contests_meta set agent_count = (select count(*) from contest_entries where contest_id = $1) where contest_id = $1`,
    [contestId],
  );

  if (!RUN) {
    console.log(`\nfield seeded. contest ${contestId} is open with ${AGENTS} agents.`);
    console.log("trigger the run from the demo panel or the admin endpoint to stream the feed.");
    await closePool();
    return;
  }

  console.log(`running ${KIND} contest ${contestId}...`);
  const result = KIND === "analyst" ? await runAnalystContest(contestId) : await runContest(contestId);

  console.log("\n--- result ---");
  console.log(`root:    ${result.root}`);
  console.log(`posted:  ${result.posted}`);
  console.log(`settled: ${result.settled}`);
  console.log("payouts:");
  for (const p of result.payouts) {
    const usdc = (Number(p.amount) / 1e6).toFixed(2);
    console.log(`  rank ${p.rank}  ${p.operator}  ${usdc} tUSDC`);
  }

  const { rows } = await query<{ operator: string; amount: string; rank: number; proof: string[] }>(
    "select operator, amount, rank, proof from payouts where contest_id = $1 order by rank",
    [contestId],
  );
  console.log(`\npayout rows persisted for claims: ${rows.length}`);

  // Prove a backend-generated merkle proof verifies on the live contract by
  // having the rank 1 winner claim, and check the tUSDC balance moves.
  const winner = rows[0];
  if (winner) {
    const op = operators.get(winner.operator.toLowerCase());
    if (op) {
      const amount = BigInt(winner.amount);
      const proof = winner.proof as `0x${string}`[];
      const before = await publicClient.readContract({
        address: dep.testUSDC,
        abi: testUsdcAbi,
        functionName: "balanceOf",
        args: [op.account.address],
      });
      console.log(`\nrank 1 ${op.account.address} claiming ${(Number(amount) / 1e6).toFixed(2)} tUSDC...`);
      const claimHash = await op.wallet.writeContract({
        address: dep.contestEngine,
        abi: contestEngineAbi,
        functionName: "claimPrize",
        args: [BigInt(contestId), amount, proof],
        account: op.account,
        chain: undefined,
        gasPrice: GAS_PRICE,
      });
      await publicClient.waitForTransactionReceipt({ hash: claimHash });
      const after = await publicClient.readContract({
        address: dep.testUSDC,
        abi: testUsdcAbi,
        functionName: "balanceOf",
        args: [op.account.address],
      });
      const gained = after - before;
      console.log(`claim tx ${claimHash}`);
      console.log(`balance moved by ${(Number(gained) / 1e6).toFixed(2)} tUSDC`);
      console.log(gained === amount ? "claim verified on chain" : "claim amount mismatch");
      await query("update payouts set claimed = true where contest_id = $1 and lower(operator) = $2", [
        contestId,
        winner.operator.toLowerCase(),
      ]);
    }
  }

  await closePool();
}

main().catch((err) => {
  console.error("seedAndRun failed:", err);
  process.exit(1);
});
