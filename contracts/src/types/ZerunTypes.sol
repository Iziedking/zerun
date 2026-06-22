// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev File-scope enums shared by every Zerun contract. Defined here so the
/// engine and registry can import the same symbol without creating an import
/// cycle.
enum ContestType {
    SCOUT,
    ANALYST,
    SOLVER
}

enum ContestStatus {
    PENDING,
    OPEN,
    SCORING,
    SETTLED,
    CANCELLED
}
