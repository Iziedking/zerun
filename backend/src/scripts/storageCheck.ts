import { config } from "../config/index.js";
import { uploadJson, downloadJson, storageConfigured } from "../storage/zgStorage.js";

// Round-trip check of 0G Storage. Run once the wallet holds some 0G:
//   STORAGE_MODE=on pnpm tsx src/scripts/storageCheck.ts
//
// It uploads a small object, reads it back by its root hash, and confirms the
// content matches. A matching read means the audit trail path is live on 0G.

async function main() {
  console.log(`storage enabled: ${storageConfigured()}`);
  console.log(`indexer: ${config.storage.indexerRpc}`);
  if (!storageConfigured()) {
    console.log("set STORAGE_MODE=on and a funded DEPLOYER_PRIVATE_KEY to run this.");
    return;
  }

  const sample = { hello: "0g storage", at: new Date().toISOString(), nums: [1, 2, 3] };
  console.log("uploading sample (submits an on-chain storage transaction)...");
  const { rootHash, txHash } = await uploadJson(sample);
  console.log(`rootHash: ${rootHash}`);
  console.log(`txHash:   ${txHash ?? "(none)"}`);

  console.log("downloading it back...");
  const back = await downloadJson<typeof sample>(rootHash);
  const ok = JSON.stringify(back) === JSON.stringify(sample);
  console.log(`round-trip match: ${ok}`);
  console.log(ok ? "0G Storage is live." : "content did not match.");
}

main().catch((err) => {
  console.error("storage check failed:", err);
  process.exit(1);
});
