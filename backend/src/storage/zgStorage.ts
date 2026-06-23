import { ethers } from "ethers";
import { createRequire } from "node:module";
import { config } from "../config/index.js";

// 0G Storage integration. After a contest settles, the full solve feed (every
// answer with its 0G Compute provenance) is uploaded here so the audit trail
// lives on decentralized storage and can be read back by its root hash. This is
// a deepener, not part of the money path, so every call is best effort: a
// storage failure is logged and never blocks settlement.
//
// Loaded through require for the same reason as the compute broker: the SDK's
// ESM build does not resolve cleanly under Node's strict loader.
const require = createRequire(import.meta.url);
const sdk = require("@0gfoundation/0g-storage-ts-sdk") as typeof import("@0gfoundation/0g-storage-ts-sdk");
const { Indexer, MemData } = sdk;

export interface StoreResult {
  rootHash: string;
  txHash: string | null;
}

let _indexer: InstanceType<typeof Indexer> | null = null;
function getIndexer() {
  if (!_indexer) _indexer = new Indexer(config.storage.indexerRpc);
  return _indexer;
}

function getSigner(): ethers.Wallet {
  if (!config.signerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set; 0G Storage needs a signer");
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  return new ethers.Wallet(config.signerKey, provider);
}

export function storageConfigured(): boolean {
  return config.storage.enabled && Boolean(config.signerKey);
}

// Upload raw bytes (e.g. an image). Returns the 0G Storage root hash.
export async function uploadBytes(bytes: Uint8Array): Promise<StoreResult> {
  const file = new MemData(bytes);

  const [tree, treeErr] = await file.merkleTree();
  if (treeErr !== null || !tree) throw new Error(`0G Storage merkle tree failed: ${treeErr}`);
  const rootHash = tree.rootHash();

  const indexer = getIndexer();
  const [tx, uploadErr] = await indexer.upload(file, config.chain.rpcUrl, getSigner());
  if (uploadErr !== null) throw new Error(`0G Storage upload failed: ${uploadErr}`);

  const txHash =
    typeof tx === "string" ? tx : ((tx as { txHash?: string } | null)?.txHash ?? null);
  return { rootHash: rootHash ?? "", txHash };
}

// Upload a JSON-serializable object. Returns the 0G Storage root hash, which is
// the content address used to read it back.
export async function uploadJson(value: unknown): Promise<StoreResult> {
  return uploadBytes(new TextEncoder().encode(JSON.stringify(value)));
}

// Read a stored object back by its root hash. Used to prove retrievability.
export async function downloadJson<T = unknown>(rootHash: string): Promise<T> {
  const indexer = getIndexer();
  const [blob, err] = await indexer.downloadToBlob(rootHash, { proof: true });
  if (err !== null || !blob) throw new Error(`0G Storage download failed: ${err}`);
  const text = await blob.text();
  return JSON.parse(text) as T;
}

// Read raw bytes back by root hash (e.g. an agent skin image).
export async function downloadBytes(rootHash: string): Promise<Uint8Array> {
  const indexer = getIndexer();
  const [blob, err] = await indexer.downloadToBlob(rootHash, { proof: true });
  if (err !== null || !blob) throw new Error(`0G Storage download failed: ${err}`);
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}
