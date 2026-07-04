// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { ContestEngine } from "../src/ContestEngine.sol";

/// @notice Upgrade the ContestEngine implementation in place, with no state change.
///         Use this for a logic-only upgrade (e.g. the 2.0.2 hardening); the contest-id
///         counter and all storage are left untouched.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  the admin key (holds DEFAULT_ADMIN_ROLE on the engine)
///   ENGINE_PROXY          the deployed ContestEngine proxy address
///
/// Run (0G Galileo needs legacy pricing at 3 gwei):
///   ENGINE_PROXY=0x... forge script script/UpgradeEngineImpl.s.sol:UpgradeEngineImpl \
///     --rpc-url https://evmrpc-testnet.0g.ai --broadcast --slow --legacy --with-gas-price 3000000000
contract UpgradeEngineImpl is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address proxy = vm.envAddress("ENGINE_PROXY");

        vm.startBroadcast(pk);
        ContestEngine newImpl = new ContestEngine();
        ContestEngine(proxy).upgradeToAndCall(address(newImpl), "");
        vm.stopBroadcast();

        console.log("Upgraded ContestEngine proxy:", proxy);
        console.log("New implementation:", address(newImpl));
        console.log("version():", ContestEngine(proxy).version());
    }
}
