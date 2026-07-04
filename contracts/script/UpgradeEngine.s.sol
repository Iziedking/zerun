// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Script, console } from "forge-std/Script.sol";
import { ContestEngine } from "../src/ContestEngine.sol";

/// @notice Upgrade the deployed ContestEngine and, in the same transaction, advance the
///         contest-id counter. A fresh engine restarts its counter at 1 and would reissue
///         ids that off-chain records (kept by contest id) already use; this moves the
///         counter past the prior engine's last id so new contests get fresh ids.
///
/// Env:
///   DEPLOYER_PRIVATE_KEY  the admin key (must hold DEFAULT_ADMIN_ROLE on the engine)
///   ENGINE_PROXY          the deployed ContestEngine address
///   NEXT_CONTEST_ID       the new counter value (optional, default 2000). Must be
///                         strictly greater than the current nextContestId.
///
/// Run (0G Galileo needs legacy pricing at 3 gwei):
///   forge script script/UpgradeEngine.s.sol:UpgradeEngine \
///     --rpc-url https://evmrpc-testnet.0g.ai --broadcast --slow --legacy --with-gas-price 3000000000
contract UpgradeEngine is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address proxy = vm.envAddress("ENGINE_PROXY");
        uint256 nextId = vm.envOr("NEXT_CONTEST_ID", uint256(2000));

        vm.startBroadcast(pk);
        // Deploy the new implementation (carries setNextContestId and version 2.0.1).
        ContestEngine newImpl = new ContestEngine();
        // Upgrade the proxy to it and bump the counter atomically. The delegatecall runs
        // as the admin (msg.sender is preserved), so the admin-gated setter passes.
        ContestEngine(proxy).upgradeToAndCall(
            address(newImpl),
            abi.encodeCall(ContestEngine.setNextContestId, (nextId))
        );
        vm.stopBroadcast();

        console.log("Upgraded ContestEngine proxy:", proxy);
        console.log("New implementation:", address(newImpl));
        console.log("version():", ContestEngine(proxy).version());
        console.log("nextContestId now:", ContestEngine(proxy).nextContestId());
    }
}
