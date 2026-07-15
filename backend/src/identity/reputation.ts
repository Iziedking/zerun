import { ethers } from "ethers";
import { config } from "../config/index.js";
import { identityConfigured } from "./erc8004.js";

// ERC-8004 REPUTATION on 0G mainnet.
//
// Zerun posts each agent's competitive standing to the canonical ReputationRegistry 0G deployed,
// keyed to the agent's identity agentId (its ERC-8004 tokenId). Zerun is the attesting "client":
// giveFeedback records a signed, timestamped, numeric standing with two tags and a detail URI, so an
// agent's record becomes composable on-chain and readable off-platform, not locked inside Zerun. This
// is what AskZero has no equivalent of.
//
// Sponsored and best effort, like identity and the 0G Storage anchor: a failure never blocks play. It
// reuses the identity wallet (same funded mainnet key) and its serialized nonce discipline, since a
// feedback post is just another mainnet transaction from that account.

const ABI = [
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function getIdentityRegistry() view returns (address)",
];

export function reputationConfigured(): boolean {
  // Same wallet/flag as identity; a reputation post needs an already-minted identity to key against.
  return identityConfigured() && Boolean(config.identity.reputationRegistry);
}

let _contract: ethers.Contract | null = null;
function getContract(): ethers.Contract {
  if (_contract) return _contract;
  const i = config.identity;
  if (!i.rpcUrl || !i.signerKey) throw new Error("ERC-8004 reputation needs IDENTITY_RPC_URL and IDENTITY_PRIVATE_KEY");
  const provider = new ethers.JsonRpcProvider(i.rpcUrl);
  const wallet = new ethers.Wallet(i.signerKey, provider);
  _contract = new ethers.Contract(i.reputationRegistry, ABI, wallet);
  return _contract;
}

// One post at a time, on the same wallet as identity mints/transfers, so nothing collides on nonce.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

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

export interface Standing {
  // The headline number for the agent's record (e.g. a conservative rating, or a win count). Encoded
  // as a fixed-point int: on-chain value = round(value * 10**decimals).
  value: number;
  decimals: number;
  tag1: string; // primary tag, e.g. the game kind ("chess", "arena")
  tag2: string; // secondary tag, e.g. the season or metric ("c1", "wins")
  endpoint: string; // the agent's card URL (its ERC-8004 service endpoint)
  detail: unknown; // a small object serialized into feedbackHash for integrity (games, wins, etc.)
}

// Post one standing to the ReputationRegistry for `agentId` (the identity tokenId). Returns the tx
// hash, or null when reputation is unconfigured. Throws on an on-chain failure so the caller can log
// it best-effort.
export async function postFeedback(agentId: number, s: Standing): Promise<string | null> {
  if (!reputationConfigured()) return null;
  return serialize(async () => {
    const contract = getContract();
    const scaled = BigInt(Math.round(s.value * 10 ** s.decimals));
    const feedbackURI = s.endpoint;
    const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(s.detail)));
    const tx = (await withTimeout(
      contract.giveFeedback!(
        agentId,
        scaled,
        s.decimals,
        s.tag1,
        s.tag2,
        s.endpoint,
        feedbackURI,
        feedbackHash,
      ) as Promise<ethers.ContractTransactionResponse>,
      config.identity.txTimeoutMs,
      "ERC-8004 giveFeedback",
    )) as ethers.ContractTransactionResponse;
    const receipt = await withTimeout(tx.wait(), config.identity.txTimeoutMs, "ERC-8004 giveFeedback confirm");
    return (receipt?.hash ?? tx.hash) as string;
  });
}
