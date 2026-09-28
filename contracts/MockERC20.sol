// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Test-only token that burns `feeBps` of each transfer. Not used in production.
contract FeeOnTransferMock is ERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) ERC20("Fee CLAIM", "fCLAIM") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _transferWithFee(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transferWithFee(from, to, value);
        return true;
    }

    function _transferWithFee(address from, address to, uint256 value) internal {
        uint256 fee = (value * feeBps) / 10_000;
        _transfer(from, to, value - fee);
        if (fee > 0) _burn(from, fee);
    }
}
