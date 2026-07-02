// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { PrizeEscrow } from "../src/PrizeEscrow.sol";
import { AgentRegistry } from "../src/AgentRegistry.sol";
import { ContestEngine } from "../src/ContestEngine.sol";

/// @title  DeployEngineV2
/// @notice Rolls out a new ContestEngine (UUPS proxy) against the EXISTING,
///         immutable PrizeEscrow and AgentRegistry. No funds move: the escrow
///         namespaces pools by controller, so the new engine simply becomes an
///         additional controller. Old contests stay claimable under the old
///         engine until they drain.
/// @dev    Env: DEPLOYER_PRIVATE_KEY (must be admin of the escrow and registry),
///         PRIZE_ESCROW, AGENT_REGISTRY, optional COORDINATOR_ADDRESS. After this
///         runs, point deployment config / the backend at the new engine address.
contract DeployEngineV2 is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address coordinator = vm.envOr("COORDINATOR_ADDRESS", deployer);
        PrizeEscrow escrow = PrizeEscrow(vm.envAddress("PRIZE_ESCROW"));
        AgentRegistry registry = AgentRegistry(vm.envAddress("AGENT_REGISTRY"));

        vm.startBroadcast(pk);

        // Deploy the implementation and its proxy, initializing in one tx.
        ContestEngine impl = new ContestEngine();
        bytes memory initData = abi.encodeCall(
            ContestEngine.initialize, (deployer, address(registry), address(escrow), 0, 500)
        );
        ContestEngine engine = ContestEngine(address(new ERC1967Proxy(address(impl), initData)));

        // Authorize the new engine on the shared escrow and registry (a role
        // grant, not a redeploy), and grant the backend coordinator its role.
        escrow.grantRole(escrow.CONTROLLER_ROLE(), address(engine));
        registry.grantRole(registry.CONTEST_ENGINE_ROLE(), address(engine));
        engine.grantRole(engine.COORDINATOR_ROLE(), coordinator);

        vm.stopBroadcast();

        console2.log("New ContestEngine (proxy):", address(engine));
        console2.log("Implementation:          ", address(impl));
        console2.log("PrizeEscrow (reused):    ", address(escrow));
        console2.log("AgentRegistry (reused):  ", address(registry));
        console2.log("Coordinator:             ", coordinator);
        console2.log("Update deployment config / backend to the new engine address above.");
    }
}
