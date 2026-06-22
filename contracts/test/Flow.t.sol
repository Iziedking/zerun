// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { TestUSDC } from "../src/TestUSDC.sol";
import { PrizeEscrow } from "../src/PrizeEscrow.sol";
import { AgentRegistry } from "../src/AgentRegistry.sol";
import { ContestEngine } from "../src/ContestEngine.sol";
import { ContestType } from "../src/types/ZerunTypes.sol";

/// @notice End-to-end happy path: list -> register -> score -> settle -> claim,
///         proving the merkle claim flow against a locally built 2-leaf tree.
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
        engine = new ContestEngine(admin, address(registry), address(escrow), 0, 500);

        escrow.grantRole(escrow.CONTROLLER_ROLE(), address(engine));
        registry.grantRole(registry.CONTEST_ENGINE_ROLE(), address(engine));
        engine.grantRole(engine.COORDINATOR_ROLE(), coordinator);
        vm.stopPrank();
    }

    /// @dev Match ContestEngine.claimPrize leaf encoding.
    function _leaf(address account, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    /// @dev Commutative pair hash, matching OZ MerkleProof.verify.
    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function testFullFlow() public {
        // ---- fund participants ----
        uint256 prizePool = 1_000e6; // 1000 tUSDC
        usdc.mint(sponsor, prizePool);

        // ---- sponsor lists & funds a contest ----
        vm.startPrank(sponsor);
        usdc.approve(address(escrow), prizePool);
        uint256 contestId = engine.listContest(
            ContestType.SCOUT,
            address(0),
            keccak256("VOLUME"),
            prizePool,
            1 days,
            5_000, // winnerCutBps
            1, // topN
            0, // minTier
            engine.MAX_TIER()
        );
        vm.stopPrank();

        assertEq(escrow.poolBalance(address(engine), contestId), prizePool);

        // ---- winner creates an agent and registers ----
        vm.prank(winner);
        uint256 agentId = registry.createAgent("ipfs://agent-1");
        assertEq(registry.ownerOfAgent(agentId), winner);

        vm.prank(winner);
        engine.registerEntry(contestId, agentId, 0);

        // ---- end the window ----
        vm.warp(block.timestamp + 1 days + 1);

        // ---- build a 2-leaf merkle tree: winner gets the full pool ----
        uint256 award = prizePool - (prizePool * 500) / 10_000; // pool minus 5% platform fee
        bytes32 leafWinner = _leaf(winner, award);
        bytes32 leafOther = _leaf(other, 1); // filler leaf
        bytes32 root = _hashPair(leafWinner, leafOther);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafOther;

        // ---- coordinator posts root and settles ----
        vm.startPrank(coordinator);
        engine.postScoreRoot(contestId, root);
        engine.settle(contestId);
        vm.stopPrank();

        // ---- winner claims ----
        uint256 balBefore = usdc.balanceOf(winner);
        vm.prank(winner);
        engine.claimPrize(contestId, award, proof);
        assertEq(usdc.balanceOf(winner) - balBefore, award);

        // ---- treasury (admin) received the 5% platform fee ----
        assertEq(usdc.balanceOf(admin), (prizePool * 500) / 10_000);
    }
}
