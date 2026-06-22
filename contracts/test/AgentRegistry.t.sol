// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";

import { TestUSDC } from "../src/TestUSDC.sol";
import { AgentRegistry } from "../src/AgentRegistry.sol";
import { ContestType } from "../src/types/ZerunTypes.sol";

contract AgentRegistryTest is Test {
    TestUSDC internal usdc;
    AgentRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal player = makeAddr("player");

    function setUp() public {
        usdc = new TestUSDC();
        registry = new AgentRegistry(admin, address(usdc), treasury);
    }

    function testCreateAgentMintsERC721() public {
        vm.prank(player);
        uint256 agentId = registry.createAgent("ipfs://meta");

        assertEq(agentId, 1);
        assertEq(registry.ownerOf(agentId), player);
        assertEq(registry.ownerOfAgent(agentId), player);
        assertEq(registry.balanceOf(player), 1);
        assertEq(registry.tokenURI(agentId), "ipfs://meta");

        uint256[] memory owned = registry.agentsOf(player);
        assertEq(owned.length, 1);
        assertEq(owned[0], agentId);
    }

    function testUpgradeWithUSDCBumpsTier() public {
        vm.prank(player);
        uint256 agentId = registry.createAgent("ipfs://meta");

        // tier 0 -> 1 SCOUT costs 10 USDC.
        uint256 price = registry.upgradePrice(ContestType.SCOUT, 0);
        assertEq(price, 10_000_000);

        usdc.mint(player, price);
        vm.startPrank(player);
        usdc.approve(address(registry), price);
        registry.upgradeAgent(agentId, ContestType.SCOUT, 1);
        vm.stopPrank();

        assertEq(registry.getTier(agentId, ContestType.SCOUT), 1);
        assertEq(usdc.balanceOf(treasury), price);
    }
}
