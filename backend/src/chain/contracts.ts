import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config/index.js";

// 0G Galileo testnet as a viem chain. Native gas token is 0G (18 decimals).
export const ogGalileo = defineChain({
  id: config.chain.chainId,
  name: "0G Galileo Testnet",
  nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
  rpcUrls: { default: { http: [config.chain.rpcUrl] } },
  blockExplorers: { default: { name: "Chainscan", url: config.chain.explorer } },
});

// Deployed addresses come from the contract deploy step, which writes
// contracts/deployments/0g-galileo.json. Env vars override for flexibility.
export interface Deployment {
  testUSDC: `0x${string}`;
  prizeEscrow: `0x${string}`;
  agentRegistry: `0x${string}`;
  contestEngine: `0x${string}`;
  deployer?: string;
  coordinator?: string;
  chainId?: number;
}

let cachedDeployment: Deployment | null = null;

export function loadDeployment(): Deployment {
  if (cachedDeployment) return cachedDeployment;

  const fromEnv = (k: string) => process.env[k] as `0x${string}` | undefined;
  const envDeployment: Partial<Deployment> = {
    testUSDC: fromEnv("ADDR_TEST_USDC"),
    prizeEscrow: fromEnv("ADDR_PRIZE_ESCROW"),
    agentRegistry: fromEnv("ADDR_AGENT_REGISTRY"),
    contestEngine: fromEnv("ADDR_CONTEST_ENGINE"),
  };
  if (
    envDeployment.testUSDC &&
    envDeployment.prizeEscrow &&
    envDeployment.agentRegistry &&
    envDeployment.contestEngine
  ) {
    cachedDeployment = envDeployment as Deployment;
    return cachedDeployment;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "../../../contracts/deployments/0g-galileo.json");
  if (!existsSync(path)) {
    throw new Error(
      `No deployment found. Deploy the contracts first, or set ADDR_* env vars. Looked at ${path}`,
    );
  }
  cachedDeployment = JSON.parse(readFileSync(path, "utf8")) as Deployment;
  return cachedDeployment;
}

export function deploymentReady(): boolean {
  try {
    loadDeployment();
    return true;
  } catch {
    return false;
  }
}

// Human-readable ABIs for exactly the calls Zerun makes. Kept minimal so the
// backend does not depend on the full artifact JSON.
export const contestEngineAbi = parseAbi([
  "function listContest(uint8 cType, address protocolTarget, bytes32 metric, uint256 prizePool, uint64 duration, uint16 winnerCutBps, uint16 topN, uint16 minTier, uint16 maxTier) returns (uint256)",
  "function registerEntry(uint256 contestId, uint256 agentId, uint256 syndicateId)",
  "function postScoreRoot(uint256 contestId, bytes32 root)",
  "function settle(uint256 contestId)",
  "function cancelContest(uint256 contestId)",
  "function claimPrize(uint256 contestId, uint256 amount, bytes32[] proof)",
  "function nextContestId() view returns (uint256)",
  "function entryCount(uint256) view returns (uint64)",
  "function prizeClaimed(uint256 contestId, address operator) view returns (bool)",
  "function getContest(uint256 contestId) view returns ((uint8 contestType, uint8 status, uint16 winnerCutBps, uint16 topN, uint16 platformFeeBps, address sponsor, address protocolTarget, bytes32 metric, uint64 startTime, uint64 endTime, uint256 prizePool, bytes32 finalRoot, uint16 minTier, uint16 maxTier))",
  "event ContestListed(uint256 indexed id, address indexed sponsor, uint8 indexed cType, address protocolTarget, uint256 prizePool)",
  "event EntryRegistered(uint256 indexed contestId, address indexed operator, uint256 indexed agentId, uint256 syndicateId)",
  "event ContestScored(uint256 indexed contestId, bytes32 scoreRoot)",
  "event ContestSettled(uint256 indexed contestId, uint256 paidOut, uint256 platformFee)",
  "event PrizeClaimed(uint256 indexed contestId, address indexed operator, uint256 amount)",
]);

export const agentRegistryAbi = parseAbi([
  "function createAgent(string metadataURI) returns (uint256)",
  "function ownerOfAgent(uint256 agentId) view returns (address)",
  "function getTier(uint256 agentId, uint8 cType) view returns (uint16)",
  "function agentsOf(address owner) view returns (uint256[])",
  "function nextAgentId() view returns (uint256)",
  "function upgradeAgent(uint256 agentId, uint8 cType, uint16 newTier)",
  "function upgradePrice(uint8 cType, uint16 fromTier) view returns (uint256)",
  "event AgentCreated(uint256 indexed agentId, address indexed owner)",
]);

export const testUsdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const prizeEscrowAbi = parseAbi([
  "function poolBalance(address controller, uint256 poolId) view returns (uint256)",
]);

export const publicClient = createPublicClient({ chain: ogGalileo, transport: http(config.chain.rpcUrl) });

// 0G's RPC can momentarily fail to find a freshly sent transaction's receipt (the
// node answering the read may not be the one that accepted the tx). Poll the
// receipt with a generous budget so the coordinator never gives up on a good
// transaction, the bug that stopped the autopilot from opening contests.
export async function waitReceipt(hash: `0x${string}`, tries = 40, delayMs = 3000) {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(
    `receipt for ${hash} not found after ${tries} tries: ${(lastErr as Error)?.message ?? ""}`,
  );
}

let _account: ReturnType<typeof privateKeyToAccount> | null = null;
// The coordinator's local signing account. Passing this object (not just the
// address) to writeContract makes viem sign locally and send a raw transaction,
// which is what the 0G node expects (it does not expose eth_sendTransaction).
export function coordinatorAccount() {
  if (_account) return _account;
  if (!config.signerKey) throw new Error("DEPLOYER_PRIVATE_KEY not set; coordinator cannot sign");
  const key = config.signerKey.startsWith("0x") ? config.signerKey : `0x${config.signerKey}`;
  _account = privateKeyToAccount(key as `0x${string}`);
  return _account;
}

let _walletClient: ReturnType<typeof createWalletClient> | null = null;
export function coordinatorWallet() {
  if (_walletClient) return _walletClient;
  _walletClient = createWalletClient({
    account: coordinatorAccount(),
    chain: ogGalileo,
    transport: http(config.chain.rpcUrl),
  });
  return _walletClient;
}

export function coordinatorAddress(): `0x${string}` {
  return coordinatorAccount().address;
}

// ContestType enum order from the contracts: SCOUT=0, ANALYST=1, SOLVER=2.
export const CONTEST_TYPE = { SCOUT: 0, ANALYST: 1, SOLVER: 2 } as const;

// 0G keeps a base fee near zero but enforces a minimum gas price around 2 gwei,
// which breaks the usual EIP-1559 fee estimate. Send every write as a legacy
// transaction with a flat price above that floor.
export const GAS_PRICE = 3_000_000_000n;
