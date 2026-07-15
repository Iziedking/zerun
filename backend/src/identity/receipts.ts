import { ethers } from "ethers";
import { query } from "../db/pool.js";
import { config } from "../config/index.js";
import { storageConfigured, uploadJson } from "../storage/zgStorage.js";
import { identityConfigured, getIdentityWallet, identityWalletWrite } from "./erc8004.js";

// Verifiable inference receipts.
//
// Every answer an agent produced on 0G Compute becomes a cryptographic RECEIPT: a keccak256 leaf
// committing to the model, provider, TEE-verified flag, the prompt hash, and the answer. A batch of an
// agent's leaves is Merkle-rooted. The full batch (every leaf preimage, in order) is anchored on 0G
// Storage so anyone can fetch it by root, rebuild the tree, and confirm the root. The root is then
// recorded on the canonical ERC-8004 ValidationRegistry, keyed to the agent's identity, so "this
// agent's inferences ran on 0G, unchanged" is provable on-chain by anyone, off Zerun.
//
// Two sources feed one engine: ARENA inferences (solve_runs) and CHESS call_model calls
// (chess_inferences). Both map to the same receipt shape and the same anchor path.
//
// Best effort like the rest of the identity stack. validationRequest is owner-gated, so the on-chain
// anchor only lands while the platform holds the agent's identity (all agents, until they are claimed);
// the 0G Storage anchor is uniform and always makes the batch verifiable regardless of ownership.

const VALIDATION_ABI = [
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getAgentValidations(uint256 agentId) view returns (bytes32[])",
];

export type ReceiptKind = "arena" | "chess";

// The receipt leaf preimage: the exact object hashed into a Merkle leaf. Field ORDER is part of the
// spec (JSON.stringify preserves it) and is echoed verbatim in the batch detail so a third party
// rebuilds identical bytes. Never reorder or rename without versioning `v`.
export interface ReceiptPreimage {
  v: 1;
  agentId: number; // ERC-8004 identity agentId (what the batch is keyed to)
  zerunAgentId: number; // the internal Zerun agent id (agents_meta.agent_id or chess_agents.id)
  kind: ReceiptKind;
  ref: number; // arena: contest id; chess: 0 (no game id at the call site)
  step: number; // arena: puzzle index; chess: 0
  source: string; // 0g-compute | 0g-compute-router | ...
  provider: string;
  model: string;
  verified: boolean; // TEE-verified flag from the provider
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
  kind: ReceiptKind;
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

// Record a batch root on the ValidationRegistry, keyed to the agent's identity: a request (the work,
// keyed by the Merkle root) then a validator response (the "verified on 0G" attestation). Owner-gated,
// so it throws for agents the platform no longer holds; callers treat it as best effort.
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
  kind: ReceiptKind;
  agentId: number;
  identityTokenId: number;
  merkleRoot: string;
  leafCount: number;
  storageRoot: string | null;
  onChain: boolean;
}

// Shared anchor path: given the ordered receipts for one agent, Merkle-root them, anchor on 0G Storage,
// record the root on-chain (best effort), write the batch, and mark the source rows so they are never
// re-anchored. `markTable` is the table whose `receipt_root` column gets stamped, `rowIds` its ids.
async function anchorBatch(
  kind: ReceiptKind,
  agentId: number,
  identityTokenId: number,
  receipts: ReceiptPreimage[],
  markTable: "solve_runs" | "chess_inferences",
  rowIds: number[],
): Promise<AnchorResult> {
  const leaves = receipts.map(leafHash);
  const root = merkleRoot(leaves);
  const detail: BatchDetail = {
    v: 1,
    algorithm: ALGORITHM,
    agentId: identityTokenId,
    zerunAgentId: agentId,
    kind,
    merkleRoot: root,
    leafCount: receipts.length,
    createdAt: new Date().toISOString(),
    receipts,
  };

  let storageRoot: string | null = null;
  let storageTx: string | null = null;
  if (storageConfigured()) {
    try {
      const r = await uploadJson(detail);
      storageRoot = r.rootHash || null;
      storageTx = r.txHash;
    } catch (err) {
      console.warn(`receipts: 0G Storage anchor failed for ${kind} agent ${agentId}:`, (err as Error).message);
    }
  }

  let validationTx: string | null = null;
  let responseTx: string | null = null;
  try {
    const responseHash = storageRoot && /^0x[0-9a-fA-F]{64}$/.test(storageRoot) ? storageRoot : root;
    const r = await anchorOnChain(identityTokenId, root, responseHash);
    validationTx = r.validationTx;
    responseTx = r.responseTx;
  } catch (err) {
    console.warn(`receipts: ValidationRegistry anchor skipped for ${kind} agent ${agentId}:`, (err as Error).message);
  }

  await query(
    `insert into inference_batches
        (merkle_root, agent_id, identity_token_id, kind, leaf_count, storage_root, storage_tx, validation_tx, response_tx)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (merkle_root) do nothing`,
    [root, agentId, identityTokenId, kind, receipts.length, storageRoot, storageTx, validationTx, responseTx],
  );
  await query(`update ${markTable} set receipt_root = $2 where id = any($1::bigint[])`, [rowIds, root]);

  return { kind, agentId, identityTokenId, merkleRoot: root, leafCount: receipts.length, storageRoot, onChain: Boolean(validationTx) };
}

