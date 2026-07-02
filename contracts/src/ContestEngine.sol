// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { MerkleProof } from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import { ContestType, ContestStatus } from "./types/ZerunTypes.sol";
import { IAgentRegistry } from "./interfaces/IAgentRegistry.sol";
import { IPrizeEscrow } from "./interfaces/IPrizeEscrow.sol";

/// @title  ContestEngine
/// @notice Lifecycle for hosted contests. A host lists a contest, either by
///         staking a prize pool in USDC, by setting an entry fee that entrants
///         pay to build the pot (a challenge), or both. Agents enter, the
///         coordinator scores off-chain against a metric, posts a merkle root of
///         `(operator, amount)` payouts, and winners pull their share.
/// @dev    Settlement is merkle-proof, pull-based: no on-chain iteration over
///         entrants, no failing batch tx. USDC custody and per-pool accounting
///         live in PrizeEscrow; this contract only orchestrates and holds no
///         funds. It is UUPS-upgradeable so contest logic can evolve at a stable
///         address without a redeploy or fund migration; the escrow it settles
///         through stays immutable, so an engine upgrade can never move funds
///         outside its own merkle-proven pools. New value domains (e.g. model
///         staking) are added as separate controllers on the shared escrow, not
///         as changes here.
contract ContestEngine is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    // ============ Roles ============

    /// @notice Backend coordinator: posts score roots, settles, drives reputation.
    bytes32 public constant COORDINATOR_ROLE = keccak256("COORDINATOR_ROLE");

    // ============ Constants ============

    uint16 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Highest agent tier (mirrors AgentRegistry.MAX_TIER). Used to
    ///         validate a contest's entry tier gate.
    uint16 public constant MAX_TIER = 4;

    /// @notice Ceiling on the platform fee a contest can carry (20%).
    uint16 public constant MAX_PLATFORM_FEE_BPS = 2_000;

    /// @notice Ceiling on the listing fee (10% of the prize pool).
    uint16 public constant MAX_LISTING_FEE_BPS = 1_000;

    /// @notice Window after a contest ends during which winners can claim (and
    ///         entrants can claim a refund on a cancelled challenge). After it
    ///         elapses, leftover pool funds can be swept to treasury.
    uint256 public constant CLAIM_WINDOW = 30 days;

    // ============ Storage ============

    IAgentRegistry public agentRegistry;
    IPrizeEscrow public escrow;

    /// @notice Listing fee in bps of the prize pool, paid up front to list a
    ///         contest (separate from the settlement platform-fee skim). 0 =
    ///         free hosting. Charged on the staked pool, so a pure entry-fee
    ///         challenge (no staked pool) carries no listing fee.
    uint16 public listingFeeBps;

    /// @notice Platform fee (bps) stamped onto each contest at listing. Set by
    ///         the admin, never by the host, so a host cannot zero out the
    ///         settlement skim.
    uint16 public defaultPlatformFeeBps;

    struct Contest {
        ContestType contestType; // family; specific objective lives in `metric`
        ContestStatus status;
        uint16 winnerCutBps; // published terms: pool share to the headline tier
        uint16 topN; // published terms: number of headline winners
        uint16 platformFeeBps; // platform cut skimmed at settlement
        address sponsor; // funds the staked pool and pays the listing fee
        address protocolTarget; // protocol agents must act in; 0 if off-protocol
        bytes32 metric; // keccak256("VOLUME"/"PNL"/"BRIER"/"PUZZLE"/...)
        uint64 startTime;
        uint64 endTime;
        uint256 prizePool; // staked USDC (6 dp), escrowed at listing (may be 0)
        bytes32 finalRoot; // merkle root of (operator, amount) payouts
        uint16 minTier; // lowest agent tier allowed (0 = open)
        uint16 maxTier; // highest agent tier allowed (MAX_TIER = open top)
        // Challenge fields, appended so old decoders and future upgrades stay valid.
        uint256 entryFee; // USDC each entrant pays to enter (0 = staked-only contest)
        uint256 feePool; // accumulated entry fees, escrowed as they arrive
        // When the pool became claimable/refundable (settle or cancel). The claim
        // window is measured from here, not from endTime, so a mission that settles
        // long after its entry window (e.g. deferred World Cup resolution) still gives
        // winners and refund-owed entrants the full window before a sweep is possible.
        uint64 resolvedAt;
    }

    uint256 private _nextContestId;
    mapping(uint256 => Contest) private _contests;

    /// @notice contestId => agentId => entered (prevents the same agent twice).
    mapping(uint256 => mapping(uint256 => bool)) public agentEntered;
    /// @notice contestId => operator => entered (one entry per operator: no
    ///         Sybil flooding a pool with many owned agents).
    mapping(uint256 => mapping(address => bool)) public operatorEntered;
    /// @notice contestId => operator => prize claimed.
    mapping(uint256 => mapping(address => bool)) public prizeClaimed;
    /// @notice contestId => operator => entry-fee refund claimed (cancelled challenge).
    mapping(uint256 => mapping(address => bool)) public refundClaimed;
    /// @notice contestId => number of registered entries.
    mapping(uint256 => uint64) public entryCount;

    /// @notice A generic per-contest parameter store the coordinator can set, so
    ///         future features can attach data to a contest without a storage
    ///         layout change or an upgrade. contestId => key => value.
    mapping(uint256 => mapping(bytes32 => uint256)) public contestParam;

    /// @dev Reserved storage for future upgrades (append new state above this and
    ///      shrink the gap to preserve layout).
    uint256[50] private __gap;

    // ============ Events ============

    event ContestListed(
        uint256 indexed id,
        address indexed sponsor,
        ContestType indexed cType,
        address protocolTarget,
        uint256 prizePool,
        uint256 entryFee
    );
    event EntryRegistered(
        uint256 indexed contestId,
        address indexed operator,
        uint256 indexed agentId,
        uint256 syndicateId
    );
    event ContestScored(uint256 indexed contestId, bytes32 scoreRoot);
    event ContestSettled(uint256 indexed contestId, uint256 paidOut, uint256 platformFee);
    event PrizeClaimed(uint256 indexed contestId, address indexed operator, uint256 amount);
    event RefundClaimed(uint256 indexed contestId, address indexed operator, uint256 amount);
    event ReputationApplied(uint256 indexed contestId, uint256 count);
    event ContestCancelled(uint256 indexed contestId, uint256 refunded);
    event UnclaimedSwept(uint256 indexed contestId);
    event ContestParamSet(uint256 indexed contestId, bytes32 indexed key, uint256 value);
    event ListingFeeUpdated(uint16 oldBps, uint16 newBps);
    event PlatformFeeUpdated(uint16 oldBps, uint16 newBps);

    // ============ Errors ============

    error ZeroAddress();
    error ZeroPrizePool();
    error ZeroDuration();
    error InvalidMetric();
    error InvalidBps();
    error InvalidTopN();
    error FeeTooHigh();
    error ContestDoesNotExist();
    error ContestNotOpen();
    error ContestEnded();
    error ContestNotEnded();
    error NotAgentOwner();
    error AlreadyEntered();
    error OperatorAlreadyEntered();
    error InvalidTierGate();
    error TierNotAllowed(uint16 agentTier, uint16 minTier, uint16 maxTier);
    error InvalidRoot();
    error ContestNotScoring();
    error ContestNotSettled();
    error AlreadyClaimed();
    error InvalidProof();
    error LengthMismatch();
    error NotAuthorized();
    error CannotCancel();
    error ClaimWindowOpen();
    error RefundNotAvailable();
    error NothingToRefund();
    error NotEntered();
    error AlreadyRefunded();

    // ============ Initializer ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the engine behind its proxy. Grants the admin role and
    ///         wires the registry and escrow (which this engine must be granted
    ///         CONTROLLER_ROLE / CONTEST_ENGINE_ROLE on).
    function initialize(
        address admin,
        address agentRegistryAddr,
        address escrowAddr,
        uint16 listingFeeBps_,
        uint16 platformFeeBps_
    ) external initializer {
        if (admin == address(0)) revert ZeroAddress();
        if (agentRegistryAddr == address(0)) revert ZeroAddress();
        if (escrowAddr == address(0)) revert ZeroAddress();
        if (platformFeeBps_ > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh();
        if (listingFeeBps_ > MAX_LISTING_FEE_BPS) revert FeeTooHigh();

        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        agentRegistry = IAgentRegistry(agentRegistryAddr);
        escrow = IPrizeEscrow(escrowAddr);
        listingFeeBps = listingFeeBps_;
        defaultPlatformFeeBps = platformFeeBps_;
        _nextContestId = 1;
    }

    /// @notice UUPS upgrade authorization. Only the admin can point the proxy at a
    ///         new implementation.
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @notice Human-readable implementation version, bumped on each upgrade.
    function version() external pure virtual returns (string memory) {
        return "2.0.0";
    }

    // ============ Host path ============

    /// @notice List a hosted contest in one tx. Provide a staked `prizePool`
    ///         (approve the escrow for it plus the listing fee), an `entryFee`
    ///         that entrants pay to build the pot, or both. At least one of the
    ///         two must be non-zero.
    /// @param  cType         Contest family.
    /// @param  protocolTarget Protocol agents must interact with (0 if off-protocol).
    /// @param  metric        Scoring objective id, e.g. keccak256("VOLUME").
    /// @param  prizePool     Staked USDC (6 dp) put up for winners, escrowed now (may be 0).
    /// @param  duration      Seconds the contest stays open for entries/scoring.
    /// @param  winnerCutBps  Published share of the pool to the headline tier.
    /// @param  topN          Published headline winner count.
    /// @param  minTier       Lowest agent tier allowed to enter (0 = open).
    /// @param  maxTier       Highest agent tier allowed (MAX_TIER = open top).
    /// @param  entryFee      USDC (6 dp) each entrant pays to enter (0 = staked-only).
    /// @dev    The platform fee is not a parameter; the admin-set
    ///         `defaultPlatformFeeBps` is stamped onto the contest so a host
    ///         cannot avoid the skim. A fully open contest passes
    ///         (minTier=0, maxTier=MAX_TIER).
    function listContest(
        ContestType cType,
        address protocolTarget,
        bytes32 metric,
        uint256 prizePool,
        uint64 duration,
        uint16 winnerCutBps,
        uint16 topN,
        uint16 minTier,
        uint16 maxTier,
        uint256 entryFee
    ) external whenNotPaused nonReentrant returns (uint256 contestId) {
        if (prizePool == 0 && entryFee == 0) revert ZeroPrizePool();
        if (duration == 0) revert ZeroDuration();
        if (metric == bytes32(0)) revert InvalidMetric();
        if (winnerCutBps > BPS_DENOMINATOR) revert InvalidBps();
        if (topN == 0) revert InvalidTopN();
        if (maxTier > MAX_TIER || minTier > maxTier) revert InvalidTierGate();

        contestId = _nextContestId++;
        uint64 nowTs = uint64(block.timestamp);

        _contests[contestId] = Contest({
            contestType: cType,
            status: ContestStatus.OPEN,
            winnerCutBps: winnerCutBps,
            topN: topN,
            platformFeeBps: defaultPlatformFeeBps,
            sponsor: msg.sender,
            protocolTarget: protocolTarget,
            metric: metric,
            startTime: nowTs,
            endTime: nowTs + duration,
            prizePool: prizePool,
            finalRoot: bytes32(0),
            minTier: minTier,
            maxTier: maxTier,
            entryFee: entryFee,
            feePool: 0,
            resolvedAt: 0
        });

        // Effects set above; now interactions (CEI ordering, guarded by nonReentrant).
        // Listing fee is a percentage of the staked pool, charged up front to treasury.
        uint256 listingFee = (prizePool * listingFeeBps) / BPS_DENOMINATOR;
        if (listingFee > 0) escrow.collectListingFee(msg.sender, listingFee);
        if (prizePool > 0) escrow.depositPrizePool(contestId, msg.sender, prizePool);

        emit ContestListed(contestId, msg.sender, cType, protocolTarget, prizePool, entryFee);
    }

    // ============ Operator path ============

    /// @notice Enter an owned agent into an open contest. On an entry-fee
    ///         challenge the operator must have approved the PrizeEscrow for the
    ///         entry fee, which is pulled into the pot on entry. Qualification
    ///         thresholds beyond the tier gate are enforced off-chain by the
    ///         coordinator at scoring time.
    function registerEntry(uint256 contestId, uint256 agentId, uint256 syndicateId)
        external
        whenNotPaused
        nonReentrant
    {
        Contest storage c = _contests[contestId];
        if (c.sponsor == address(0)) revert ContestDoesNotExist();
        if (c.status != ContestStatus.OPEN) revert ContestNotOpen();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= c.endTime) revert ContestEnded();
        if (agentRegistry.ownerOfAgent(agentId) != msg.sender) revert NotAgentOwner();
        if (agentEntered[contestId][agentId]) revert AlreadyEntered();
        if (operatorEntered[contestId][msg.sender]) revert OperatorAlreadyEntered();

        // Tier gate: the agent's tier in this contest's family must sit within
        // [minTier, maxTier]. A fully open contest (0..MAX_TIER) never rejects.
        uint16 tier = agentRegistry.getTier(agentId, c.contestType);
        if (tier < c.minTier || tier > c.maxTier) {
            revert TierNotAllowed(tier, c.minTier, c.maxTier);
        }

        // Effects.
        agentEntered[contestId][agentId] = true;
        operatorEntered[contestId][msg.sender] = true;
        unchecked {
            entryCount[contestId] += 1;
        }

        // Interaction: pull the entry fee into the pot (the operator approved the
        // escrow). Effects on feePool are recorded before the external call.
        uint256 fee = c.entryFee;
        if (fee > 0) {
            c.feePool += fee;
            escrow.depositChallengePot(contestId, msg.sender, fee);
        }

        emit EntryRegistered(contestId, msg.sender, agentId, syndicateId);
    }

    /// @notice Claim a prize with a merkle proof of the `(operator, amount)`
    ///         leaf against the settled contest's root. Pull-based: each winner
    ///         claims their own share.
    /// @dev    Leaf is double-hashed to match OpenZeppelin's StandardMerkleTree
    ///         encoding `['address','uint256']`.
    function claimPrize(uint256 contestId, uint256 amount, bytes32[] calldata proof)
        external
        whenNotPaused
        nonReentrant
    {
        Contest storage c = _contests[contestId];
        if (c.status != ContestStatus.SETTLED) revert ContestNotSettled();
        if (prizeClaimed[contestId][msg.sender]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verify(proof, c.finalRoot, leaf)) revert InvalidProof();

        prizeClaimed[contestId][msg.sender] = true;
        escrow.payout(contestId, msg.sender, amount);

        emit PrizeClaimed(contestId, msg.sender, amount);
    }

    /// @notice On a cancelled entry-fee challenge, each entrant pulls their entry
    ///         fee back. Pull-based, mirroring claims: no iteration, no failing
    ///         batch. The staked base pool is refunded to the sponsor at cancel.
    function claimRefund(uint256 contestId) external whenNotPaused nonReentrant {
        Contest storage c = _contests[contestId];
        if (c.sponsor == address(0)) revert ContestDoesNotExist();
        if (c.status != ContestStatus.CANCELLED) revert RefundNotAvailable();
        if (c.entryFee == 0) revert NothingToRefund();
        if (!operatorEntered[contestId][msg.sender]) revert NotEntered();
        if (refundClaimed[contestId][msg.sender]) revert AlreadyRefunded();

        refundClaimed[contestId][msg.sender] = true;
        escrow.payout(contestId, msg.sender, c.entryFee);

        emit RefundClaimed(contestId, msg.sender, c.entryFee);
    }

    // ============ Coordinator path ============

    /// @notice Post the merkle root of final `(operator, amount)` payouts.
    ///         Only after the contest's entry window has ended.
    function postScoreRoot(uint256 contestId, bytes32 root)
        external
        onlyRole(COORDINATOR_ROLE)
    {
        Contest storage c = _contests[contestId];
        if (c.sponsor == address(0)) revert ContestDoesNotExist();
        if (c.status != ContestStatus.OPEN) revert ContestNotOpen();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < c.endTime) revert ContestNotEnded();
        if (root == bytes32(0)) revert InvalidRoot();

        c.finalRoot = root;
        c.status = ContestStatus.SCORING;

        emit ContestScored(contestId, root);
    }

    /// @notice Finalize a scored contest: skim the platform fee on the whole pot
    ///         (staked pool plus collected entry fees) and open it for claims.
    function settle(uint256 contestId) external onlyRole(COORDINATOR_ROLE) nonReentrant {
        Contest storage c = _contests[contestId];
        if (c.sponsor == address(0)) revert ContestDoesNotExist();
        if (c.status != ContestStatus.SCORING) revert ContestNotScoring();

        c.status = ContestStatus.SETTLED;
        c.resolvedAt = uint64(block.timestamp);

        uint256 total = c.prizePool + c.feePool;
        uint256 platformFee = (total * c.platformFeeBps) / BPS_DENOMINATOR;
        if (platformFee > 0) escrow.skimPlatformFee(contestId, platformFee);

        emit ContestSettled(contestId, total - platformFee, platformFee);
    }

    /// @notice Apply in-game reputation deltas for a contest's agents. The
    ///         coordinator computes placements off-chain and chunks the call;
    ///         this forwards each delta to AgentRegistry (which only this
    ///         contract is authorized to call).
    function applyReputationDeltas(
        uint256 contestId,
        uint256[] calldata agentIds,
        int128[] calldata deltas
    ) external onlyRole(COORDINATOR_ROLE) {
        Contest storage c = _contests[contestId];
        if (c.sponsor == address(0)) revert ContestDoesNotExist();
        if (c.status != ContestStatus.SCORING && c.status != ContestStatus.SETTLED) {
            revert ContestNotScoring();
        }

        uint256 n = agentIds.length;
        if (n != deltas.length) revert LengthMismatch();

        for (uint256 i = 0; i < n; i++) {
            agentRegistry.applyReputationChange(agentIds[i], deltas[i]);
        }

        emit ReputationApplied(contestId, n);
    }

    /// @notice Set a generic per-contest parameter. A forward-compatibility hook
    ///         so new features can attach data to a contest without a new storage
    ///         layout or an upgrade.
    function setContestParam(uint256 contestId, bytes32 key, uint256 value)
        external
        onlyRole(COORDINATOR_ROLE)
    {
        if (_contests[contestId].sponsor == address(0)) revert ContestDoesNotExist();
        contestParam[contestId][key] = value;
        emit ContestParamSet(contestId, key, value);
    }

    // ============ Admin / recovery ============

    /// @notice Cancel a contest before claims complete. The staked base pool is
    ///         refunded to the sponsor; on a challenge each entrant then pulls
    ///         their entry fee back via `claimRefund`. Coordinator or admin only.
    function cancelContest(uint256 contestId) external nonReentrant {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(COORDINATOR_ROLE, msg.sender)) {
            revert NotAuthorized();
        }

        Contest storage c = _contests[contestId];
        if (c.sponsor == address(0)) revert ContestDoesNotExist();
        if (c.status != ContestStatus.OPEN && c.status != ContestStatus.SCORING) {
            revert CannotCancel();
        }

        c.status = ContestStatus.CANCELLED;
        c.resolvedAt = uint64(block.timestamp);

        // Refund only the staked base pool to the sponsor. Any collected entry
        // fees stay escrowed for entrants to reclaim via claimRefund.
        uint256 refund = c.prizePool;
        if (refund > 0) escrow.payout(contestId, c.sponsor, refund);

        emit ContestCancelled(contestId, refund);
    }

    /// @notice After the claim window, sweep any leftover pool funds (unclaimed
    ///         prizes on a settled contest, or unclaimed entry-fee refunds on a
    ///         cancelled challenge) to the treasury. Anyone can trigger recovery.
    /// @dev    The window runs from `resolvedAt` (settle or cancel time), not from
    ///         the entry window's end, so a mission that resolves long after its
    ///         entry window still gives winners and entrants the full window to
    ///         claim before anyone can sweep.
    function sweepUnclaimed(uint256 contestId) external {
        Contest storage c = _contests[contestId];
        if (c.sponsor == address(0)) revert ContestDoesNotExist();
        if (c.status != ContestStatus.SETTLED && c.status != ContestStatus.CANCELLED) {
            revert ContestNotSettled();
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (c.resolvedAt == 0 || block.timestamp < uint256(c.resolvedAt) + CLAIM_WINDOW) {
            revert ClaimWindowOpen();
        }

        escrow.sweepUnclaimed(contestId);

        emit UnclaimedSwept(contestId);
    }

    function setListingFeeBps(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps > MAX_LISTING_FEE_BPS) revert FeeTooHigh();
        emit ListingFeeUpdated(listingFeeBps, newBps);
        listingFeeBps = newBps;
    }

    function setDefaultPlatformFeeBps(uint16 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh();
        emit PlatformFeeUpdated(defaultPlatformFeeBps, newBps);
        defaultPlatformFeeBps = newBps;
    }

    /// @notice Emergency stop: blocks new listings, entries, claims, and refunds.
    ///         Admin only. Settlement and recovery (cancel/refund/sweep) that
    ///         unwind a pool stay reachable once unpaused.
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============ Views ============

    function getContest(uint256 contestId) external view returns (Contest memory) {
        return _contests[contestId];
    }

    function nextContestId() external view returns (uint256) {
        return _nextContestId;
    }
}
