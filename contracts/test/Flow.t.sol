// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { TestUSDC } from "../src/TestUSDC.sol";
import { PrizeEscrow } from "../src/PrizeEscrow.sol";
import { AgentRegistry } from "../src/AgentRegistry.sol";
import { ContestEngine } from "../src/ContestEngine.sol";
import { ContestType, ContestStatus } from "../src/types/ZerunTypes.sol";

/// @notice ContestEngine v2 flows: the staked happy path (list -> register ->
///         score -> settle -> claim), entry-fee challenges (fees build the pot),
///         per-entrant refunds on a cancelled challenge, and a UUPS upgrade that
///         preserves state. The engine runs behind an ERC1967 proxy.
contract FlowTest is Test {
    TestUSDC internal usdc;
    PrizeEscrow internal escrow;
    AgentRegistry internal registry;
    ContestEngine internal engine;

    address internal admin = makeAddr("admin");
    address internal coordinator = makeAddr("coordinator");
    address internal sponsor = makeAddr("sponsor");
    address internal winner = makeAddr("winner");
    address internal other = makeAddr("other");

    function setUp() public {
        vm.startPrank(admin);
        usdc = new TestUSDC();
        escrow = new PrizeEscrow(admin, address(usdc), admin);
        registry = new AgentRegistry(admin, address(usdc), admin);

        // Engine behind a UUPS proxy, initialized in one step.
        ContestEngine impl = new ContestEngine();
        bytes memory initData = abi.encodeCall(
            ContestEngine.initialize, (admin, address(registry), address(escrow), 0, 500)
        );
        engine = ContestEngine(address(new ERC1967Proxy(address(impl), initData)));

        escrow.grantRole(escrow.CONTROLLER_ROLE(), address(engine));
        registry.grantRole(registry.CONTEST_ENGINE_ROLE(), address(engine));
        engine.grantRole(engine.COORDINATOR_ROLE(), coordinator);
        vm.stopPrank();
    }

    // ---- helpers ----

    /// @dev Match ContestEngine.claimPrize leaf encoding.
    function _leaf(address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    /// @dev Commutative pair hash, matching OZ MerkleProof.verify.
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    /// @dev An operator creates an agent, is minted the fee, approves the escrow,
    ///      and enters, paying the entry fee into the pot.
    function _enterPaying(uint256 contestId, address op, uint256 fee) internal {
        vm.prank(op);
        uint256 agentId = registry.createAgent("ipfs://agent");
        usdc.mint(op, fee);
        vm.prank(op);
        usdc.approve(address(escrow), fee);
        vm.prank(op);
        engine.registerEntry(contestId, agentId, 0);
    }

    // ---- tests ----

    function testFullFlow() public {
        uint256 prizePool = 1_000e6;
        usdc.mint(sponsor, prizePool);

        vm.startPrank(sponsor);
        usdc.approve(address(escrow), prizePool);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), prizePool, 1 days, 5_000, 1, 0, engine.MAX_TIER(), 0
        );
        vm.stopPrank();

        assertEq(escrow.poolBalance(address(engine), contestId), prizePool);

        vm.prank(winner);
        uint256 agentId = registry.createAgent("ipfs://agent-1");
        vm.prank(winner);
        engine.registerEntry(contestId, agentId, 0);

        vm.warp(block.timestamp + 1 days + 1);

        uint256 award = prizePool - (prizePool * 500) / 10_000;
        bytes32 root = _hashPair(_leaf(winner, award), _leaf(other, 1));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _leaf(other, 1);

        vm.startPrank(coordinator);
        engine.postScoreRoot(contestId, root);
        engine.settle(contestId);
        vm.stopPrank();

        vm.prank(winner);
        engine.claimPrize(contestId, award, proof);
        assertEq(usdc.balanceOf(winner), award);
        assertEq(usdc.balanceOf(admin), (prizePool * 500) / 10_000);
    }

    function testEntryFeeChallenge() public {
        uint256 fee = 100e6;

        // A pure challenge: no staked pool, entry fees build the pot.
        vm.prank(sponsor);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), 0, 1 days, 5_000, 1, 0, engine.MAX_TIER(), fee
        );

        _enterPaying(contestId, winner, fee);
        _enterPaying(contestId, other, fee);

        assertEq(escrow.poolBalance(address(engine), contestId), 2 * fee);
        assertEq(engine.getContest(contestId).feePool, 2 * fee);

        vm.warp(block.timestamp + 1 days + 1);

        uint256 total = 2 * fee;
        uint256 platformFee = (total * 500) / 10_000;
        uint256 award = total - platformFee;
        bytes32 root = _hashPair(_leaf(winner, award), _leaf(other, 1));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _leaf(other, 1);

        vm.startPrank(coordinator);
        engine.postScoreRoot(contestId, root);
        engine.settle(contestId);
        vm.stopPrank();

        vm.prank(winner);
        engine.claimPrize(contestId, award, proof);
        assertEq(usdc.balanceOf(winner), award); // minted `fee`, paid it, claimed `award`
        assertEq(usdc.balanceOf(admin), platformFee);
    }

    function testChallengeRefund() public {
        uint256 fee = 100e6;
        vm.prank(sponsor);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), 0, 1 days, 5_000, 1, 0, engine.MAX_TIER(), fee
        );
        _enterPaying(contestId, winner, fee);
        _enterPaying(contestId, other, fee);
        assertEq(escrow.poolBalance(address(engine), contestId), 2 * fee);

        vm.prank(coordinator);
        engine.cancelContest(contestId);

        vm.prank(winner);
        engine.claimRefund(contestId);
        assertEq(usdc.balanceOf(winner), fee);

        vm.prank(other);
        engine.claimRefund(contestId);
        assertEq(usdc.balanceOf(other), fee);
        assertEq(escrow.poolBalance(address(engine), contestId), 0);

        // Double refund and non-entrant refund both revert.
        vm.prank(winner);
        vm.expectRevert(ContestEngine.AlreadyRefunded.selector);
        engine.claimRefund(contestId);

        vm.prank(sponsor);
        vm.expectRevert(ContestEngine.NotEntered.selector);
        engine.claimRefund(contestId);
    }

    function testListRequiresPoolOrFee() public {
        uint16 maxTier = engine.MAX_TIER(); // resolve the view before expectRevert
        vm.prank(sponsor);
        vm.expectRevert(ContestEngine.ZeroPrizePool.selector);
        engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), 0, 1 days, 5_000, 1, 0, maxTier, 0
        );
    }

    function testUpgradePreservesState() public {
        uint256 prizePool = 500e6;
        usdc.mint(sponsor, prizePool);
        vm.startPrank(sponsor);
        usdc.approve(address(escrow), prizePool);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), prizePool, 1 days, 5_000, 1, 0, engine.MAX_TIER(), 0
        );
        vm.stopPrank();

        assertEq(engine.version(), "2.0.2");
        uint256 nextBefore = engine.nextContestId();

        // Admin upgrades the implementation; state must survive.
        ContestEngineV2Mock newImpl = new ContestEngineV2Mock();
        vm.prank(admin);
        engine.upgradeToAndCall(address(newImpl), "");

        assertEq(engine.version(), "9.9.9");
        assertEq(engine.nextContestId(), nextBefore);
        ContestEngine.Contest memory c = engine.getContest(contestId);
        assertEq(c.prizePool, prizePool);
        assertEq(uint8(c.status), uint8(ContestStatus.OPEN));

        // A non-admin cannot upgrade.
        ContestEngineV2Mock newImpl2 = new ContestEngineV2Mock();
        vm.prank(other);
        vm.expectRevert();
        engine.upgradeToAndCall(address(newImpl2), "");
    }

    /// @dev The claim window runs from settlement, not from the entry window's end,
    ///      so a mission that settles long after endTime (deferred resolution) still
    ///      protects winners from an early sweep.
    function testSweepWindowAnchoredToSettlement() public {
        uint256 prizePool = 1_000e6;
        usdc.mint(sponsor, prizePool);
        vm.startPrank(sponsor);
        usdc.approve(address(escrow), prizePool);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), prizePool, 1 days, 5_000, 1, 0, engine.MAX_TIER(), 0
        );
        vm.stopPrank();

        vm.prank(winner);
        uint256 agentId = registry.createAgent("ipfs://a");
        vm.prank(winner);
        engine.registerEntry(contestId, agentId, 0);

        // Settle 40 days after endTime, well past endTime + CLAIM_WINDOW.
        vm.warp(block.timestamp + 40 days);

        uint256 partAward = 400e6; // claim part, leaving a remainder to sweep later
        bytes32 root = _hashPair(_leaf(winner, partAward), _leaf(other, 1));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _leaf(other, 1);
        vm.startPrank(coordinator);
        engine.postScoreRoot(contestId, root);
        engine.settle(contestId);
        vm.stopPrank();

        // Despite being 40 days past endTime, the window runs from settlement, so a
        // sweep is not yet possible and the winner can still claim.
        vm.expectRevert(ContestEngine.ClaimWindowOpen.selector);
        engine.sweepUnclaimed(contestId);

        vm.prank(winner);
        engine.claimPrize(contestId, partAward, proof);
        assertEq(usdc.balanceOf(winner), partAward);

        // After the window from settlement, the unclaimed remainder sweeps to treasury.
        uint256 platformFee = (prizePool * 500) / 10_000;
        uint256 remainder = (prizePool - platformFee) - partAward;
        uint256 treasuryBefore = usdc.balanceOf(admin);
        vm.warp(block.timestamp + 30 days + 1);
        engine.sweepUnclaimed(contestId);
        assertEq(usdc.balanceOf(admin) - treasuryBefore, remainder);
    }

    function testAccessControlNegatives() public {
        uint256 prizePool = 100e6;
        usdc.mint(sponsor, prizePool);
        vm.startPrank(sponsor);
        usdc.approve(address(escrow), prizePool);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), prizePool, 1 days, 5_000, 1, 0, engine.MAX_TIER(), 0
        );
        vm.stopPrank();

        vm.startPrank(other);
        vm.expectRevert();
        engine.postScoreRoot(contestId, keccak256("x"));
        vm.expectRevert();
        engine.settle(contestId);
        vm.expectRevert();
        engine.cancelContest(contestId);
        vm.expectRevert();
        engine.setContestParam(contestId, "k", 1);
        vm.expectRevert();
        engine.setListingFeeBps(10);
        vm.expectRevert();
        engine.pause();
        vm.stopPrank();
    }

    function testHybridContest() public {
        uint256 base = 300e6;
        uint256 fee = 100e6;
        usdc.mint(sponsor, base);
        vm.startPrank(sponsor);
        usdc.approve(address(escrow), base);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), base, 1 days, 5_000, 1, 0, engine.MAX_TIER(), fee
        );
        vm.stopPrank();

        _enterPaying(contestId, winner, fee);
        _enterPaying(contestId, other, fee);
        assertEq(escrow.poolBalance(address(engine), contestId), base + 2 * fee);

        vm.warp(block.timestamp + 1 days + 1);
        uint256 total = base + 2 * fee;
        uint256 platformFee = (total * 500) / 10_000;
        uint256 award = total - platformFee;
        bytes32 root = _hashPair(_leaf(winner, award), _leaf(other, 1));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = _leaf(other, 1);
        vm.startPrank(coordinator);
        engine.postScoreRoot(contestId, root);
        engine.settle(contestId);
        vm.stopPrank();

        vm.prank(winner);
        engine.claimPrize(contestId, award, proof);
        assertEq(usdc.balanceOf(winner), award);
        assertEq(usdc.balanceOf(admin), platformFee);
    }

    /// @dev The migration aid: advance the id counter so a fresh engine does not
    ///      reissue ids a prior engine already used. Strictly forward and admin only.
    function testSetNextContestId() public {
        assertEq(engine.nextContestId(), 1);

        // Admin advances the counter; the next listing takes the new id.
        vm.prank(admin);
        engine.setNextContestId(2000);
        assertEq(engine.nextContestId(), 2000);

        uint256 prizePool = 100e6;
        usdc.mint(sponsor, prizePool);
        vm.startPrank(sponsor);
        usdc.approve(address(escrow), prizePool);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), prizePool, 1 days, 5_000, 1, 0, engine.MAX_TIER(), 0
        );
        vm.stopPrank();
        assertEq(contestId, 2000);
        assertEq(engine.nextContestId(), 2001);

        // Strictly forward: cannot set to the current value or rewind.
        vm.prank(admin);
        vm.expectRevert(ContestEngine.InvalidNextId.selector);
        engine.setNextContestId(2001);

        // Bounded: a huge jump reverts, so a fat-finger cannot brick listing.
        vm.prank(admin);
        vm.expectRevert(ContestEngine.InvalidNextId.selector);
        engine.setNextContestId(2001 + 2_000_000);

        // Non-admin cannot advance it.
        vm.prank(other);
        vm.expectRevert();
        engine.setNextContestId(9999);
    }

    function testCancelStakedRefundsSponsor() public {
        uint256 prizePool = 500e6;
        usdc.mint(sponsor, prizePool);
        vm.startPrank(sponsor);
        usdc.approve(address(escrow), prizePool);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT, address(0), keccak256("VOLUME"), prizePool, 1 days, 5_000, 1, 0, engine.MAX_TIER(), 0
        );
        vm.stopPrank();

        vm.prank(coordinator);
        engine.cancelContest(contestId);
        assertEq(usdc.balanceOf(sponsor), prizePool); // full base refunded
        assertEq(escrow.poolBalance(address(engine), contestId), 0);
    }
}

/// @dev A trivial upgrade target: same storage, a bumped version, to prove an
///      upgrade preserves state and swaps logic.
contract ContestEngineV2Mock is ContestEngine {
    function version() external pure override returns (string memory) {
        return "9.9.9";
    }
}
