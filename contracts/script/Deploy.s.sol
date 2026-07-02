// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { ERC1967Proxy } from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import { TestUSDC } from "../src/TestUSDC.sol";
import { PrizeEscrow } from "../src/PrizeEscrow.sol";
import { AgentRegistry } from "../src/AgentRegistry.sol";
import { ContestEngine } from "../src/ContestEngine.sol";

/// @title  Deploy
/// @notice Deploys the full Zerun contract stack to the 0G Galileo testnet
///         (chain 16602) and wires the cross-contract roles. Writes the
///         resulting addresses to `deployments/0g-galileo.json`.
/// @dev    Requires env var DEPLOYER_PRIVATE_KEY. COORDINATOR_ADDRESS is
///         optional and defaults to the deployer. For this MVP the treasury is
///         the deployer.
contract Deploy is Script {
    uint256 internal constant OG_GALILEO_CHAIN_ID = 16602;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address coordinator = vm.envOr("COORDINATOR_ADDRESS", deployer);

        vm.startBroadcast(pk);

        // 1. Testnet settlement token (public faucet, 6 decimals).
        TestUSDC usdc = new TestUSDC();

        // 2. USDC custodian for prize pools. Treasury = deployer for the MVP.
        PrizeEscrow escrow = new PrizeEscrow(deployer, address(usdc), deployer);

        // 3. Agent ownership / tier / reputation registry. Treasury = deployer.
        AgentRegistry registry = new AgentRegistry(deployer, address(usdc), deployer);

        // 4. Contest lifecycle engine, deployed as a UUPS proxy so its logic can
        //    evolve at a stable address. 0 listing fee, 5% platform fee.
        ContestEngine engineImpl = new ContestEngine();
        bytes memory initData = abi.encodeCall(
            ContestEngine.initialize, (deployer, address(registry), address(escrow), 0, 500)
        );
        ContestEngine engine = ContestEngine(address(new ERC1967Proxy(address(engineImpl), initData)));

        // Wire cross-contract roles.
        escrow.grantRole(escrow.CONTROLLER_ROLE(), address(engine));
        registry.grantRole(registry.CONTEST_ENGINE_ROLE(), address(engine));
        engine.grantRole(engine.COORDINATOR_ROLE(), coordinator);

        vm.stopBroadcast();

        console2.log("Deployer:      ", deployer);
        console2.log("Coordinator:   ", coordinator);
        console2.log("TestUSDC:      ", address(usdc));
        console2.log("PrizeEscrow:   ", address(escrow));
        console2.log("AgentRegistry: ", address(registry));
        console2.log("ContestEngine: ", address(engine));

        _writeDeployment(address(usdc), address(escrow), address(registry), address(engine), deployer, coordinator);
    }

    function _writeDeployment(
        address testUSDC,
        address prizeEscrow,
        address agentRegistry,
        address contestEngine,
        address deployer,
        address coordinator
    ) internal {
        string memory obj = "deployment";
        vm.serializeAddress(obj, "testUSDC", testUSDC);
        vm.serializeAddress(obj, "prizeEscrow", prizeEscrow);
        vm.serializeAddress(obj, "agentRegistry", agentRegistry);
        vm.serializeAddress(obj, "contestEngine", contestEngine);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "coordinator", coordinator);
        string memory json = vm.serializeUint(obj, "chainId", OG_GALILEO_CHAIN_ID);

        vm.writeJson(json, "./deployments/0g-galileo.json");
    }
}
