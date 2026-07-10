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

// An upload pays a storage fee, which is a real transaction on the same chain the arena's
// contracts live on. The coordinator hands out explicit sequential nonces for its own writes,
// but ethers counts independently: point both at one account and a storage upload can consume
// the nonce the coordinator is about to post a score root with, and the chain rejects the root
// as `nonce too low`. Give storage its own key when one is provided.
//
// It falls back to COMPUTE_PRIVATE_KEY (also off the coordinator's nonce space) and finally to
// the deployer, so an unconfigured deployment still works exactly as it did.
function getSigner(): ethers.Wallet {
  const key = process.env.STORAGE_PRIVATE_KEY || process.env.COMPUTE_PRIVATE_KEY || config.signerKey;
  if (!key) throw new Error("no signer key set; 0G Storage needs one (STORAGE_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY)");
  const provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
  return new ethers.Wallet(key, provider);
}

export function storageConfigured(): boolean {
  return config.storage.enabled && Boolean(config.signerKey);
}

// A stalled 0G Storage network call would otherwise hang forever. Every upload sits
// before a settlement writes the payout, so an unbounded hang freezes the whole
// contest. Bound it: on timeout we throw, and the caller treats the audit upload as a
// best-effort failure rather than blocking the money.
const UPLOAD_TIMEOUT_MS = Number(process.env.ZG_STORAGE_UPLOAD_TIMEOUT_MS ?? "45000");
// A download must also be bounded. It runs on the request path (e.g. serving an agent
// skin), and an unbounded stall on a slow/flaky indexer hangs the HTTP handler until the
// hosting gateway kills it with a 503 instead of the app returning a clean fallback. Keep
// this well under any gateway/proxy request timeout so a stalled read fails fast.
const DOWNLOAD_TIMEOUT_MS = Number(process.env.ZG_STORAGE_DOWNLOAD_TIMEOUT_MS ?? "12000");

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Upload raw bytes (e.g. an image). Returns the 0G Storage root hash.
export async function uploadBytes(bytes: Uint8Array): Promise<StoreResult> {
  const file = new MemData(bytes);

  const [tree, treeErr] = await file.merkleTree();
  if (treeErr !== null || !tree) throw new Error(`0G Storage merkle tree failed: ${treeErr}`);
  const rootHash = tree.rootHash();

  const indexer = getIndexer();
  const [tx, uploadErr] = await withTimeout(
    indexer.upload(file, config.chain.rpcUrl, getSigner()),
    UPLOAD_TIMEOUT_MS,
    "0G Storage upload",
  );
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
  const [blob, err] = await withTimeout(
    indexer.downloadToBlob(rootHash, { proof: true }),
    DOWNLOAD_TIMEOUT_MS,
    "0G Storage download",
  );
  if (err !== null || !blob) throw new Error(`0G Storage download failed: ${err}`);
  const text = await blob.text();
  return JSON.parse(text) as T;
}

// Read raw bytes back by root hash (e.g. an agent skin image). Bounded so a stalled
// indexer read fails fast instead of hanging the request into a gateway 503.
export async function downloadBytes(rootHash: string): Promise<Uint8Array> {
  const indexer = getIndexer();
  const [blob, err] = await withTimeout(
    indexer.downloadToBlob(rootHash, { proof: true }),
    DOWNLOAD_TIMEOUT_MS,
    "0G Storage download",
  );
  if (err !== null || !blob) throw new Error(`0G Storage download failed: ${err}`);
  const ab = await blob.arrayBuffer();
  return new Uint8Array(ab);
}
