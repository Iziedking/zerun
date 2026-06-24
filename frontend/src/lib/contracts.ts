import { parseAbi } from "viem";

export const agentRegistryAbi = parseAbi([
  "function createAgent(string metadataURI) returns (uint256)",
  "function ownerOfAgent(uint256) view returns (address)",
  "function agentsOf(address) view returns (uint256[])",
  "function nextAgentId() view returns (uint256)",
  "function getTier(uint256 agentId, uint8 cType) view returns (uint16)",
  "event AgentCreated(uint256 indexed agentId, address indexed owner)",
]);

// ContestType enum on chain: SCOUT=0, ANALYST=1, SOLVER=2.
export const CONTEST_TYPE = { scout: 0, analyst: 1, solver: 2 } as const;

export const testUsdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const contestEngineAbi = parseAbi([
  "function registerEntry(uint256 contestId, uint256 agentId, uint256 syndicateId)",
  "function claimPrize(uint256 contestId, uint256 amount, bytes32[] proof)",
  "function getContest(uint256) view returns ((uint8 contestType,uint8 status,uint16 winnerCutBps,uint16 topN,uint16 platformFeeBps,address sponsor,address protocolTarget,bytes32 metric,uint64 startTime,uint64 endTime,uint256 prizePool,bytes32 finalRoot,uint16 minTier,uint16 maxTier))",
  "function listContest(uint8 cType, address protocolTarget, bytes32 metric, uint256 prizePool, uint64 duration, uint16 winnerCutBps, uint16 topN, uint16 minTier, uint16 maxTier) returns (uint256)",
  "function nextContestId() view returns (uint256)",
  // Custom errors, so viem can decode reverts (e.g. a prize already claimed).
  "error AlreadyClaimed()",
  "error InvalidProof()",
  "error ContestNotSettled()",
]);
