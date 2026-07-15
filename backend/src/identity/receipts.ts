import { ethers } from "ethers";
import { query } from "../db/pool.js";
import { config } from "../config/index.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import { identityConfigured, getIdentityWallet, identityWalletWrite } from "./erc8004.js";

// Verifiable inference receipts.
//
// Every answer an agent produced on 0G Compute (a row in solve_runs) becomes a cryptographic RECEIPT:
// a keccak256 leaf committing to the model, provider, TEE-verified flag, the prompt hash, and the
// answer. A batch of an agent's leaves is Merkle-rooted. The full batch (every leaf preimage, in order)
// is anchored on 0G Storage so anyone can fetch it by root, rebuild the tree, and confirm the root. The
// root is then recorded on the canonical ERC-8004 ValidationRegistry, keyed to the agent's identity, so
// "this agent's inferences ran on 0G, unchanged" is provable on-chain by anyone, off Zerun.
//
// This is the same idea AskZero shipped (per-inference receipts, Merkle-batched, root anchored on
// chain) but built on 0G-native primitives: 0G Storage for the immutable batch and the canonical
// ValidationRegistry for the on-chain, identity-keyed anchor. No proprietary contract.
//
// Best effort like the rest of the identity stack. validationRequest is owner-gated, so the on-chain
// anchor only lands while the platform holds the agent's identity (all agents, until they are claimed);
// the 0G Storage anchor is uniform and always makes the batch verifiable regardless of ownership.

const VALIDATION_ABI = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[])",
];

// The receipt leaf preimage: the exact object hashed into a Merkle leaf. Field ORDER is part of the
// spec (JSON.stringify preserves it), and it is echoed verbatim in the batch detail so a third party
// rebuilds identical bytes. Never reorder or rename without versioning `v`.
export interface ReceiptPreimage {
  v: 1;
  agentId: number; // ERC-8004 identity agentId (what the batch is keyed to)
  zerunAgentId: number; // the internal Zerun arena agent id
  contestId: number;
  step: number; // puzzle index within the contest
  source: string; // 0g-compute | 0g-router
  provider: string;
  model: string;
  verified: boolean; // TEE-verified flag from the provider
  verdict: string; // correct | wrong | error
  promptHash: string; // keccak256(prompt)
  answer: string; // the model's answer, verbatim
  ts: number; // unix seconds
}

function leafHash(p: ReceiptPreimage): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(p)));
}

// Ordered Merkle root over 0x32-byte leaf hashes: parent = keccak256(left || right), duplicating the
// last node when a level has an odd count. Deterministic given the ordered leaves, which the batch
// detail publishes, so anyone can recompute it.
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return ethers.ZeroHash;
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!;
      const r = level[i + 1] ?? l;
      next.push(ethers.keccak256(ethers.concat([l, r])));
    }
    level = next;
  }
  return level[0]!;
}

export interface BatchDetail {
  v: 1;
  algorithm: string;
  agentId: number;
  zerunAgentId: number;
  kind: string;
  merkleRoot: string;
  leafCount: number;
  createdAt: string;
  receipts: ReceiptPreimage[];
}

const ALGORITHM =
  "leaf = keccak256(utf8(JSON of the receipt preimage, keys in the given order)); " +
  "Merkle: ordered pairs, duplicate the last node on an odd level, parent = keccak256(left||right).";

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function receiptsConfigured(): boolean {
  // Needs an identity (to key the anchor) and, ideally, 0G Storage. Storage is best-effort so we only
  // hard-require identity; a batch with no storage still records its root and marks its runs.
  return identityConfigured() && Boolean(config.identity.validationRegistry);
}

// The public, resolvable URL where a batch's rebuild data is served.
export function receiptBatchUri(root: string): string {
  return `${config.publicApiUrl.replace(/\/+$/, "")}/api/receipts/${root}`;
}

let _validation: ethers.Contract | null = null;
function validationContract(): ethers.Contract {
  if (!_validation) _validation = new ethers.Contract(config.identity.validationRegistry, VALIDATION_ABI, getIdentityWallet());
  return _validation;
}

