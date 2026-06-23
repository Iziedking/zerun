import { ethers } from "ethers";
import { createRequire } from "node:module";
import { config } from "../config/index.js";

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

// Probe one provider's setup to find why the sub-account is not created, so we
// can get billing and TEE verification working. Pass the provider as argv[2].
async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: tsx src/scripts/providerProbe.ts <providerAddress>");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  const wallet = new ethers.Wallet(config.signerKey, provider);
  const broker = await createZGComputeNetworkBroker(wallet);

  const show = (label: string, e: unknown) => {
    const err = e as { shortMessage?: string; message?: string; revert?: { name?: string } };
    console.log(`${label}: ${err.revert?.name ?? err.shortMessage ?? err.message}`);
  };

  console.log(`provider ${target}`);

  try {
    await broker.inference.acknowledgeProviderSigner(target);
    console.log("acknowledge: ok");
  } catch (e) {
    show("acknowledge", e);
  }

  try {
    await broker.ledger.transferFund(target, "inference", BigInt(1) * 10n ** 18n);
    console.log("transferFund: ok");
  } catch (e) {
    show("transferFund", e);
  }

  // Retry acknowledge after the account exists (order can matter).
  try {
    await broker.inference.acknowledgeProviderSigner(target);
    console.log("acknowledge (retry): ok");
  } catch (e) {
    show("acknowledge (retry)", e);
  }
}

main().catch((e) => {
  console.error("probe failed:", (e as Error).message);
  process.exit(1);
});
