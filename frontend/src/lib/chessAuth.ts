import { useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";

// Wallet-signature auth for a chess competition entry. The signature commits to the SHA-256 of the
// exact file, so the entry the backend stores is provably the one the player signed. The message
// string here must match backend src/auth/chessSubmitSig.ts exactly.

export interface ChessSubmitAuth {
  owner: string;
  issuedAt: number;
  signature: `0x${string}`;
}

export async function codeSha(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function chessSubmitMessage(owner: string, name: string, sha: string, issuedAt: number): string {
  return `Zerun chess submit\nwallet: ${owner.toLowerCase()}\nagent: ${name}\ncode: ${sha}\nissued: ${issuedAt}`;
}

/** Prompts the wallet to sign an entry and gives back the fields to send with the submission. */
export function useChessSubmitAuth() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  return useCallback(
    async (name: string, code: string): Promise<ChessSubmitAuth> => {
      if (!address) throw new Error("Connect your wallet first.");
      const owner = address.toLowerCase();
      const issuedAt = Date.now();
      const signature = await signMessageAsync({
        message: chessSubmitMessage(owner, name, await codeSha(code), issuedAt),
      });
      return { owner, issuedAt, signature };
    },
    [address, signMessageAsync],
  );
}
