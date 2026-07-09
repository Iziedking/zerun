import { ethers } from "ethers";

// Every agent has an address. It is derived deterministically from one extended key at
// the agent's own id, so agent #29 always has the same address, forever, and a new agent
// gets a new one without anybody generating or storing a key.
//
// The address is IDENTITY, not custody. It never holds value. An agent's 0G lives in the
// MemoryEscrow contract, where only the agent's owner can withdraw it and the coordinator
// can spend only up to an allowance the owner set, only to an immutable treasury.
//
// So this module is configured with an extended PUBLIC key (xpub), not a seed phrase.
// ethers derives the exact same addresses from a neutered node as from the signing node,
// which means the backend can name every agent's address while being cryptographically
// incapable of signing for any of them. A leaked .env leaks a list of public addresses.
//
// Generate the xpub offline, once, and keep the mnemonic somewhere this server never sees:
//
//   const m    = ethers.Mnemonic.fromPhrase("<your twelve words>");
//   const root = ethers.HDNodeWallet.fromMnemonic(m, "m/44'/60'/0'/0");
//   console.log(root.neuter().extendedKey);   // -> AGENT_WALLET_XPUB
//
// The path is the account-level node, so an agent's address is simply child `agentId`.

const XPUB = process.env.AGENT_WALLET_XPUB ?? "";

let node: ethers.HDNodeVoidWallet | null = null;
let nodeError: string | null = null;

function root(): ethers.HDNodeVoidWallet | null {
  if (node || nodeError) return node;
  if (!XPUB) {
    nodeError = "AGENT_WALLET_XPUB is not set";
    return null;
  }
  try {
    const w = ethers.HDNodeWallet.fromExtendedKey(XPUB);
    // A signing node here would mean someone put a private xprv in the env. Refuse it:
    // this module must never be able to sign for an agent.
    if (!(w instanceof ethers.HDNodeVoidWallet)) {
      nodeError = "AGENT_WALLET_XPUB is a PRIVATE extended key; use the neutered xpub";
      console.error(`agent wallets disabled: ${nodeError}`);
      return null;
    }
    node = w;
    return node;
  } catch (err) {
    nodeError = (err as Error).message;
    console.error(`agent wallets disabled: bad AGENT_WALLET_XPUB: ${nodeError}`);
    return null;
  }
}

export function agentWalletsConfigured(): boolean {
  return root() !== null;
}

/** The agent's permanent address, or null when no xpub is configured. */
export function agentAddress(agentId: number): string | null {
  const r = root();
  if (!r) return null;
  if (!Number.isInteger(agentId) || agentId < 0 || agentId > 0x7fffffff) return null;
  try {
    return r.deriveChild(agentId).address;
  } catch (err) {
    console.error(`agent wallet ${agentId}: derive failed:`, (err as Error).message);
    return null;
  }
}
