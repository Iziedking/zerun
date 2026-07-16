import { ethers } from "ethers";
import { config } from "../config/index.js";

// ERC-8004 agent identity on 0G MAINNET.
//
// Every uploaded chess agent gets a portable, on-chain identity minted against the canonical
// IdentityRegistry that 0G itself deployed (chain 16661, vanity address 0x8004A16…). We deploy no
// contract of our own. The identity's agentURI resolves to the agent's card endpoint on this
// backend, which carries the same 0G provenance we already store (code_sha + 0G Storage root), so
// "this agent competed on Zerun, thinking on 0G" is provable off-platform by any ERC-8004 explorer.
//
// This is a deepener, not the money path. Like the 0G Storage anchor, every call is BEST EFFORT: a
// mint failure is logged and never blocks a player from entering the ladder. A missing identity is
// simply minted later by the backfill script (scripts/chessMintIdentities.ts).
//
// Sponsorship + nonce isolation: minting is signed by IDENTITY_PRIVATE_KEY, a funded mainnet wallet
// kept SEPARATE from the compute mainnet wallet so mint transactions never collide on nonce with the
// broker's ledger writes. Mints are serialized through one queue for the same reason.

// Pinned to the authoritative ABI 0G deployed (erc-8004/erc-8004-contracts, abis/IdentityRegistry.json,
// verified live against the on-chain contract). register(uri) mints an ERC-721 to the caller (us) and
// returns the agentId; we read that id from the Registered event, whose agentId/owner are INDEXED, so
// the indexing here must match exactly or the id is misparsed. setAgentURI/getAgentWallet are for the
// later "claim" and refresh phases; the hot path only needs register + name (the resolve check).
const ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
];

export function identityConfigured(): boolean {
  const i = config.identity;
  return i.enabled && Boolean(i.rpcUrl) && Boolean(i.signerKey) && Boolean(i.registry);
}

// Whether the cutoff has passed, so a claimed identity is now REQUIRED to compete. Only meaningful
// when identity is configured; before the cutoff (or with it unset) claiming stays optional.
export function identityRequiredNow(): boolean {
  const t = config.identity.requiredAfter;
  return identityConfigured() && t > 0 && Date.now() >= t;
}

// The one funded mainnet wallet that signs every ERC-8004 write (identity mints/transfers, reputation
// feedback, and validation anchors). Shared so all three modules build transactions on ONE wallet and
// ONE nonce sequence. Exported so reputation.ts and receipts.ts reuse it instead of making their own.
let _wallet: ethers.Wallet | null = null;
export function getIdentityWallet(): ethers.Wallet {
  if (_wallet) return _wallet;
  const i = config.identity;
  if (!i.rpcUrl || !i.signerKey) throw new Error("ERC-8004 identity needs IDENTITY_RPC_URL and IDENTITY_PRIVATE_KEY");
  _wallet = new ethers.Wallet(i.signerKey, new ethers.JsonRpcProvider(i.rpcUrl));
  return _wallet;
}

let _contract: ethers.Contract | null = null;
function getContract(): ethers.Contract {
  if (!_contract) _contract = new ethers.Contract(config.identity.registry, ABI, getIdentityWallet());
  return _contract;
}

// One write at a time across ALL identity-wallet modules. Two concurrent transactions would otherwise
// build on the same nonce and all but one would revert. This queue is shared (exported) so reputation
// and validation writes serialize against identity mints/transfers too, not just among themselves.
let chain: Promise<unknown> = Promise.resolve();
export function identityWalletWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
const serialize = identityWalletWrite;

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

export interface MintResult {
  tokenId: number;
  txHash: string;
}

// Mint an agent's identity. `agentURI` is the public, explorer-resolvable card endpoint. Returns the
// on-chain agentId and the mint tx hash. Throws on failure; callers treat it as best effort.
export async function registerIdentity(agentURI: string): Promise<MintResult> {
  return serialize(async () => {
    const contract = getContract();
    const tx = (await withTimeout(
      contract.register!(agentURI) as Promise<ethers.ContractTransactionResponse>,
      config.identity.txTimeoutMs,
      "ERC-8004 register",
    )) as ethers.ContractTransactionResponse;
    const receipt = await withTimeout(tx.wait(), config.identity.txTimeoutMs, "ERC-8004 register confirm");

    // The agentId is the tokenId returned by register(); read it from the Registered event rather
    // than a return value, which is not available from a mined transaction.
    let tokenId: number | null = null;
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed?.name === "Registered") {
          tokenId = Number(parsed.args.agentId);
          break;
        }
      } catch {
        // not one of our events; skip
      }
    }
    if (tokenId === null) throw new Error("ERC-8004 register mined but no Registered event was found");
    return { tokenId, txHash: (receipt?.hash ?? tx.hash) as string };
  });
}