interface ArenaRow {
  id: string; contest_id: string; puzzle_idx: number; prompt: string; answer: string | null;
  source: string | null; provider: string | null; model: string | null; verified: boolean | null; ts: string;
}

// Anchor one batch of an ARENA agent's un-anchored 0G-compute inferences (from solve_runs).
export async function anchorAgentReceipts(agentId: number): Promise<AnchorResult | null> {
  if (!receiptsConfigured()) return null;
  const idRes = await query<{ identity_token_id: string | null }>(
    "select identity_token_id from agents_meta where agent_id = $1",
    [agentId],
  );
  const tok = idRes.rows[0]?.identity_token_id ?? null;
  if (tok === null) return null;
  const identityTokenId = Number(tok);

  const { rows } = await query<ArenaRow>(
    `select id, contest_id, puzzle_idx, prompt, answer, source, provider, model, verified,
            extract(epoch from created_at)::bigint::text as ts
       from solve_runs
      where agent_id = $1 and source in ('0g-compute','0g-compute-router','0g-router') and receipt_root is null
      order by id asc`,
    [agentId],
  );
  if (rows.length === 0) return null;

  const receipts: ReceiptPreimage[] = rows.map((r) => ({
    v: 1, agentId: identityTokenId, zerunAgentId: agentId, kind: "arena",
    ref: Number(r.contest_id), step: Number(r.puzzle_idx),
    source: r.source ?? "", provider: r.provider ?? "", model: r.model ?? "", verified: Boolean(r.verified),
    promptHash: ethers.keccak256(ethers.toUtf8Bytes(r.prompt ?? "")), answer: r.answer ?? "", ts: Number(r.ts),
  }));
  return anchorBatch("arena", agentId, identityTokenId, receipts, "solve_runs", rows.map((r) => Number(r.id)));
}

interface ChessRow {
  id: string; prompt: string; answer: string | null;
  source: string | null; provider: string | null; model: string | null; verified: boolean | null; ts: string;
}

// Anchor one batch of a CHESS agent's un-anchored call_model inferences (from chess_inferences).
export async function anchorChessAgentReceipts(chessAgentId: number): Promise<AnchorResult | null> {
  if (!receiptsConfigured()) return null;
  const idRes = await query<{ identity_token_id: string | null }>(
    "select identity_token_id from chess_agents where id = $1",
    [chessAgentId],
  );
  const tok = idRes.rows[0]?.identity_token_id ?? null;
  if (tok === null) return null;
  const identityTokenId = Number(tok);

  const { rows } = await query<ChessRow>(
    `select id, prompt, answer, source, provider, model, verified,
            extract(epoch from created_at)::bigint::text as ts
       from chess_inferences
      where agent_id = $1 and receipt_root is null
      order by id asc`,
    [chessAgentId],
  );
  if (rows.length === 0) return null;

  const receipts: ReceiptPreimage[] = rows.map((r) => ({
    v: 1, agentId: identityTokenId, zerunAgentId: chessAgentId, kind: "chess",
    ref: 0, step: 0,
    source: r.source ?? "", provider: r.provider ?? "", model: r.model ?? "", verified: Boolean(r.verified),
    promptHash: ethers.keccak256(ethers.toUtf8Bytes(r.prompt ?? "")), answer: r.answer ?? "", ts: Number(r.ts),
  }));
  return anchorBatch("chess", chessAgentId, identityTokenId, receipts, "chess_inferences", rows.map((r) => Number(r.id)));
}

