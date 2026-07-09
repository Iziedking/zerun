import { createRequire } from "node:module";
import { ethers } from "ethers";
import "../config/index.js";

// Read-only: does a ledger already exist on this network, and what does it hold?
// `ensureLedger` treats a getLedger() failure as "no ledger" and calls addLedger, so a
// getLedger that throws for any OTHER reason sends us down the create path by mistake.
//
//   PROBE_RPC=https://evmrpc.0g.ai npx tsx src/scripts/ledgerProbe.ts

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

async function main() {
  const rpc = process.env.PROBE_RPC ?? "https://evmrpc.0g.ai";
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);
  console.log(`rpc:     ${rpc}`);
  console.log(`wallet:  ${wallet.address}`);
  console.log(`balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} 0G\n`);

  const broker = await createZGComputeNetworkBroker(wallet);

  try {
    const ledger = (await broker.ledger.getLedger()) as unknown as Record<string, unknown>;
    console.log("getLedger() SUCCEEDED. Fields:");
    for (const [k, v] of Object.entries(ledger)) {
      if (typeof v === "bigint") console.log(`  ${k}: ${v} (${ethers.formatEther(v)} 0G)`);
      else if (typeof v !== "object") console.log(`  ${k}: ${String(v)}`);
    }
  } catch (err) {
    console.log("getLedger() FAILED:", (err as Error).message);
    console.log("\n-> ensureLedger reads this as 'no ledger yet' and calls addLedger.");
  }

  // Where the ledger's balance actually went: each provider sub-account it was transferred
  // into. `transferFund` moves 0G out of the ledger's AVAILABLE balance and locks it here,
  // so an exhausted available balance means no new provider can ever be set up.
  console.log("\nprovider sub-accounts:");
  const services = (await broker.inference.listService()) as unknown as unknown[][];
  const chat = services.filter((s) => String(s[1]) === "chatbot");
  for (const s of chat) {
    const addr = String(s[0]);
    try {
      const acct = (await broker.inference.getAccount(addr)) as unknown as Record<string, unknown>;
      const bal = acct["balance"] ?? acct[1];
      const pending = acct["pendingRefund"] ?? acct[2];
      console.log(
        `  ${String(s[6]).padEnd(30)} balance=${typeof bal === "bigint" ? ethers.formatEther(bal) : String(bal)}` +
          `  pendingRefund=${typeof pending === "bigint" ? ethers.formatEther(pending) : String(pending)}`,
      );
    } catch {
      /* no sub-account for this provider: never set up */
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ledgerProbe failed:", (e as Error).message);
    process.exit(1);
  });
