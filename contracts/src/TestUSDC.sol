// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  TestUSDC
/// @notice Testnet-only faucet token used as the settlement currency across the
///         Zerun contracts. It is an ERC-20 with 6 decimals (matching USDC) and
///         a public, unrestricted `mint` so anyone can self-fund on the testnet.
/// @dev    THIS TOKEN HAS NO REAL VALUE. It exists solely for testing and
///         demonstration on the 0G Galileo testnet. Do not deploy it to, or
///         treat it as money on, any production network.
contract TestUSDC is ERC20 {
    constructor() ERC20("Zerun Test USDC", "tUSDC") { }

    /// @notice USDC-style 6-decimal precision.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint `amount` tokens to `to`. Permissionless faucet: callable by
    ///         anyone so testnet users can fund themselves. Testnet only.
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
