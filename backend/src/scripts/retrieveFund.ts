import { createRequire } from "node:module";
import { ethers } from "ethers";
import "../config/index.js";

// Reclaim 0G locked in provider sub-accounts back into the ledger's available balance.
//
// The SDK's `broker.ledger.retrieveFund('inference')` sweeps EVERY provider you have ever
// used, because it builds the address list itself. The contract does not require that:
// `retrieveFund(address[] providers, string serviceName)` takes whichever subset you name.
// So this targets only the providers you list, leaving the ones you still play on funded.
//
// DRY RUN BY DEFAULT. It simulates with eth_estimateGas and prints what would move. Pass
// EXECUTE=1 to actually send the transaction.
//
//   PROBE_RPC=https://evmrpc.0g.ai PROVIDERS=0xaaa,0xbbb npx tsx src/scripts/retrieveFund.ts
//   ... EXECUTE=1  to send it
//
// IT IS A TWO-PHASE REFUND, AND THE FIRST PHASE MOVES NOTHING.
//
// `retrieveFund` calls `requestRefundAll` on the InferenceServing contract, which sets
// `pendingRefund = balance` and starts a timer. The 0G only returns to the ledger's
// available balance once `lockTime` has elapsed and a refund is processed — and on mainnet
// today `lockTime()` is 86400 seconds, a full 24 hours. Run this once to request, then run
// the SAME command again after the lock expires to collect. The second run is what actually
// credits the ledger.
//
// Other context worth knowing:
//   * The contract's MIN_TRANSFER_AMOUNT is 1 0G, so every sub-account holds at least that
//     — which is why COMPUTE_*_PROVIDER_OG=0.1 could never have worked.
//   * The SDK re-funds a provider's sub-account on its next request anyway, drawing from the
//     ledger's available balance. Retrieving from a provider you still use just moves the
//     money in a circle, costs gas, and strands it for 24 hours in the meantime.
//   * A pending refund makes `balance - pendingRefund` zero, which is the figure the SDK's
//     top-up check reads. So a provider with a pending refund will be re-funded from scratch
//     if anything calls it again before the refund lands.

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

const LEDGER_ABI = [
  "function MIN_TRANSFER_AMOUNT() view returns (uint256)",
  "function retrieveFund(address[] providers, string serviceName)",
  "function getServiceInfo(address serviceCA) view returns (tuple(string fullName, address serviceCA))",
];

async function main() {
  const rpc = process.env.PROBE_RPC ?? "https://evmrpc.0g.ai";
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const wanted = (process.env.PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) throw new Error("set PROVIDERS=0xaaa,0xbbb (the sub-accounts to drain)");

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, provider);
  const broker = await createZGComputeNetworkBroker(wallet);

  // What each named sub-account currently holds, and what the whole ledger looks like.
  const ledger = (await broker.ledger.getLedger()) as unknown as { availableBalance: bigint; totalBalance: bigint };
  console.log(`\nledger  total=${ethers.formatEther(ledger.totalBalance)} 0G  available=${ethers.formatEther(ledger.availableBalance)} 0G`);

  let reclaim = 0n;
  console.log(`\nsub-accounts named:`);
  for (const p of wanted) {
    try {
      const acct = (await broker.inference.getAccount(p)) as unknown as { balance: bigint; pendingRefund: bigint };
      reclaim += acct.balance - acct.pendingRefund;
      console.log(`  ${p}  balance=${ethers.formatEther(acct.balance)} 0G  pendingRefund=${ethers.formatEther(acct.pendingRefund)} 0G`);
    } catch {
      console.log(`  ${p}  (no sub-account)`);
    }
  }
  console.log(`\nwould reclaim about ${ethers.formatEther(reclaim)} 0G into the ledger's available balance`);

  // The service name is not the literal string "inference": it is whatever the LedgerManager
  // registered for the inference serving contract. Ask it.
  const ledgerAddr = await (broker.ledger as unknown as { ledgerContract: { getAddress?: () => Promise<string> } })
    .ledgerContract?.getAddress?.()
    .catch(() => undefined);
  const ledgerCA = ledgerAddr ?? process.env.LEDGER_CA ?? "0x2dE54c845Cd948B72D2e32e39586fe89607074E3";
  // ethers types a dynamically-built Contract loosely; name the two methods we call.
  const c = new ethers.Contract(ledgerCA, LEDGER_ABI, wallet) as ethers.Contract & {
    MIN_TRANSFER_AMOUNT(): Promise<bigint>;
    retrieveFund: {
      (providers: string[], serviceName: string, overrides?: { gasPrice?: bigint }): Promise<ethers.ContractTransactionResponse>;
      estimateGas(providers: string[], serviceName: string): Promise<bigint>;
    };
  };

  console.log(`\nMIN_TRANSFER_AMOUNT = ${ethers.formatEther(await c.MIN_TRANSFER_AMOUNT())} 0G (per sub-account, enforced on chain)`);

  // The service name is not the literal "inference": the LedgerManager registers a full name
  // per serving contract, and the SDK resolves it at broker construction. Read it from there
  // rather than guessing, because a wrong name reverts.
  const inner = (broker.ledger as unknown as { ledger?: { serviceNames?: { inference?: string } } }).ledger;
  const serviceName = process.env.SERVICE_NAME ?? inner?.serviceNames?.inference ?? "";
  if (!serviceName) {
    console.log(`\ncould not resolve the inference service name from the broker; set SERVICE_NAME explicitly.`);
    return;
  }
  console.log(`\ninference service name: ${JSON.stringify(serviceName)}`);

  console.log(`\nsimulating retrieveFund([${wanted.length} providers], "${serviceName}")...`);
  try {
    const gas = await c.retrieveFund.estimateGas(wanted, serviceName);
    console.log(`  simulation OK, gas=${gas}`);
  } catch (err) {
    console.log(`  SIMULATION REVERTED: ${(err as Error).message.slice(0, 160)}`);
    return;
  }

  if (process.env.EXECUTE !== "1") {
    console.log(`\ndry run. Re-run with EXECUTE=1 to send it.`);
    return;
  }

  const tx = await c.retrieveFund(wanted, serviceName, { gasPrice: 3_000_000_000n });
  console.log(`\nsent ${tx.hash}, waiting...`);
  await tx.wait();

  const after = (await broker.ledger.getLedger()) as unknown as { availableBalance: bigint; totalBalance: bigint };
  console.log(`ledger  total=${ethers.formatEther(after.totalBalance)} 0G  available=${ethers.formatEther(after.availableBalance)} 0G`);

  // Report the pending refunds, so nobody concludes the transaction did nothing.
  let pending = 0n;
  for (const p of wanted) {
    try {
      const acct = (await broker.inference.getAccount(p)) as unknown as { pendingRefund: bigint };
      pending += acct.pendingRefund;
    } catch {
      /* no sub-account */
    }
  }
  if (pending > 0n && after.availableBalance === ledger.availableBalance) {
    console.log(
      `\n${ethers.formatEther(pending)} 0G is now PENDING REFUND, not yet credited.\n` +
        `The InferenceServing lock is 24h on mainnet. Re-run this exact command after it expires to collect.`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("retrieveFund failed:", (e as Error).message);
    process.exit(1);
  });