// Record a batch root on the ValidationRegistry, keyed to the agent's identity. Two writes: a request
// (the agent's work, keyed by the Merkle root) and a validator response (the "verified on 0G"
// attestation). Owner-gated, so this throws for agents the platform no longer holds; callers treat it
// as best effort. Returns the two tx hashes.
async function anchorOnChain(
  identityTokenId: number,
  root: string,
  responseHash: string,
): Promise<{ validationTx: string; responseTx: string }> {
  return identityWalletWrite(async () => {
    const c = validationContract();
    const validator = getIdentityWallet().address;
    const uri = receiptBatchUri(root);
    const t = config.identity.txTimeoutMs;
    const reqTx = (await withTimeout(
      c.validationRequest!(validator, identityTokenId, uri, root) as Promise<ethers.ContractTransactionResponse>,
      t,
      "ValidationRegistry request",
    )) as ethers.ContractTransactionResponse;
    await withTimeout(reqTx.wait(), t, "ValidationRegistry request confirm");
    // response = 100 means fully verified; tag groups these as inference receipts.
    const resTx = (await withTimeout(
      c.validationResponse!(root, 100, uri, responseHash, "0g-inference") as Promise<ethers.ContractTransactionResponse>,
      t,
      "ValidationRegistry response",
    )) as ethers.ContractTransactionResponse;
    await withTimeout(resTx.wait(), t, "ValidationRegistry response confirm");
    return { validationTx: reqTx.hash, responseTx: resTx.hash };
  });
}

export interface AnchorResult {
  agentId: number;
  identityTokenId: number;
  merkleRoot: string;
  leafCount: number;
  storageRoot: string | null;
  onChain: boolean; // whether the ValidationRegistry anchor landed
}

interface RunRow {
  id: string;
  contest_id: string;
  puzzle_idx: number;
  prompt: string;
  answer: string | null;
  verdict: string;
  source: string | null;
  provider: string | null;
  model: string | null;
  verified: boolean | null;
  ts: string;
}

// Build and anchor one batch of an arena agent's un-anchored 0G-compute inferences. Returns null when
// there is nothing to anchor or the agent has no identity. Best effort: a storage or on-chain failure
// still records the batch and marks its runs, so nothing is anchored twice.
export async function anchorAgentReceipts(agentId: number): Promise<AnchorResult | null> {
  if (!receiptsConfigured()) return null;

  const idRes = await query<{ identity_token_id: string | null }>(
    "select identity_token_id from agents_meta where agent_id = $1",
    [agentId],
  );
  const tokenIdRaw = idRes.rows[0]?.identity_token_id ?? null;
  if (tokenIdRaw === null) return null; // no identity to key the anchor to yet
  const identityTokenId = Number(tokenIdRaw);

  const { rows } = await query<RunRow>(
    `select id, contest_id, puzzle_idx, prompt, answer, verdict, source, provider, model, verified,
            extract(epoch from created_at)::bigint::text as ts
       from solve_runs
      where agent_id = $1 and source in ('0g-compute','0g-router') and receipt_root is null
      order by id asc`,
    [agentId],
  );
  if (rows.length === 0) return null;

  const receipts: ReceiptPreimage[] = rows.map((r) => ({
    v: 1,
    agentId: identityTokenId,
    zerunAgentId: agentId,
    contestId: Number(r.contest_id),
    step: Number(r.puzzle_idx),
    source: r.source ?? "",
    provider: r.provider ?? "",
    model: r.model ?? "",
    verified: Boolean(r.verified),
    verdict: r.verdict,
    promptHash: ethers.keccak256(ethers.toUtf8Bytes(r.prompt ?? "")),
    answer: r.answer ?? "",
    ts: Number(r.ts),
  }));

  const leaves = receipts.map(leafHash);
  const root = merkleRoot(leaves);

  const detail: BatchDetail = {
    v: 1,
    algorithm: ALGORITHM,
    agentId: identityTokenId,
    zerunAgentId: agentId,
    kind: "arena",
    merkleRoot: root,
    leafCount: receipts.length,
    createdAt: new Date().toISOString(),
    receipts,
  };

  // 1. Anchor the full batch on 0G Storage (the uniform, ownership-independent proof).
  let storageRoot: string | null = null;
  let storageTx: string | null = null;
  if (storageConfigured()) {
    try {
      const r = await uploadJson(detail);
      storageRoot = r.rootHash || null;
      storageTx = r.txHash;
    } catch (err) {
      console.warn(`receipts: 0G Storage anchor failed for agent ${agentId}:`, (err as Error).message);
    }
  }

  // 2. Record the root on-chain via the ValidationRegistry (best effort; owner-gated).
  let validationTx: string | null = null;
  let responseTx: string | null = null;
  try {
    // responseHash carries the storage root when we have one (so the on-chain record points at the
    // immutable copy), else the Merkle root itself.
    const responseHash =
      storageRoot && /^0x[0-9a-fA-F]{64}$/.test(storageRoot) ? storageRoot : root;
    const r = await anchorOnChain(identityTokenId, root, responseHash);
    validationTx = r.validationTx;
    responseTx = r.responseTx;
  } catch (err) {
    console.warn(`receipts: ValidationRegistry anchor skipped for agent ${agentId}:`, (err as Error).message);
  }

  // 3. Record the batch and mark its runs, so they are never anchored again. Do this last: if the
  // process died earlier, the runs stay un-anchored and a later run re-batches them cleanly.
  await query(
    `insert into inference_batches
        (merkle_root, agent_id, identity_token_id, kind, leaf_count, storage_root, storage_tx, validation_tx, response_tx)
      values ($1,$2,$3,'arena',$4,$5,$6,$7,$8)
      on conflict (merkle_root) do nothing`,
    [root, agentId, identityTokenId, receipts.length, storageRoot, storageTx, validationTx, responseTx],
  );
  const ids = rows.map((r) => Number(r.id));
  await query("update solve_runs set receipt_root = $2 where id = any($1::bigint[])", [ids, root]);

  return {
    agentId,
    identityTokenId,
    merkleRoot: root,
    leafCount: receipts.length,
    storageRoot,
    onChain: Boolean(validationTx),
  };
}

