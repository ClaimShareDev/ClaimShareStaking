// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Shared pause controls and admin ERC20 recovery for ClaimShare contracts.
abstract contract ClaimSharePausable is AccessControl, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    event EmergencyWithdraw(address indexed admin, address indexed token, uint256 amount);

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @dev Internal helper. Subclasses expose an external `emergencyWithdraw` that
    ///      (a) enforces role, and (b) blocks withdrawal of protocol-held tokens
    ///      (e.g. stakeToken) before delegating here.
    function _emergencyWithdraw(IERC20 token) internal {
        if (address(token) == address(0)) revert EmergencyWithdrawZeroToken();
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert EmergencyWithdrawZeroBalance();
        token.safeTransfer(msg.sender, balance);
        emit EmergencyWithdraw(msg.sender, address(token), balance);
    }

    function _grantPauserRole(address account) internal {
        _grantRole(PAUSER_ROLE, account);
    }

    error EmergencyWithdrawZeroToken();
    error EmergencyWithdrawZeroBalance();
}
