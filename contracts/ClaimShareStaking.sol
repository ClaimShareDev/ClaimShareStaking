// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ClaimSharePausable} from "./ClaimSharePausable.sol";
import {PlatformPositionNFT, CasePositionNFT} from "./ClaimSharePositionNFT.sol";

/// @title ClaimShareStaking — staking, cases, on-chain governance, payout preferences.
/// @dev VP starts at weightStart (0.5× platform / 0.75× case) at stake and ramps linearly to weightEnd.
///      Lock only blocks unstake — not voting.
contract ClaimShareStaking is ReentrancyGuard, ClaimSharePausable {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    bytes32 public constant CASE_MANAGER_ROLE = keccak256("CASE_MANAGER_ROLE");
    bytes32 public constant GOVERNANCE_ADMIN_ROLE = keccak256("GOVERNANCE_ADMIN_ROLE");

    enum PositionKind {
        Platform,
        Case
    }

    /// @dev Claimant chooses on-chain vs off-chain portion before case is closed (settled).
    enum PayoutPreference {
        NotSet,
        FullOnChain,
        FullOffChain,
        Partial
    }

    struct WeightConfig {
        uint256 weightStartWad;
        uint256 weightEndWad;
        uint256 durationSeconds;
    }

    struct Position {
        uint256 amount;
        uint256 stakedAt;
        uint256 lockEnd;
        address owner;
        PositionKind kind;
        uint256 caseId;
        bool closed;
    }

    struct CaseInfo {
        bool registered;
        bool active;
        bool closed;
        uint256 closedAt;
        string metadataURI;
    }

    struct Poll {
        bool exists;
        bool finalized;
        uint256 deadline;
        uint8 optionCount;
        uint8 winningOption;
        string metadataURI;
    }

    uint8 public constant MIN_POLL_OPTIONS = 2;
    uint8 public constant MAX_POLL_OPTIONS = 16;

    IERC20 public immutable stakeToken;
    PlatformPositionNFT public immutable platformNFT;
    CasePositionNFT public immutable caseNFT;

    uint256 private _nextPositionId = 1;

    uint256 public lockDuration;
    WeightConfig public platformWeights;
    WeightConfig public caseWeights;

    mapping(uint256 positionId => Position) public positions;
    mapping(uint256 caseId => CaseInfo) public cases;
    mapping(uint256 caseId => mapping(address user => PayoutPreference)) public payoutPreference;
    mapping(uint256 caseId => mapping(address user => uint256 onChainPortionBps)) public payoutOnChainBps;

    mapping(uint256 pollId => Poll) public polls;
    mapping(uint256 pollId => mapping(uint8 optionIndex => uint256)) public pollOptionVotes;
    mapping(uint256 pollId => mapping(uint256 positionId => bool)) public hasVotedOnPoll;

    event StakedPlatform(address indexed user, uint256 indexed positionId, uint256 amount);
    event StakedCase(address indexed user, uint256 indexed caseId, uint256 indexed positionId, uint256 amount);
    event Unstaked(address indexed user, uint256 indexed positionId, uint256 amount);
    event CaseRegistered(uint256 indexed caseId, string metadataURI);
    event CaseDeactivated(uint256 indexed caseId);
    event CaseClosed(uint256 indexed caseId, uint256 closedAt);
    event PayoutPreferenceSet(
        uint256 indexed caseId, address indexed user, PayoutPreference preference, uint256 onChainPortionBps
    );
    event PollCreated(uint256 indexed pollId, uint256 deadline, uint8 optionCount, string metadataURI);
    event PollVoteCast(
        uint256 indexed pollId, address indexed voter, uint256 indexed positionId, uint8 optionIndex, uint256 weight
    );
    event PollFinalized(uint256 indexed pollId, uint8 winningOptionIndex);
    event PollDeadlineExtended(uint256 indexed pollId, uint256 newDeadline);
    event LockDurationUpdated(uint256 lockDuration);
    event PlatformWeightsUpdated(uint256 weightStartWad, uint256 weightEndWad, uint256 durationSeconds);
    event CaseWeightsUpdated(uint256 weightStartWad, uint256 weightEndWad, uint256 durationSeconds);

    constructor(
        IERC20 stakeToken_,
        PlatformPositionNFT platformNFT_,
        CasePositionNFT caseNFT_,
        address admin,
        uint256 lockDuration_,
        WeightConfig memory platformWeights_,
        WeightConfig memory caseWeights_
    ) {
        if (admin == address(0)) revert ZeroAddress();
        if (address(stakeToken_) == address(0)) revert ZeroAddress();
        if (address(platformNFT_) == address(0)) revert ZeroAddress();
        if (address(caseNFT_) == address(0)) revert ZeroAddress();
        _validateWeightConfig(platformWeights_.weightStartWad, platformWeights_.weightEndWad, platformWeights_.durationSeconds);
        _validateWeightConfig(caseWeights_.weightStartWad, caseWeights_.weightEndWad, caseWeights_.durationSeconds);

        stakeToken = stakeToken_;
        platformNFT = platformNFT_;
        caseNFT = caseNFT_;
        lockDuration = lockDuration_;
        platformWeights = platformWeights_;
        caseWeights = caseWeights_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CASE_MANAGER_ROLE, admin);
        _grantRole(GOVERNANCE_ADMIN_ROLE, admin);
        _grantPauserRole(admin);
    }

    // ─── Cases ───

    function registerCase(uint256 caseId, string calldata metadataURI) external onlyRole(CASE_MANAGER_ROLE) {
        if (cases[caseId].registered) revert CaseAlreadyRegistered();
        if (bytes(metadataURI).length == 0) revert EmptyURI();
        cases[caseId] = CaseInfo({
            registered: true,
            active: true,
            closed: false,
            closedAt: 0,
            metadataURI: metadataURI
        });
        emit CaseRegistered(caseId, metadataURI);
    }

    function deactivateCase(uint256 caseId) external onlyRole(CASE_MANAGER_ROLE) {
        CaseInfo storage c = cases[caseId];
        if (!c.registered) revert CaseNotRegistered();
        if (c.closed) revert CaseIsClosed();
        if (!c.active) revert CaseNotActive();
        c.active = false;
        emit CaseDeactivated(caseId);
    }

    /// @notice Mark case settled/closed on-chain (no new case stakes).
    function closeCase(uint256 caseId) external onlyRole(CASE_MANAGER_ROLE) {
        CaseInfo storage c = cases[caseId];
        if (!c.registered) revert CaseNotRegistered();
        if (c.closed) revert CaseAlreadyClosed();
        c.closed = true;
        c.active = false;
        c.closedAt = block.timestamp;
        emit CaseClosed(caseId, c.closedAt);
    }

    function isCaseClosed(uint256 caseId) external view returns (bool) {
        return cases[caseId].closed;
    }

    function isCaseActive(uint256 caseId) external view returns (bool) {
        CaseInfo storage c = cases[caseId];
        return c.registered && c.active && !c.closed;
    }

    /// @notice Before closeCase: user picks full/partial on-chain vs off-chain payout (advisory; used off-chain).
    function setPayoutPreference(uint256 caseId, PayoutPreference preference, uint256 onChainPortionBps)
        external
        whenNotPaused
    {
        CaseInfo storage c = cases[caseId];
        if (!c.registered) revert CaseNotRegistered();
        if (c.closed) revert CaseIsClosed();
        if (preference == PayoutPreference.NotSet) revert InvalidPreference();
        if (preference == PayoutPreference.Partial) {
            if (onChainPortionBps == 0 || onChainPortionBps >= BPS) revert InvalidBps();
        }

        payoutPreference[caseId][msg.sender] = preference;
        payoutOnChainBps[caseId][msg.sender] = onChainPortionBps;
        emit PayoutPreferenceSet(caseId, msg.sender, preference, onChainPortionBps);
    }

    // ─── On-chain polls (multi-option) ───

    /// @param optionCount Number of choices (2–16). Must match options array length in metadataURI JSON.
    /// @param metadataURI IPFS (or HTTPS) URI to poll JSON: title, description, option labels.
    /// @dev Polls are independent of cases. Platform: voteOnPoll. Case stake: voteOnPollCase.
    function createPoll(
        uint256 pollId,
        uint256 votingDurationSeconds,
        uint8 optionCount,
        string calldata metadataURI
    ) external onlyRole(GOVERNANCE_ADMIN_ROLE) {
        if (polls[pollId].exists) revert PollAlreadyExists();
        if (votingDurationSeconds == 0) revert InvalidDuration();
        if (optionCount < MIN_POLL_OPTIONS || optionCount > MAX_POLL_OPTIONS) revert InvalidOptionCount();
        if (bytes(metadataURI).length == 0) revert EmptyURI();

        polls[pollId] = Poll({
            exists: true,
            finalized: false,
            deadline: block.timestamp + votingDurationSeconds,
            optionCount: optionCount,
            winningOption: 0,
            metadataURI: metadataURI
        });
        emit PollCreated(pollId, polls[pollId].deadline, optionCount, metadataURI);
    }

    /// @notice Platform position votes on a poll (one vote per position).
    function voteOnPoll(uint256 pollId, uint256 positionId, uint8 optionIndex, uint256 weight) external whenNotPaused {
        Position storage p = positions[positionId];
        _requirePlatformPositionForPoll(p);
        _castPollVote(pollId, positionId, optionIndex, weight, p);
    }

    /// @notice Case position votes on a poll (one vote per position). Case must be registered.
    function voteOnPollCase(uint256 pollId, uint256 positionId, uint8 optionIndex, uint256 weight)
        external
        whenNotPaused
    {
        Position storage p = positions[positionId];
        _requireCasePositionForPoll(p);
        _castPollVote(pollId, positionId, optionIndex, weight, p);
    }

    /// @notice Extend a poll's deadline. New deadline must be strictly greater than the current one.
    function extendPollDeadline(uint256 pollId, uint256 newDeadline)
        external
        onlyRole(GOVERNANCE_ADMIN_ROLE)
    {
        Poll storage poll = polls[pollId];
        if (!poll.exists) revert PollNotFound();
        if (poll.finalized) revert PollIsFinalized();
        if (newDeadline <= poll.deadline) revert DeadlineNotExtended();
        poll.deadline = newDeadline;
        emit PollDeadlineExtended(pollId, newDeadline);
    }

    function _castPollVote(
        uint256 pollId,
        uint256 positionId,
        uint8 optionIndex,
        uint256 weight,
        Position storage p
    ) internal {
        Poll storage poll = polls[pollId];
        if (!poll.exists) revert PollNotFound();
        if (poll.finalized) revert PollIsFinalized();
        if (block.timestamp > poll.deadline) revert PollExpired();
        if (optionIndex >= poll.optionCount) revert InvalidOptionIndex();
        if (p.owner != msg.sender) revert NotOwner();
        if (p.closed || p.amount == 0) revert PositionClosed();
        if (hasVotedOnPoll[pollId][positionId]) revert AlreadyVoted();
        if (weight == 0) revert ZeroAmount();

        uint256 power = votingPowerOfPosition(positionId);
        if (weight > power) revert ExceedsVotingPower();

        hasVotedOnPoll[pollId][positionId] = true;
        pollOptionVotes[pollId][optionIndex] += weight;

        emit PollVoteCast(pollId, msg.sender, positionId, optionIndex, weight);
    }

    /// @dev Sets winningOption to the option with the highest vote weight (lowest index on tie).
    ///      Requires the voting deadline to have passed, preventing early forced finalization.
    function finalizePoll(uint256 pollId) external onlyRole(GOVERNANCE_ADMIN_ROLE) {
        Poll storage poll = polls[pollId];
        if (!poll.exists) revert PollNotFound();
        if (poll.finalized) revert PollIsFinalized();
        if (block.timestamp <= poll.deadline) revert PollNotExpired();
        poll.finalized = true;

        uint8 winner = 0;
        uint256 top = pollOptionVotes[pollId][0];
        for (uint8 i = 1; i < poll.optionCount; i++) {
            uint256 v = pollOptionVotes[pollId][i];
            if (v > top) {
                top = v;
                winner = i;
            }
        }
        poll.winningOption = winner;
        emit PollFinalized(pollId, winner);
    }

    function pollState(uint256 pollId)
        external
        view
        returns (
            bool exists,
            bool finalized,
            uint256 deadline,
            uint8 optionCount,
            uint8 winningOption,
            string memory metadataURI
        )
    {
        Poll storage poll = polls[pollId];
        return (
            poll.exists,
            poll.finalized,
            poll.deadline,
            poll.optionCount,
            poll.winningOption,
            poll.metadataURI
        );
    }

    function pollMetadataURI(uint256 pollId) external view returns (string memory) {
        Poll storage poll = polls[pollId];
        if (!poll.exists) revert PollNotFound();
        return poll.metadataURI;
    }

    function pollOptionVoteCount(uint256 pollId, uint8 optionIndex) external view returns (uint256) {
        return pollOptionVotes[pollId][optionIndex];
    }

    // ─── Emergency recovery ───

    /// @notice Recover accidentally sent tokens. Cannot withdraw the stakeToken (user funds).
    function emergencyWithdraw(IERC20 token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(token) == address(stakeToken)) revert CannotWithdrawStakeToken();
        _emergencyWithdraw(token);
    }

    // ─── Admin config ───

    function setLockDuration(uint256 newLockDuration) external onlyRole(DEFAULT_ADMIN_ROLE) {
        lockDuration = newLockDuration;
        emit LockDurationUpdated(newLockDuration);
    }

    function setPlatformWeights(uint256 weightStartWad, uint256 weightEndWad, uint256 durationSeconds)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _validateWeightConfig(weightStartWad, weightEndWad, durationSeconds);
        platformWeights = WeightConfig(weightStartWad, weightEndWad, durationSeconds);
        emit PlatformWeightsUpdated(weightStartWad, weightEndWad, durationSeconds);
    }

    function setCaseWeights(uint256 weightStartWad, uint256 weightEndWad, uint256 durationSeconds)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _validateWeightConfig(weightStartWad, weightEndWad, durationSeconds);
        caseWeights = WeightConfig(weightStartWad, weightEndWad, durationSeconds);
        emit CaseWeightsUpdated(weightStartWad, weightEndWad, durationSeconds);
    }

    // ─── Staking ───

    function stakePlatform(uint256 amount, string calldata uri)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 positionId)
    {
        positionId = _stake(amount, PositionKind.Platform, 0, uri);
        emit StakedPlatform(msg.sender, positionId, amount);
    }

    function stakeCase(uint256 caseId, uint256 amount, string calldata uri)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 positionId)
    {
        CaseInfo storage c = cases[caseId];
        if (!c.registered || !c.active || c.closed) revert CaseNotActive();
        positionId = _stake(amount, PositionKind.Case, caseId, uri);
        emit StakedCase(msg.sender, caseId, positionId, amount);
    }

    function unstake(uint256 positionId) external nonReentrant whenNotPaused {
        Position storage p = positions[positionId];
        if (p.owner != msg.sender) revert NotOwner();
        if (p.closed) revert PositionClosed();
        if (block.timestamp < p.lockEnd) revert StillLocked();
        uint256 amount = p.amount;
        p.amount = 0;
        p.closed = true;
        stakeToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, positionId, amount);
    }

    // ─── Views ───

    function votingPower(uint256 positionId) external view returns (uint256) {
        return votingPowerOfPosition(positionId);
    }

    function votingPowerOfPosition(uint256 positionId) public view returns (uint256) {
        Position storage p = positions[positionId];
        if (p.closed || p.amount == 0) return 0;
        return (p.amount * _weightWadAt(p, block.timestamp)) / WAD;
    }

    function votingPowerOfPositionAt(uint256 positionId, uint256 timestamp) external view returns (uint256) {
        Position storage p = positions[positionId];
        if (p.closed || p.amount == 0) return 0;
        return (p.amount * _weightWadAt(p, timestamp)) / WAD;
    }

    function currentWeightWad(uint256 positionId) external view returns (uint256) {
        Position storage p = positions[positionId];
        if (p.closed || p.amount == 0) return 0;
        return _weightWadAt(p, block.timestamp);
    }

    function positionNft(uint256 positionId) external view returns (address) {
        Position storage p = positions[positionId];
        return p.kind == PositionKind.Platform ? address(platformNFT) : address(caseNFT);
    }

    function _requirePlatformPositionForPoll(Position storage p) internal view {
        if (p.kind != PositionKind.Platform) revert WrongPollScope();
    }

    function _requireCasePositionForPoll(Position storage p) internal view {
        if (p.kind != PositionKind.Case) revert WrongPollScope();
        if (!cases[p.caseId].registered) revert CaseNotRegistered();
    }

    function _stake(uint256 amount, PositionKind kind, uint256 caseId, string calldata uri)
        internal
        returns (uint256 positionId)
    {
        if (amount == 0) revert ZeroAmount();
        if (bytes(uri).length == 0) revert EmptyURI();
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        positionId = _nextPositionId++;
        uint256 stakedAt = block.timestamp;
        positions[positionId] = Position({
            amount: amount,
            stakedAt: stakedAt,
            lockEnd: stakedAt + lockDuration,
            owner: msg.sender,
            kind: kind,
            caseId: caseId,
            closed: false
        });
        if (kind == PositionKind.Platform) platformNFT.mint(msg.sender, positionId, uri);
        else caseNFT.mint(msg.sender, positionId, uri);
    }

    function _weightWadAt(Position storage p, uint256 timestamp) internal view returns (uint256) {
        if (timestamp < p.stakedAt) return 0;
        WeightConfig storage cfg = p.kind == PositionKind.Platform ? platformWeights : caseWeights;
        uint256 elapsed = timestamp - p.stakedAt;
        if (cfg.durationSeconds == 0) return cfg.weightEndWad;
        if (elapsed >= cfg.durationSeconds) return cfg.weightEndWad;
        return cfg.weightStartWad + ((cfg.weightEndWad - cfg.weightStartWad) * elapsed) / cfg.durationSeconds;
    }

    function _validateWeightConfig(uint256 weightStartWad, uint256 weightEndWad, uint256 durationSeconds) internal pure {
        if (weightEndWad < weightStartWad) revert InvalidWeights();
        if (durationSeconds == 0) revert InvalidDuration();
    }

    error ZeroAmount();
    error ZeroAddress();
    error EmptyURI();
    error NotOwner();
    error StillLocked();
    error PositionClosed();
    error CaseNotRegistered();
    error CaseAlreadyRegistered();
    error CaseNotActive();
    error CaseIsClosed();
    error CaseAlreadyClosed();
    error ExceedsVotingPower();
    error InvalidWeights();
    error InvalidDuration();
    error InvalidDeadline();
    error InvalidBps();
    error PollAlreadyExists();
    error PollNotFound();
    error PollIsFinalized();
    error PollExpired();
    error AlreadyVoted();
    error InvalidOptionCount();
    error InvalidOptionIndex();
    error WrongPollScope();
    error PollNotExpired();
    error DeadlineNotExtended();
    error CannotWithdrawStakeToken();
    error InvalidPreference();
}
