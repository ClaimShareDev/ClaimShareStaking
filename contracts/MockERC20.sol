// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

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

    function setFeeBps(uint256 feeBps_) external {
        feeBps = feeBps_;
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

/// @dev Test-only token that delivers the full amount and burns an extra `feeBps` from the sender.
///      The sender loses more than it sends. Not used in production.
contract FeeOnTopMock is ERC20 {
    uint256 public feeBps;

    constructor(uint256 feeBps_) ERC20("Fee-on-top CLAIM", "tCLAIM") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        _transferWithFeeOnTop(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transferWithFeeOnTop(from, to, value);
        return true;
    }

    function _transferWithFeeOnTop(address from, address to, uint256 value) internal {
        _transfer(from, to, value);
        uint256 fee = (value * feeBps) / 10_000;
        if (fee > 0) _burn(from, fee);
    }
}

interface IStakingEntryPoints {
    function stakePlatform(uint256 amount, string calldata uri) external returns (uint256);
    function stakeCase(uint256 caseId, uint256 amount, string calldata uri) external returns (uint256);
    function unstake(uint256 positionId) external;
}

/// @dev Test-only contract staker. When its position NFT is minted it tries to call back into staking:
///      mode 0 = no call, 1 = stakePlatform, 2 = stakeCase(1), 3 = unstake(1). Not used in production.
contract ReentrantStaker is IERC721Receiver {
    IStakingEntryPoints public immutable staking;
    uint8 public mode;

    constructor(IStakingEntryPoints staking_, IERC20 token_) {
        staking = staking_;
        token_.approve(address(staking_), type(uint256).max);
    }

    function setMode(uint8 mode_) external {
        mode = mode_;
    }

    function stake(uint256 amount) external {
        staking.stakePlatform(amount, "ipfs://reentrant-staker");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (mode == 1) staking.stakePlatform(1, "ipfs://reenter");
        else if (mode == 2) staking.stakeCase(1, 1, "ipfs://reenter");
        else if (mode == 3) staking.unstake(1);
        return IERC721Receiver.onERC721Received.selector;
    }
}
