import { useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";

// Owner-signature auth for agent-scoped writes (rename, skin, scout). The backend
// verifies the signature recovers to the owner and that the owner is the agent's
// current on-chain owner, so a plaintext owner field can no longer be spoofed. The
// message string here must match backend src/auth/agentSig.ts exactly.

export interface AgentAuth {
  owner: string;
  issuedAt: number;
  signature: `0x${string}`;
}

export function agentAuthMessage(action: string, agentId: number, owner: string, issuedAt: number): string {
  return `Zerun ${action}\nagent: ${agentId}\nowner: ${owner.toLowerCase()}\nissued: ${issuedAt}`;
}

// Returns a signer that prompts the wallet to sign an action for an agent and gives
// back the fields to send with the request.
export function useAgentAuth() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  return useCallback(
    async (action: string, agentId: number): Promise<AgentAuth> => {
      if (!address) throw new Error("Connect your wallet first.");
      const owner = address.toLowerCase();
      const issuedAt = Date.now();
      const signature = await signMessageAsync({
        message: agentAuthMessage(action, agentId, owner, issuedAt),
      });
      return { owner, issuedAt, signature };
    },
    [address, signMessageAsync],
  );
}
