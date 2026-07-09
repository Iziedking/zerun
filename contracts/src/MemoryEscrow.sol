// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title  MemoryEscrow
/// @notice Non-custodial 0G balance an agent spends on memory. An operator funds their
///         agent here and grants the coordinator a bounded, revocable allowance to spend
///         it. The agent then plays with memory autonomously, without its owner signing
///         anything per call.
/// @dev    The security claim, stated precisely: there are exactly two outbound paths.
///
///         1. `withdraw` — only the agent's NFT owner, any amount, any time, needing no
///            permission from the platform. This is what makes the escrow non-custodial.
///         2. `charge` — only the coordinator, only up to the allowance the owner set,
///            and only ever to `treasury`, which is IMMUTABLE and therefore known to the
///            operator before they deposit a single wei.
///
///         So the coordinator's key cannot redirect funds, cannot drain a balance, and
///         cannot exceed a cap the operator controls. `setAllowance(agentId, 0)` revokes
///         instantly without moving the balance. There is deliberately NO admin rescue
///         hatch: an escape hatch would hand back the custody this contract exists to
///         remove.
///
///         Authority follows the ERC-721. Transfer the agent and its balance follows the
///         new owner, because ownership is read live from `agents.ownerOf`.
///
///         Allowance is a cumulative spend budget, not a rate limit. It decrements as it
///         is spent, so an operator who grants 1 0G can lose at most 1 0G to memory,
///         whatever the platform does. `depositAndAllow` raises both together, which is
///         what the funding UI calls; a bare `deposit` credits the balance and leaves the
///         allowance alone, so topping up never silently re-arms a revoked agent.
contract MemoryEscrow is AccessControl, ReentrancyGuard {
    // ============ Roles ============

    /// @notice The coordinator. Its ONLY power is `charge`, bounded by allowance, to `treasury`.
    bytes32 public constant SPENDER_ROLE = keccak256("SPENDER_ROLE");

    // ============ Immutables ============

    /// @notice Agent ownership, read live. Authority to withdraw and to set an allowance.
    IERC721 public immutable agents;

    /// @notice The one and only destination `charge` can pay. Immutable on purpose.
    address public immutable treasury;

    // ============ Types ============

    struct Account {
        uint256 balance; // 0G held for this agent, withdrawable by its owner at any time
        uint256 allowance; // remaining budget the coordinator may spend, set by the owner
        uint256 spent; // lifetime 0G this agent has paid for memory
    }

    /// @dev agentId => account.
    mapping(uint256 => Account) private _accounts;

    // ============ Events ============

    event Deposited(uint256 indexed agentId, address indexed from, uint256 amount, uint256 balance);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount, uint256 balance);
    event AllowanceSet(uint256 indexed agentId, address indexed owner, uint256 allowance);
    event Charged(uint256 indexed agentId, uint256 amount, uint256 balance, uint256 allowanceLeft);

    // ============ Errors ============

    error ZeroAddress();
    error ZeroAmount();
    error NotAgentOwner(uint256 agentId, address caller);
    error InsufficientBalance(uint256 agentId, uint256 requested, uint256 available);
    error InsufficientAllowance(uint256 agentId, uint256 requested, uint256 available);
    error TransferFailed();

    // ============ Constructor ============

    constructor(address agents_, address treasury_, address admin, address coordinator) {
        if (agents_ == address(0) || treasury_ == address(0) || admin == address(0)) revert ZeroAddress();
        agents = IERC721(agents_);
        treasury = treasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (coordinator != address(0)) _grantRole(SPENDER_ROLE, coordinator);
    }

    // ============ Modifiers ============

    modifier onlyAgentOwner(uint256 agentId) {
        if (agents.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        _;
    }

    // ============ Funding (anyone) ============

    /// @notice Fund an agent's memory balance. Anyone may fund any agent; only its owner
    ///         can ever withdraw or authorize spending, so a gift cannot become a trap.
    /// @dev    Leaves the allowance untouched, so topping up a revoked agent does not
    ///         silently re-arm it.
    function deposit(uint256 agentId) external payable {
        if (msg.value == 0) revert ZeroAmount();
        Account storage a = _accounts[agentId];
        a.balance += msg.value;
        emit Deposited(agentId, msg.sender, msg.value, a.balance);
    }

    /// @notice Fund an agent AND raise its spend allowance by the same amount. The normal
    ///         path from the funding UI: "give my agent 1 0G to spend on memory".
    /// @dev    Only the owner, because it grants spending authority.
    function depositAndAllow(uint256 agentId) external payable onlyAgentOwner(agentId) {
        if (msg.value == 0) revert ZeroAmount();
        Account storage a = _accounts[agentId];
        a.balance += msg.value;
        a.allowance += msg.value;
        emit Deposited(agentId, msg.sender, msg.value, a.balance);
        emit AllowanceSet(agentId, msg.sender, a.allowance);
    }

    // ============ Owner controls ============

    /// @notice Set the remaining budget the coordinator may spend on this agent's memory.
    ///         Pass 0 to revoke instantly. Never moves the balance.
    function setAllowance(uint256 agentId, uint256 allowance) external onlyAgentOwner(agentId) {
        _accounts[agentId].allowance = allowance;
        emit AllowanceSet(agentId, msg.sender, allowance);
    }

    /// @notice Take your 0G back. No platform permission, no timelock, no conditions.
    /// @dev    Also trims the allowance down to the remaining balance, so a withdrawal can
    ///         never leave a budget larger than the funds behind it.
    function withdraw(uint256 agentId, uint256 amount) external onlyAgentOwner(agentId) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[agentId];
        if (amount > a.balance) revert InsufficientBalance(agentId, amount, a.balance);

        a.balance -= amount;
        if (a.allowance > a.balance) a.allowance = a.balance;

        emit Withdrawn(agentId, msg.sender, amount, a.balance);

        (bool ok, ) = msg.sender.call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }

    // ============ Coordinator ============

    /// @notice Charge an agent for the memory it consumed, paying the immutable treasury.
    /// @dev    Called once per contest with the batched total, so play itself costs no
    ///         transactions. Bounded by BOTH the balance and the owner's allowance.
    function charge(uint256 agentId, uint256 amount) external onlyRole(SPENDER_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[agentId];
        if (amount > a.balance) revert InsufficientBalance(agentId, amount, a.balance);
        if (amount > a.allowance) revert InsufficientAllowance(agentId, amount, a.allowance);

        a.balance -= amount;
        a.allowance -= amount;
        a.spent += amount;

        emit Charged(agentId, amount, a.balance, a.allowance);

        (bool ok, ) = treasury.call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }

    // ============ Views ============

    function accountOf(uint256 agentId) external view returns (uint256 balance, uint256 allowance, uint256 spent) {
        Account storage a = _accounts[agentId];
        return (a.balance, a.allowance, a.spent);
    }

    /// @notice What the coordinator could actually spend right now: the lesser of the
    ///         agent's balance and the budget its owner authorized.
    function spendable(uint256 agentId) external view returns (uint256) {
        Account storage a = _accounts[agentId];
        return a.balance < a.allowance ? a.balance : a.allowance;
    }
}
