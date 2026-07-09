// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { MemoryEscrow } from "../src/MemoryEscrow.sol";

/// Deploy the agent memory market against the EXISTING AgentRegistry. Nothing else is
/// redeployed: MemoryEscrow reads agent ownership live, so it attaches to the arena as it
/// already stands.
///
///   ADDR_AGENT_REGISTRY=0x... MEMORY_TREASURY=0x... \
///   forge script script/DeployMemoryEscrow.s.sol \
///     --rpc-url https://evmrpc-testnet.0g.ai \
///     --broadcast --legacy --with-gas-price 3gwei
///
/// The last two flags are not optional. 0G keeps a base fee near zero but enforces a
/// minimum gas price around 2 gwei, so Foundry's EIP-1559 estimate produces a tip the node
/// rejects outright: "gas tip cap 1, minimum needed 2000000000". `--legacy` drops the tip
/// and `--with-gas-price` matches the backend's flat GAS_PRICE.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  the deploying key (becomes DEFAULT_ADMIN_ROLE)
///   ADDR_AGENT_REGISTRY   the live AgentRegistry
///   MEMORY_TREASURY       where memory revenue lands. IMMUTABLE once deployed, so it is
///                         the address operators are trusting when they fund an agent.
///                         Defaults to the deployer, which is fine for a testnet run.
///   COORDINATOR_ADDRESS   granted SPENDER_ROLE. Its only power is charge(), bounded by
///                         each owner's allowance, paid only to MEMORY_TREASURY.
contract DeployMemoryEscrow is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address registry = vm.envAddress("ADDR_AGENT_REGISTRY");
        address treasury = vm.envOr("MEMORY_TREASURY", deployer);
        address coordinator = vm.envOr("COORDINATOR_ADDRESS", deployer);

        vm.startBroadcast(pk);
        MemoryEscrow escrow = new MemoryEscrow(registry, treasury, deployer, coordinator);
        vm.stopBroadcast();

        console2.log("MemoryEscrow:  ", address(escrow));
        console2.log("AgentRegistry: ", registry);
        console2.log("Treasury:      ", treasury, "(immutable)");
        console2.log("Coordinator:   ", coordinator, "(SPENDER_ROLE)");
        console2.log("");
        console2.log("Set ADDR_MEMORY_ESCROW in the backend .env to the address above.");
    }
}
