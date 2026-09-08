// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface IClaimShareStakingView {
    function votingPowerOfPosition(uint256 positionId) external view returns (uint256);
}

/// @dev Shared soulbound position NFT; `staking` wired once after ClaimShareStaking deploy.
abstract contract ClaimSharePositionNFT is ERC721, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes4 private constant _INTERFACE_ID_ERC4906 = bytes4(0x49064906);

    IClaimShareStakingView public staking;

    event MetadataUpdate(uint256 indexed _tokenId);
    event StakingWired(address indexed staking);

    constructor(address admin, string memory name_, string memory symbol_) ERC721(name_, symbol_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function wireStaking(IClaimShareStakingView staking_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(staking) != address(0)) revert StakingAlreadyWired();
        if (address(staking_) == address(0)) revert ZeroAddress();
        staking = staking_;
        emit StakingWired(address(staking_));
    }

    function mint(address to, uint256 tokenId, string calldata uri) external onlyRole(MINTER_ROLE) {
        if (_ownerOf(tokenId) != address(0)) revert TokenExists();
        _tokenURIs[tokenId] = uri;
        _safeMint(to, tokenId);
        emit MetadataUpdate(tokenId);
    }

    function setTokenURI(uint256 tokenId, string calldata uri) external onlyRole(MINTER_ROLE) {
        _requireOwned(tokenId);
        _tokenURIs[tokenId] = uri;
        emit MetadataUpdate(tokenId);
    }

    function votingPower(uint256 tokenId) external view returns (uint256) {
        _requireOwned(tokenId);
        if (address(staking) == address(0)) return 0;
        return staking.votingPowerOfPosition(tokenId);
    }

    mapping(uint256 => string) private _tokenURIs;

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURIs[tokenId];
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return interfaceId == _INTERFACE_ID_ERC4906 || super.supportsInterface(interfaceId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert TransfersDisabled();
        return super._update(to, tokenId, auth);
    }

    error TokenExists();
    error TransfersDisabled();
    error StakingAlreadyWired();
    error ZeroAddress();
}

contract PlatformPositionNFT is ClaimSharePositionNFT {
    constructor(address admin) ClaimSharePositionNFT(admin, "ClaimShare Platform Pass", "CSPP") {}
}

contract CasePositionNFT is ClaimSharePositionNFT {
    constructor(address admin) ClaimSharePositionNFT(admin, "ClaimShare Case Pass", "CSCP") {}
}
