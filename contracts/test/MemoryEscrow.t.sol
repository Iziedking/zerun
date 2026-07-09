// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";

import { TestUSDC } from "../src/TestUSDC.sol";
import { AgentRegistry } from "../src/AgentRegistry.sol";
import { MemoryEscrow } from "../src/MemoryEscrow.sol";

/// The point of MemoryEscrow is a security claim, so these tests are mostly about what
/// the coordinator CANNOT do. The happy path is the easy part.
contract MemoryEscrowTest is Test {
    TestUSDC internal usdc;
    AgentRegistry internal registry;
    MemoryEscrow internal escrow;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal coordinator = makeAddr("coordinator");
    address internal player = makeAddr("player");
    address internal stranger = makeAddr("stranger");

    uint256 internal agentId;

    function setUp() public {
        usdc = new TestUSDC();
        registry = new AgentRegistry(admin, address(usdc), treasury);
        escrow = new MemoryEscrow(address(registry), treasury, admin, coordinator);

        vm.prank(player);
        agentId = registry.createAgent("ipfs://meta");

        vm.deal(player, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    function _fund(uint256 amount) internal {
        vm.prank(player);
        escrow.depositAndAllow{ value: amount }(agentId);
    }

    // ---- Funding and spending ------------------------------------------------

    function testDepositAndAllowRaisesBoth() public {
        _fund(1 ether);
        (uint256 balance, uint256 allowance, uint256 spent) = escrow.accountOf(agentId);
        assertEq(balance, 1 ether);
        assertEq(allowance, 1 ether);
        assertEq(spent, 0);
        assertEq(escrow.spendable(agentId), 1 ether);
    }

    function testCoordinatorChargesTreasuryOnly() public {
        _fund(1 ether);
        uint256 before = treasury.balance;

        vm.prank(coordinator);
        escrow.charge(agentId, 0.25 ether);

        assertEq(treasury.balance - before, 0.25 ether, "treasury is the only sink");
        (uint256 balance, uint256 allowance, uint256 spent) = escrow.accountOf(agentId);
        assertEq(balance, 0.75 ether);
        assertEq(allowance, 0.75 ether, "allowance decrements with the spend");
        assertEq(spent, 0.25 ether);
    }

    /// A bare deposit must not re-arm an agent whose owner revoked it.
    function testBareDepositDoesNotRaiseAllowance() public {
        _fund(1 ether);
        vm.prank(player);
        escrow.setAllowance(agentId, 0);

        vm.prank(stranger);
        escrow.deposit{ value: 5 ether }(agentId);

        assertEq(escrow.spendable(agentId), 0, "still revoked");
        vm.prank(coordinator);
        vm.expectRevert(abi.encodeWithSelector(MemoryEscrow.InsufficientAllowance.selector, agentId, 1, 0));
        escrow.charge(agentId, 1);
    }

    // ---- What the coordinator cannot do --------------------------------------

    function testCoordinatorCannotExceedAllowance() public {
        vm.prank(player);
        escrow.deposit{ value: 10 ether }(agentId); // balance, but no allowance
        vm.prank(player);
        escrow.setAllowance(agentId, 1 ether);

        vm.prank(coordinator);
        vm.expectRevert(
            abi.encodeWithSelector(MemoryEscrow.InsufficientAllowance.selector, agentId, 1 ether + 1, 1 ether)
        );
        escrow.charge(agentId, 1 ether + 1);
    }

    function testCoordinatorCannotChargeBeyondBalance() public {
        _fund(1 ether);
        vm.prank(player);
        escrow.setAllowance(agentId, 100 ether); // allowance above the funds behind it

        vm.prank(coordinator);
        vm.expectRevert(abi.encodeWithSelector(MemoryEscrow.InsufficientBalance.selector, agentId, 2 ether, 1 ether));
        escrow.charge(agentId, 2 ether);
    }

    function testNonCoordinatorCannotCharge() public {
        _fund(1 ether);
        // Read the role BEFORE pranking: an external call here would consume the prank.
        bytes32 role = escrow.SPENDER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        escrow.charge(agentId, 1);
    }

    /// The admin holds no spending power and no rescue hatch. It can only manage roles.
    function testAdminCannotMoveFunds() public {
        _fund(1 ether);
        bytes32 role = escrow.SPENDER_ROLE();
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, role));
        escrow.charge(agentId, 1);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(MemoryEscrow.NotAgentOwner.selector, agentId, admin));
        escrow.withdraw(agentId, 1);
    }

    /// Revoking is instant and needs nobody's cooperation.
    function testOwnerRevokesInstantly() public {
        _fund(1 ether);
        vm.prank(player);
        escrow.setAllowance(agentId, 0);

        vm.prank(coordinator);
        vm.expectRevert(abi.encodeWithSelector(MemoryEscrow.InsufficientAllowance.selector, agentId, 1, 0));
        escrow.charge(agentId, 1);

        (uint256 balance, , ) = escrow.accountOf(agentId);
        assertEq(balance, 1 ether, "revoking never touches the balance");
    }

    // ---- What the owner can always do ----------------------------------------

    function testOwnerWithdrawsAnyTimeWithoutPermission() public {
        _fund(1 ether);
        uint256 before = player.balance;

        vm.prank(player);
        escrow.withdraw(agentId, 1 ether);

        assertEq(player.balance - before, 1 ether);
        assertEq(escrow.spendable(agentId), 0);
    }

    /// A withdrawal must never leave an allowance larger than the funds behind it,
    /// otherwise a later top-up would be spendable without the owner re-authorizing.
    function testWithdrawTrimsAllowanceToBalance() public {
        _fund(2 ether);
        vm.prank(player);
        escrow.withdraw(agentId, 1.5 ether);

        (uint256 balance, uint256 allowance, ) = escrow.accountOf(agentId);
        assertEq(balance, 0.5 ether);
        assertEq(allowance, 0.5 ether, "allowance trimmed down with the balance");

        vm.prank(stranger);
        escrow.deposit{ value: 5 ether }(agentId);
        assertEq(escrow.spendable(agentId), 0.5 ether, "top-up is not spendable without re-authorizing");
    }

    function testStrangerCannotWithdrawOrAllow() public {
        _fund(1 ether);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MemoryEscrow.NotAgentOwner.selector, agentId, stranger));
        escrow.withdraw(agentId, 1);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(MemoryEscrow.NotAgentOwner.selector, agentId, stranger));
        escrow.setAllowance(agentId, 1 ether);
    }

    /// Authority follows the NFT: sell the agent, and its balance answers to the buyer.
    function testAuthorityFollowsAgentOwnership() public {
        _fund(1 ether);

        vm.prank(player);
        registry.transferFrom(player, stranger, agentId);

        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(MemoryEscrow.NotAgentOwner.selector, agentId, player));
        escrow.withdraw(agentId, 1);

        uint256 before = stranger.balance;
        vm.prank(stranger);
        escrow.withdraw(agentId, 1 ether);
        assertEq(stranger.balance - before, 1 ether);
    }

    // ---- Accounting ----------------------------------------------------------

    function testChargesAreIndependentPerAgent() public {
        _fund(1 ether);
        vm.prank(stranger);
        uint256 other = registry.createAgent("ipfs://other");
        vm.prank(stranger);
        escrow.depositAndAllow{ value: 3 ether }(other);

        vm.prank(coordinator);
        escrow.charge(agentId, 0.4 ether);

        (uint256 b1, , uint256 s1) = escrow.accountOf(agentId);
        (uint256 b2, , uint256 s2) = escrow.accountOf(other);
        assertEq(b1, 0.6 ether);
        assertEq(s1, 0.4 ether);
        assertEq(b2, 3 ether, "another agent's balance is untouched");
        assertEq(s2, 0);
    }

    function testFuzzChargeNeverExceedsSpendable(uint96 fund, uint96 amount) public {
        vm.assume(fund > 0 && fund < 50 ether);
        _fund(fund);

        vm.prank(coordinator);
        if (amount == 0) {
            vm.expectRevert(MemoryEscrow.ZeroAmount.selector);
            escrow.charge(agentId, amount);
            return;
        }
        if (amount > fund) {
            vm.expectRevert(abi.encodeWithSelector(MemoryEscrow.InsufficientBalance.selector, agentId, amount, fund));
            escrow.charge(agentId, amount);
            return;
        }
        escrow.charge(agentId, amount);
        assertEq(treasury.balance, amount);
    }
}
