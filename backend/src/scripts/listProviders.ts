import { ethers } from "ethers";
import { createRequire } from "node:module";
import { config } from "../config/index.js";

const require = createRequire(import.meta.url);
const { createZGComputeNetworkBroker } =
  require("@0glabs/0g-serving-broker") as typeof import("@0glabs/0g-serving-broker");

// Dump every live 0G Compute provider with its fields, so we can pick one whose
// responses verify (TEE attestation) for the "Verified on 0G" badge.
async function main() {
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  const wallet = new ethers.Wallet(config.signerKey, provider);
  const broker = await createZGComputeNetworkBroker(wallet);
  const services = await broker.inference.listService();
  console.log(`found ${services.length} services\n`);
  for (const s of services) {
    const o = s as unknown as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "bigint") fields[k] = v.toString();
      else if (typeof v !== "function") fields[k] = v;
    }
    console.log(JSON.stringify(fields));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
