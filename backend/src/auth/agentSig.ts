import { publicClient, loadDeployment, agentRegistryAbi } from "../chain/contracts.js";

// Owner-signature auth for agent-scoped mutations (rename, skin, scout). The DB
// mirror's owner field is public on-chain data, so a plaintext owner claim is
// spoofable; this proves the caller controls the owner key and that the owner is the
// agent's current on-chain owner. Stateless: freshness comes from a signed timestamp
// within a short window, so no server-side nonce store is needed for these low-stakes
// actions (a replay inside the window only re-does the same owner's own action).

const MAX_AGE_MS = 5 * 60 * 1000; // a signature is good for five minutes
const FUTURE_SKEW_MS = 60 * 1000; // tolerate a minute of client clock skew

export interface AgentAuth {
  owner: string;
  issuedAt: number; // unix ms, from the signer
  signature: `0x${string}`;
}

// The exact message the wallet signs. The frontend builds the same string in
// lib/agentAuth.ts; keep the two in sync.
export function agentAuthMessage(action: string, agentId: number, owner: string, issuedAt: number): string {
  return `Zerun ${action}\nagent: ${agentId}\nowner: ${owner.toLowerCase()}\nissued: ${issuedAt}`;
}

export type AuthResult =
  | { ok: true; owner: string }
  | { ok: false; error: string; status: 400 | 401 | 403 | 404 };

export async function verifyAgentOwner(
  action: string,
  agentId: number,
  auth: Partial<AgentAuth> | undefined,
): Promise<AuthResult> {
  const owner = String(auth?.owner ?? "").toLowerCase();
  const issuedAt = Number(auth?.issuedAt ?? 0);
  const signature = auth?.signature;
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner) || !issuedAt || !signature) {
    return { ok: false, error: "a wallet signature is required", status: 401 };
  }
  const now = Date.now();
  if (issuedAt > now + FUTURE_SKEW_MS || now - issuedAt > MAX_AGE_MS) {
    return { ok: false, error: "signature expired, sign again", status: 401 };
  }

  const message = agentAuthMessage(action, agentId, owner, issuedAt);
  let valid = false;
  try {
    // verifyMessage handles both EOAs and EIP-1271 smart-contract wallets.
    valid = await publicClient.verifyMessage({
      address: owner as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: "invalid signature", status: 401 };

  // Bind to the real on-chain owner so only the current owner can act, even if the
  // DB mirror is stale or was seeded by someone else.
  const dep = loadDeployment();
  let onchain = "";
  try {
    onchain = String(
      await publicClient.readContract({
        address: dep.agentRegistry,
        abi: agentRegistryAbi,
        functionName: "ownerOfAgent",
        args: [BigInt(agentId)],
      }),
    ).toLowerCase();
  } catch {
    return { ok: false, error: "could not verify agent ownership on chain", status: 400 };
  }
  if (!onchain || onchain === "0x0000000000000000000000000000000000000000") {
    return { ok: false, error: "agent does not exist on chain", status: 404 };
  }
  if (onchain !== owner) return { ok: false, error: "not the agent owner", status: 403 };

  return { ok: true, owner };
}
