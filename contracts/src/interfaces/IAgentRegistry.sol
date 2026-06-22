// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ContestType } from "../types/ZerunTypes.sol";

/// @notice Slice of AgentRegistry consumed by ContestEngine.
/// @dev    Kept intentionally minimal so the settlement contract does not depend
///         on AgentRegistry's full storage layout. `applyReputationChange` is
///         gated by CONTEST_ENGINE_ROLE on the implementation.
interface IAgentRegistry {
    function ownerOfAgent(uint256 agentId) external view returns (address);

    function getTier(uint256 agentId, ContestType cType) external view returns (uint16);

    function applyReputationChange(uint256 agentId, int128 delta) external;
}
