import { createRequire } from "node:module";
import { ethers } from "ethers";
// Side-effect import: loads the root .env, where the signer key lives.
import "../config/index.js";

// Read-only inspection of a 0G Compute network's raw service structs: model, health, TEE
// attestation, and the price fields each listing carries. No ledger, no inference, no spend.
//
// The catalog differs per network, and on mainnet the prices are real 0G, so run this
// before pointing agents at a network you have not used before:
//
//   PROBE_RPC=https://evmrpc.0g.ai         npx tsx src/scripts/providerProbe.ts   # mainnet
//   PROBE_RPC=https://evmrpc-testnet.0g.ai npx tsx src/scripts/providerProbe.ts   # testnet

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

async function main() {
  const rpc = process.env.PROBE_RPC ?? process.env.OG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
  const raw = process.env.DEPLOYER_PRIVATE_KEY;
  if (!raw) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;

  const wallet = new ethers.Wallet(key, new ethers.JsonRpcProvider(rpc));
  const broker = await createZGComputeNetworkBroker(wallet);
  const services = (await broker.inference.listService()) as unknown as unknown[][];

  const chat = services.filter((s) => String(s[1]) === "chatbot");
  console.log(`\nrpc: ${rpc}`);
  console.log(`chatbot services: ${chat.length} of ${services.length}\n`);

  const first = chat[0];
  if (first) {
    console.log("raw tuple of one chatbot service (so the field indices are not a guess):");
    for (let i = 0; i < first.length; i++) {
      const v = first[i];
      console.log(`  [${i}] ${typeof v === "bigint" ? v.toString() : String(v).slice(0, 70)}`);
    }
    console.log(`\n  additionalInfo [8] in full: ${String(first[8])}\n`);
  }

  // [3] and [4] are per-token prices in wei of 0G. A 1k-token answer costs roughly
  // in*prompt + out*completion, so print the output price for 1000 tokens: the number that
  // actually decides what a contest costs.
  const per1k = (wei: unknown) => Number(ethers.formatEther((BigInt(String(wei)) * 1000n).toString()));

  console.log("  model                        in/1k        out/1k       health     verifiability");
  const rows = [...chat].sort((a, b) => Number(BigInt(String(a[4])) - BigInt(String(b[4]))));
  for (const s of rows) {
    const model = String(s[6] ?? "?");
    const healthy = s[10] === true;
    console.log(
      `  ${model.padEnd(28)} ${per1k(s[3]).toFixed(6).padEnd(12)} ${per1k(s[4]).toFixed(6).padEnd(12)} ` +
        `${(healthy ? "healthy" : "UNHEALTHY").padEnd(10)} ${String(s[7])}`,
    );
  }

  // What `readService` currently calls "TEE": verifiability === TeeML AND a TargetTeeAddress
  // parsed out of additionalInfo [8]. Compare that against the raw verifiability field, and
  // against the signer address the struct carries at [9].
  const teeMl = chat.filter((s) => s[7] === "TeeML");
  const teeMlHealthy = teeMl.filter((s) => s[10] === true);
  const withTarget = chat.filter((s) => {
    try {
      return Boolean(JSON.parse(String(s[8] ?? "{}")).TargetTeeAddress);
    } catch {
      return false;
    }
  });

  console.log(`\n  verifiability === "TeeML":           ${teeMl.length}`);
  console.log(`  ...and healthy:                     ${teeMlHealthy.length}`);
  console.log(`  additionalInfo has TargetTeeAddress: ${withTarget.length}   <- what readService scores on`);
  if (teeMlHealthy.length > 0 && withTarget.length === 0) {
    console.log(
      `\n  NOTE: providers advertise TeeML but carry no TargetTeeAddress in additionalInfo,\n` +
        `  so readService() scores every one of them as non-attesting. The signer address\n` +
        `  appears to live at tuple index [9] instead.`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("providerProbe failed:", (e as Error).message);
    process.exit(1);
  });
