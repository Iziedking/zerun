import { createHash } from "node:crypto";
import { publicClient } from "../chain/contracts.js";

// Wallet-signature auth for a chess competition submission. Unlike agentSig, there is no on-chain
// agent to bind to — a competition entry is code, not an NFT — so all we need is proof that the
// submitter controls the wallet the entry will be credited to.
//
// The signature commits to the SHA-256 of the exact file, not just the wallet: a captured signature
// cannot be replayed with different code, and the hash we store is what the owner actually signed.

const MAX_AGE_MS = 10 * 60 * 1000; // a submission signature is good for ten minutes
const FUTURE_SKEW_MS = 60 * 1000; // tolerate a minute of client clock skew

export function codeSha(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

// The exact message the wallet signs. The frontend builds the same string in lib/chessAuth.ts;
// keep the two in sync.
export function chessSubmitMessage(owner: string, name: string, sha: string, issuedAt: number): string {
  return `Zerun chess submit\nwallet: ${owner.toLowerCase()}\nagent: ${name}\ncode: ${sha}\nissued: ${issuedAt}`;
}

export type SubmitAuth = { ok: true; owner: string } | { ok: false; error: string; status: 400 | 401 };

export async function verifyChessSubmit(
  auth: { owner?: unknown; issuedAt?: unknown; signature?: unknown } | undefined,
  name: string,
  code: string,
): Promise<SubmitAuth> {
  const owner = String(auth?.owner ?? "").toLowerCase();
  const issuedAt = Number(auth?.issuedAt ?? 0);
  const signature = String(auth?.signature ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner) || !issuedAt || !signature) {
    return { ok: false, error: "a wallet signature is required", status: 401 };
  }
  const now = Date.now();
  if (issuedAt > now + FUTURE_SKEW_MS || now - issuedAt > MAX_AGE_MS) {
    return { ok: false, error: "signature expired, sign again", status: 401 };
  }

  const message = chessSubmitMessage(owner, name, codeSha(code), issuedAt);
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
  return { ok: true, owner };
}
