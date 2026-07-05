import { parseAbi } from "viem";

export const agentRegistryAbi = parseAbi([
  "function createAgent(string metadataURI) returns (uint256)",
  "function ownerOfAgent(uint256) view returns (address)",
  "function agentsOf(address) view returns (uint256[])",
  "function nextAgentId() view returns (uint256)",
  "function getTier(uint256 agentId, uint8 cType) view returns (uint16)",
  "event AgentCreated(uint256 indexed agentId, address indexed owner)",
]);

// ContestType on chain: SCOUT=0, ANALYST=1, SOLVER=2. POKER=3 is a backend-only
// type the engine stores as an opaque uint8, so it needs no contract change.
export const CONTEST_TYPE = { scout: 0, analyst: 1, solver: 2, poker: 3 } as const;

export const testUsdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const contestEngineAbi = parseAbi([
  "function registerEntry(uint256 contestId, uint256 agentId, uint256 syndicateId)",
  "function claimPrize(uint256 contestId, uint256 amount, bytes32[] proof)",
  "function claimRefund(uint256 contestId)",
  "function operatorEntered(uint256, address) view returns (bool)",
  "function refundClaimed(uint256, address) view returns (bool)",
  "function prizeClaimed(uint256, address) view returns (bool)",
  "function getContest(uint256) view returns ((uint8 contestType,uint8 status,uint16 winnerCutBps,uint16 topN,uint16 platformFeeBps,address sponsor,address protocolTarget,bytes32 metric,uint64 startTime,uint64 endTime,uint256 prizePool,bytes32 finalRoot,uint16 minTier,uint16 maxTier,uint256 entryFee,uint256 feePool,uint64 resolvedAt))",
  "function listContest(uint8 cType, address protocolTarget, bytes32 metric, uint256 prizePool, uint64 duration, uint16 winnerCutBps, uint16 topN, uint16 minTier, uint16 maxTier, uint256 entryFee) returns (uint256)",
  "function nextContestId() view returns (uint256)",
  "function listingFeeBps() view returns (uint16)",
  // Emitted by listContest; read the assigned id from this rather than pre-reading
  // nextContestId, which races other listings.
  "event ContestListed(uint256 indexed id, address indexed sponsor, uint8 indexed cType, address protocolTarget, uint256 prizePool, uint256 entryFee)",
  // Custom errors, so viem can decode reverts into named errors the UI can explain.
  "error AlreadyClaimed()",
  "error InvalidProof()",
  "error ContestNotSettled()",
  "error ContestEnded()",
  "error ContestNotOpen()",
  "error AlreadyEntered()",
  "error OperatorAlreadyEntered()",
  "error NotAgentOwner()",
  "error TierNotAllowed(uint16 agentTier, uint16 minTier, uint16 maxTier)",
  "error RefundNotAvailable()",
  "error NothingToRefund()",
  "error NotEntered()",
  "error AlreadyRefunded()",
]);