// Serve a batch's rebuild data by its Merkle root: the exact ordered receipt preimages plus the
// algorithm, so anyone can recompute every leaf and the root and check it against the anchor. Prefers
// the 0G Storage copy; falls back to rebuilding from the database.
export async function receiptBatch(root: string): Promise<BatchDetail | null> {
  const { rows } = await query<{
    agent_id: string;
    identity_token_id: string;
    kind: string;
    leaf_count: number;
    storage_root: string | null;
    created_at: string;
  }>(
    "select agent_id, identity_token_id, kind, leaf_count, storage_root, created_at::text from inference_batches where merkle_root = $1",
    [root],
  );
  const b = rows[0];
  if (!b) return null;

  // Rebuild from the marked runs (authoritative and always available).
  const runs = await query<RunRow>(
    `select id, contest_id, puzzle_idx, prompt, answer, verdict, source, provider, model, verified,
            extract(epoch from created_at)::bigint::text as ts
       from solve_runs
      where agent_id = $1 and receipt_root = $2
      order by id asc`,
    [Number(b.agent_id), root],
  );
  const identityTokenId = Number(b.identity_token_id);
  const receipts: ReceiptPreimage[] = runs.rows.map((r) => ({
    v: 1,
    agentId: identityTokenId,
    zerunAgentId: Number(b.agent_id),
    contestId: Number(r.contest_id),
    step: Number(r.puzzle_idx),
    source: r.source ?? "",
    provider: r.provider ?? "",
    model: r.model ?? "",
    verified: Boolean(r.verified),
    verdict: r.verdict,
    promptHash: ethers.keccak256(ethers.toUtf8Bytes(r.prompt ?? "")),
    answer: r.answer ?? "",
    ts: Number(r.ts),
  }));
  return {
    v: 1,
    algorithm: ALGORITHM,
    agentId: identityTokenId,
    zerunAgentId: Number(b.agent_id),
    kind: b.kind,
    merkleRoot: root,
    leafCount: receipts.length,
    createdAt: new Date(b.created_at).toISOString(),
    receipts,
  };
}

export interface BatchSummary {
  merkleRoot: string;
  leafCount: number;
  storageRoot: string | null;
  onChain: boolean;
  createdAt: string;
  verifyUrl: string;
}

// An agent's anchored batches, newest first, for the verification UI/API.
export async function agentReceiptBatches(agentId: number, limit = 50): Promise<BatchSummary[]> {
  const { rows } = await query<{
    merkle_root: string;
    leaf_count: number;
    storage_root: string | null;
    validation_tx: string | null;
    created_at: string;
  }>(
    `select merkle_root, leaf_count, storage_root, validation_tx, created_at::text
       from inference_batches where agent_id = $1 order by created_at desc limit $2`,
    [agentId, limit],
  );
  return rows.map((r) => ({
    merkleRoot: r.merkle_root,
    leafCount: r.leaf_count,
    storageRoot: r.storage_root,
    onChain: Boolean(r.validation_tx),
    createdAt: new Date(r.created_at).toISOString(),
    verifyUrl: receiptBatchUri(r.merkle_root),
  }));
}