// Log one chess call_model result as a receipt source row. Best effort and fire-and-forget at the call
// site: it must never block or fail a move.
export async function logChessInference(
  chessAgentId: number,
  data: { prompt: string; answer: string; source: string; provider: string; model: string; verified: boolean | null; latencyMs: number },
): Promise<void> {
  try {
    await query(
      `insert into chess_inferences (agent_id, prompt, answer, source, provider, model, verified, latency_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [chessAgentId, data.prompt.slice(0, 8000), data.answer.slice(0, 8000), data.source, data.provider, data.model, data.verified, data.latencyMs],
    );
  } catch (err) {
    console.warn(`chess inference log failed for agent ${chessAgentId}:`, (err as Error).message);
  }
}

// Serve a batch's rebuild data by its Merkle root: the exact ordered receipt preimages plus the
// algorithm, so anyone can recompute every leaf and the root and check it against the anchor. Rebuilt
// from the authoritative source rows (always available), regardless of kind.
export async function receiptBatch(root: string): Promise<BatchDetail | null> {
  const { rows } = await query<{ agent_id: string; identity_token_id: string; kind: ReceiptKind; created_at: string }>(
    "select agent_id, identity_token_id, kind, created_at::text from inference_batches where merkle_root = $1",
    [root],
  );
  const b = rows[0];
  if (!b) return null;
  const agentId = Number(b.agent_id);
  const identityTokenId = Number(b.identity_token_id);

  let receipts: ReceiptPreimage[];
  if (b.kind === "chess") {
    const runs = await query<ChessRow>(
      `select id, prompt, answer, source, provider, model, verified, extract(epoch from created_at)::bigint::text as ts
         from chess_inferences where agent_id = $1 and receipt_root = $2 order by id asc`,
      [agentId, root],
    );
    receipts = runs.rows.map((r) => ({
      v: 1, agentId: identityTokenId, zerunAgentId: agentId, kind: "chess", ref: 0, step: 0,
      source: r.source ?? "", provider: r.provider ?? "", model: r.model ?? "", verified: Boolean(r.verified),
      promptHash: ethers.keccak256(ethers.toUtf8Bytes(r.prompt ?? "")), answer: r.answer ?? "", ts: Number(r.ts),
    }));
  } else {
    const runs = await query<ArenaRow>(
      `select id, contest_id, puzzle_idx, prompt, answer, source, provider, model, verified, extract(epoch from created_at)::bigint::text as ts
         from solve_runs where agent_id = $1 and receipt_root = $2 order by id asc`,
      [agentId, root],
    );
    receipts = runs.rows.map((r) => ({
      v: 1, agentId: identityTokenId, zerunAgentId: agentId, kind: "arena",
      ref: Number(r.contest_id), step: Number(r.puzzle_idx),
      source: r.source ?? "", provider: r.provider ?? "", model: r.model ?? "", verified: Boolean(r.verified),
      promptHash: ethers.keccak256(ethers.toUtf8Bytes(r.prompt ?? "")), answer: r.answer ?? "", ts: Number(r.ts),
    }));
  }

  return {
    v: 1, algorithm: ALGORITHM, agentId: identityTokenId, zerunAgentId: agentId, kind: b.kind,
    merkleRoot: root, leafCount: receipts.length, createdAt: new Date(b.created_at).toISOString(), receipts,
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

// An agent's anchored batches for a kind, newest first, for the verification UI/API.
export async function agentReceiptBatches(agentId: number, kind: ReceiptKind, limit = 50): Promise<BatchSummary[]> {
  const { rows } = await query<{
    merkle_root: string; leaf_count: number; storage_root: string | null; validation_tx: string | null; created_at: string;
  }>(
    `select merkle_root, leaf_count, storage_root, validation_tx, created_at::text
       from inference_batches where agent_id = $1 and kind = $2 order by created_at desc limit $3`,
    [agentId, kind, limit],
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
