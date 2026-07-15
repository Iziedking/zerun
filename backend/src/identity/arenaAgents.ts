import { query } from "../db/pool.js";
import { config } from "../config/index.js";
import {
  identityConfigured,
  registerIdentity,
  transferIdentity,
  identityOwnerOf,
  arenaAgentCardUri,
} from "./erc8004.js";
import { computeLevelClamp, MAX_COMPUTE_LEVEL } from "../runners/computeLevels.js";
import { postFeedback } from "./reputation.js";

// ERC-8004 identity for ARENA agents (agents_meta: poker / world cup / prediction / solver).
//
// Same standard and contract as chess (0G mainnet's canonical IdentityRegistry), generalized to the
// on-chain Zerun agents. Two moments:
//   - mint:   platform-sponsored, minted to the platform wallet, when an agent first registers.
//   - claim:  the owner proves their wallet and we TRANSFER the NFT to them, so they truly own it.
// Attaching identity never resets history: traits, compute_level, and stats are untouched, and the
// claim reconciles compute_level against the recorded 0G training payments so no paid tier is lost.
// Everything is best effort like the 0G Storage anchor: a failure leaves the agent fully playable.

export interface ArenaAgentCard {
  name: string;
  description: string;
  url: string;
  image: string | null;
  provider: { name: string; url: string };
  registrations: { agentId: number | null; agentRegistry: string; chainId: number }[];
  trustModels: string[];
  zerun: {
    kind: "arena";
    agentId: number;
    owner: string | null;
    computeLevel: number; // the tier bought with 0G
    traits: { precision: number | null; focus: number | null; speed: number | null; resilience: number | null };
    skinRoot: string | null; // 0G Storage root of the agent's skin image, when set
    profile: string;
    endpoint: string;
    createdAt: string | null;
  };
}

interface Row {
  agent_id: string;
  owner: string | null;
  name: string;
  compute_level: number | null;
  is_house: boolean | null;
  skin_root: string | null;
  trait_precision: number | null;
  trait_focus: number | null;
  trait_speed: number | null;
  trait_resilience: number | null;
  identity_token_id: string | null;
  created_at: string;
}

async function loadAgent(agentId: number): Promise<Row | null> {
  const { rows } = await query<Row>(
    `select agent_id, owner, name, compute_level, is_house, skin_root,
            trait_precision, trait_focus, trait_speed, trait_resilience,
            identity_token_id, created_at::text as created_at
       from agents_meta where agent_id = $1 limit 1`,
    [agentId],
  );
  return rows[0] ?? null;
}

// The ERC-8004 card an arena agent's on-chain agentURI resolves to. Served live so its provenance
// (compute_level, traits, skin) always reflects the agent's current state.
export async function arenaAgentCard(agentId: number): Promise<ArenaAgentCard | null> {
  const r = await loadAgent(agentId);
  if (!r) return null;
  const tokenId = r.identity_token_id === null ? null : Number(r.identity_token_id);
  return {
    name: r.name,
    description:
      `${r.name} is an agent on Zerun, the 0G agent arena. It reasons on the 0G Compute Network to ` +
      `compete across poker, world cup, prediction, and solver contests.`,
    url: "https://zerun.site/arena",
    image: null,
    provider: { name: "Zerun", url: "https://zerun.site" },
    registrations: [
      { agentId: tokenId, agentRegistry: config.identity.registry, chainId: config.identity.chainId },
    ],
    trustModels: ["reputation", "inference-validation"],
    zerun: {
      kind: "arena",
      agentId: Number(r.agent_id),
      owner: r.owner,
      computeLevel: computeLevelClamp(r.compute_level ?? 0),
      traits: {
        precision: r.trait_precision,
        focus: r.trait_focus,
        speed: r.trait_speed,
        resilience: r.trait_resilience,
      },
      skinRoot: r.skin_root,
      profile: "https://zerun.site/arena",
      endpoint: arenaAgentCardUri(Number(r.agent_id)),
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    },
  };
}

// Mint an arena agent's identity (platform-held), best effort. Skips house agents and anything already
// minted. Returns the tokenId or null. Call at registration and as a lazy step inside claim.
export async function mintArenaIdentity(agentId: number): Promise<number | null> {
  if (!identityConfigured()) return null;
  const r = await loadAgent(agentId);
  if (!r || r.is_house) return null;
  if (r.identity_token_id !== null) return Number(r.identity_token_id);
  try {
    const { tokenId, txHash } = await registerIdentity(arenaAgentCardUri(agentId));
    await query("update agents_meta set identity_token_id = $2, identity_tx = $3 where agent_id = $1", [
      agentId,
      tokenId,
      txHash,
    ]);
    return tokenId;
  } catch (err) {
    console.warn(`arena identity mint failed for agent ${agentId}:`, (err as Error).message);
    return null;
  }
}