// Transfer a minted identity from the platform (the holder) to the agent owner's wallet. This is what
// a CLAIM does: the user ends up owning the ERC-8004 NFT on-chain (ownerOf = user). Sponsored: the
// platform pays gas. Serialized on the same nonce queue as mints. Throws on failure (best effort at
// the call site). No-op-safe to call only when the platform still holds the token.
export async function transferIdentity(tokenId: number, toWallet: string): Promise<string> {
  return serialize(async () => {
    const contract = getContract();
    const from = await (contract.runner as ethers.Wallet).getAddress();
    const tx = (await withTimeout(
      contract.safeTransferFrom!(from, toWallet, tokenId) as Promise<ethers.ContractTransactionResponse>,
      config.identity.txTimeoutMs,
      "ERC-8004 transfer",
    )) as ethers.ContractTransactionResponse;
    const receipt = await withTimeout(tx.wait(), config.identity.txTimeoutMs, "ERC-8004 transfer confirm");
    return (receipt?.hash ?? tx.hash) as string;
  });
}

// The current on-chain owner of an identity, lowercased, or null if it can't be read. Used to make the
// claim transfer idempotent: if the token already sits in the user's wallet, we skip the transfer.
export async function identityOwnerOf(tokenId: number): Promise<string | null> {
  try {
    const contract = getContract();
    const owner = (await withTimeout(contract.ownerOf!(tokenId), config.identity.txTimeoutMs, "ERC-8004 ownerOf")) as string;
    return owner.toLowerCase();
  } catch {
    return null;
  }
}

// The explorer-resolvable agentURI for a chess agent, keyed by our internal id (known before the mint,
// unlike the on-chain agentId). The card served there stays current across re-uploads, so the URI is
// stable and never needs an on-chain refresh.
export function chessAgentCardUri(agentDbId: number): string {
  return `${config.publicApiUrl.replace(/\/+$/, "")}/api/chess/agents/${agentDbId}/card.json`;
}

// The explorer-resolvable agentURI for an arena agent (agents_meta), keyed by its on-chain Zerun agentId.
export function arenaAgentCardUri(agentId: number): string {
  return `${config.publicApiUrl.replace(/\/+$/, "")}/api/agents/${agentId}/card.json`;
}

// The 0G mainnet explorer link for the identity registry contract. chainscan.0g.ai has no working
// per-token page for a large-supply ERC-721, so we link the contract address (a verified route); the
// token id is reported separately by callers.
export function identityExplorerUrl(_tokenId: number): string {
  return `https://chainscan.0g.ai/address/${config.identity.registry}`;
}

export interface IdentityStatus {
  enabled: boolean;
  configured: boolean;
  registry: string;
  configuredChainId: number;
  signer: string | null;
  connectedChainId: number | null;
  balanceOg: string | null; // native 0G balance of the minting wallet (gas)
  registryName: string | null; // the registry's ERC-721 name, proves the ABI + address resolve
  error?: string;
}

// Read-only preflight: confirms the RPC, registry address, and ABI all resolve, and reports the
// minting wallet's gas balance. Spends nothing. Used by scripts/chessIdentityCheck.ts before a launch.
export async function identityStatus(): Promise<IdentityStatus> {
  const i = config.identity;
  const base: IdentityStatus = {
    enabled: i.enabled,
    configured: identityConfigured(),
    registry: i.registry,
    configuredChainId: i.chainId,
    signer: null,
    connectedChainId: null,
    balanceOg: null,
    registryName: null,
  };
  if (!i.rpcUrl || !i.signerKey) {
    return { ...base, error: "IDENTITY_RPC_URL or IDENTITY_PRIVATE_KEY is not set" };
  }
  try {
    const provider = new ethers.JsonRpcProvider(i.rpcUrl);
    const wallet = new ethers.Wallet(i.signerKey, provider);
    const readonly = new ethers.Contract(i.registry, ABI, provider);
    const [bal, regName, net] = await Promise.all([
      provider.getBalance(wallet.address),
      readonly.name!() as Promise<string>,
      provider.getNetwork(),
    ]);
    return {
      ...base,
      signer: wallet.address,
      connectedChainId: Number(net.chainId),
      balanceOg: ethers.formatEther(bal),
      registryName: regName,
    };
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}