// The compute level an agent has actually PAID for, read from the recorded 0G training payments. Used
// to reconcile on claim so a paid tier is never lost, even if a past credit did not stick.
async function paidComputeLevel(agentId: number): Promise<number> {
  const { rows } = await query<{ lvl: number | null }>(
    "select max(level_after) as lvl from compute_trainings where agent_id = $1",
    [agentId],
  );
  return computeLevelClamp(rows[0]?.lvl ?? 0);
}

// Post an arena agent's current record to the ERC-8004 ReputationRegistry, keyed to its identity. The
// headline value is its win count; the detail carries matches, wins, and the compute level it competes
// at. Best effort. `tokenId` is the identity agentId.
export async function postArenaReputation(agentId: number, tokenId: number): Promise<void> {
  const { rows } = await query<{ matches: number; wins: number; compute_level: number | null }>(
    `select count(distinct e.contest_id)::int as matches,
            (sum(case when p.rank = 1 then 1 else 0 end))::int as wins,
            (select compute_level from agents_meta where agent_id = $1) as compute_level
       from contest_entries e
       left join payouts p on p.contest_id = e.contest_id and lower(p.operator) = lower(e.operator)
      where e.agent_id = $1`,
    [agentId],
  );
  const s = rows[0];
  const wins = Number(s?.wins ?? 0);
  const matches = Number(s?.matches ?? 0);
  try {
    await postFeedback(tokenId, {
      value: wins,
      decimals: 0,
      tag1: "arena",
      tag2: "wins",
      endpoint: arenaAgentCardUri(agentId),
      detail: { matches, wins, computeLevel: computeLevelClamp(s?.compute_level ?? 0) },
    });
  } catch (err) {
    console.warn(`arena reputation post failed for agent ${agentId}:`, (err as Error).message);
  }
}

export interface ClaimResult {
  agentId: number;
  identityTokenId: number | null;
  claimed: boolean; // the NFT is now in the owner's wallet
  computeLevel: number;
  txHash: string | null;
}

// Claim an arena agent's identity for its owner: reconcile the paid compute level, ensure the identity
// is minted, and transfer the NFT to the owner's wallet so they own it on-chain. Idempotent: a second
// claim (or a token already in the owner's wallet) returns the existing state without re-transferring.
// The caller MUST have already proven `ownerWallet` controls the agent (verifyAgentOwner).
export async function claimArenaIdentity(agentId: number, ownerWallet: string): Promise<ClaimResult> {
  const owner = ownerWallet.toLowerCase();

  // 1. Honor paid tier: never let a claim drop a level the owner paid 0G for.
  const [current, paid] = await Promise.all([
    query<{ compute_level: number | null }>("select compute_level from agents_meta where agent_id = $1", [agentId]),
    paidComputeLevel(agentId),
  ]);
  const now = computeLevelClamp(current.rows[0]?.compute_level ?? 0);
  const reconciled = Math.max(now, paid);
  if (reconciled !== now) {
    await query("update agents_meta set compute_level = $2 where agent_id = $1", [agentId, reconciled]);
  }

  // 2. Ensure an identity exists (lazy mint if registration-time mint had not run or had failed).
  const tokenId = await mintArenaIdentity(agentId);
  if (tokenId === null) {
    return { agentId, identityTokenId: null, claimed: false, computeLevel: reconciled, txHash: null };
  }

  // 3. Transfer to the owner, unless the token already sits in their wallet (idempotent).
  const holder = await identityOwnerOf(tokenId);
  if (holder === owner) {
    await query(
      "update agents_meta set identity_owner = $2, claimed_at = coalesce(claimed_at, now()) where agent_id = $1",
      [agentId, owner],
    );
    // Reputation is a separate mainnet tx; don't hold the user's claim response on it (it self-logs).
    void postArenaReputation(agentId, tokenId);
    return { agentId, identityTokenId: tokenId, claimed: true, computeLevel: reconciled, txHash: null };
  }
  try {
    const txHash = await transferIdentity(tokenId, owner);
    await query("update agents_meta set identity_owner = $2, claimed_at = now() where agent_id = $1", [agentId, owner]);
    void postArenaReputation(agentId, tokenId);
    return { agentId, identityTokenId: tokenId, claimed: true, computeLevel: reconciled, txHash };
  } catch (err) {
    console.warn(`arena identity transfer failed for agent ${agentId}:`, (err as Error).message);
    // The identity exists but is still platform-held; the owner can retry the claim.
    return { agentId, identityTokenId: tokenId, claimed: false, computeLevel: reconciled, txHash: null };
  }
}

export { MAX_COMPUTE_LEVEL };
