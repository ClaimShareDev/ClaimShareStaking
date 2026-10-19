# ClaimShareStaking

Smart-contract audit package for the ClaimShare staking, position-NFT, and on-chain governance system on Base L2.

- **Target chain:** Base (L2), Solidity `0.8.20`
- **Framework:** Hardhat + `@openzeppelin/contracts@5.0.0`
- **License:** MIT

---

## Scope

Three production contracts plus test-only contracts:

| File | Role |
| --- | --- |
| `contracts/ClaimSharePausable.sol` | Abstract base: `AccessControl` + `Pausable`, `PAUSER_ROLE`, internal `_emergencyWithdraw` helper. |
| `contracts/ClaimSharePositionNFT.sol` | Abstract soulbound ERC-721 (with `ERC4906`) + `PlatformPositionNFT` / `CasePositionNFT` concrete instances. |
| `contracts/ClaimShareStaking.sol` | Main contract: two-tier staking, linear voting-power ramp, case lifecycle, multi-option polls, payout preferences, emergency controls. |
| `contracts/MockERC20.sol` | Test-only: `MockERC20`, a fee-on-transfer token, a fee-on-top token and `ReentrantStaker` (reentrancy tests). Excluded from coverage via `.solcover.js`. Not deployed to production. |

---

## Architecture

### Two-tier staking
- **Platform stakes** — global voting power. VP ramps linearly from `weightStart` to `weightEnd` (defaults 0.5× → 1.5×).
- **Case stakes** — case-scoped voting power. VP ramps linearly from `weightStart` to `weightEnd` (defaults 0.75× → 2.25×).
- Each position stores the weight curve (`weightStartWad`, `weightEndWad`, `durationSeconds`) from `platformWeights` / `caseWeights` at the moment it is staked. Later changes to those settings apply only to new positions.
- Each stake mints one **soulbound** position NFT (`PlatformPositionNFT` / `CasePositionNFT`). Non-transferable; burn allowed at the ERC-721 layer but no burn is exposed. After unstaking, the NFT stays with its owner and the position's voting power is 0.
- `lockDuration` blocks `unstake` only; it does **not** reduce voting power. `lockEnd` is fixed at stake, so changing `lockDuration` affects only new positions.
- Voting adds a second lock: a position that voted cannot be unstaked until the last poll it voted on has ended (`voteLockedUntil`, see § Governance / Polls).

### Cases (`CASE_MANAGER_ROLE`)
`registerCase` → `deactivateCase` (optional; blocks new case stakes) → `closeCase` (final; sets `closedAt`). Users may set an on-chain / off-chain payout preference (`setPayoutPreference`) at any point before the case is closed; this is advisory metadata used off-chain. The stored on-chain share is normalized: `FullOnChain` stores 10000 bps, `FullOffChain` stores 0, `Partial` requires 1–9999, and `NotSet` reverts.

### Governance / Polls (`GOVERNANCE_ADMIN_ROLE`)
- Multi-option polls (2–16 options) with per-position, one-shot votes.
- Results are **display-only**: `PollFinalized` / `winningOption` are shown in the app and trigger no on-chain or off-chain action.
- Any open position can vote, including one staked after the poll opened.
- **Voting locks the position until the poll ends.** `voteLockedUntil(positionId)` holds the latest deadline of any poll the position voted on; `unstake` reverts with `LockedByVote` until that time has passed. The tokens behind a vote therefore stay staked until the poll closes and cannot vote again in the same poll through a new position. This holds even if `lockDuration` is 0, so borrowed tokens cannot vote and leave.
- Vote weight ≤ current position voting power. `polls(pollId).totalVotes` is the sum of all weights cast.
- Platform positions vote via `voteOnPoll`; case positions via `voteOnPollCase`.
- Admin can only **extend** the deadline, and only before the first vote (`PollHasVotes` otherwise), so the unlock time a voter sees when voting never changes. The new deadline must be later than the current one and in the future.
- `finalizePoll` requires the deadline to have passed. It picks the option with the most weight (lowest index on a tie). A poll with no votes finalizes with `winningOption == NO_WINNER` (255), never option 0; `winningOption` is also `NO_WINNER` before finalization.

### Emergency controls (`PAUSER_ROLE` / `DEFAULT_ADMIN_ROLE`)
- `pause` / `unpause` gates user-facing entrypoints (stake, unstake, vote, set payout preference).
- `emergencyWithdraw(token)` recovers stranded ERC-20 tokens **but explicitly reverts if `token == stakeToken`** so user deposits can never be drained.

### Stake token requirements and transfer semantics
The stake token is fixed at deploy. Production uses CLAIM `0x312E8d3caddC69F131AA077ceA0F98ED03be66ac` on Base. CLAIM is not a standard ERC-20: it includes tax and transfer-control logic. Its `taxFee` is zero and cannot be changed, so no transfer fee is applied. The contract supports an ERC-20 whose balances change only through transfers, and handles transfer fees as follows:

| Token behavior | Supported | What the contract does |
| --- | --- | --- |
| CLAIM with `taxFee` 0 (current) | Yes | Credits and returns the exact amount, because no fee is applied. |
| Fee deducted from a transfer, on stake | Yes | Credits only the balance increase (`balanceAfter - balanceBefore`); `StakedPlatform` / `StakedCase` emit that amount. A stake where nothing arrives reverts with `ZeroAmount`. |
| Fee deducted from a transfer, on unstake | Yes | Sends the full position amount; the holder bears the fee. `Unstaked` emits the amount sent. `UnstakeReceived` reports what the holder actually received and does not reject a smaller amount. A CLAIM-style tax still debits the staking contract for the full position amount, so `UnsupportedStakeToken` does not catch it. |
| Token that takes more than the transfer amount from the sender | No | `unstake` reverts with `UnsupportedStakeToken`, so it can never pay out of other positions. |
| Rebasing token | No | Not supported. Balances must change only through transfers. |
| Tokens sent directly to the contract | — | Never credited to any position. |

`totalStaked` is the sum of all open position amounts. For a supported token, `stakeToken.balanceOf(staking) >= totalStaked` always holds, and anyone can check it on-chain.

---

## Roles

| Role | Powers |
| --- | --- |
| `DEFAULT_ADMIN_ROLE` | Role management, weight/lock config, emergency withdraw of non-stake tokens. |
| `CASE_MANAGER_ROLE` | `registerCase`, `deactivateCase`, `closeCase`. |
| `GOVERNANCE_ADMIN_ROLE` | `createPoll`, `extendPollDeadline`, `finalizePoll`. |
| `PAUSER_ROLE` | `pause`, `unpause`. |
| `MINTER_ROLE` (NFTs) | Mint / `setTokenURI` on position NFTs. Granted to the staking contract after wiring. |
| `DEFAULT_ADMIN_ROLE` (NFTs) | `wireStaking` (once) and NFT role management. |

All roles are granted to the `admin` address passed at construction. In production `admin` is a 2-of-3 Safe. Any role granted later must also go to a Safe, except `MINTER_ROLE` for the staking contract.

---

## Invariants (informal)

1. `stakeToken.balanceOf(staking) >= totalStaked`, where `totalStaked` is Σ open position amounts. Every stake adds the credited amount, every unstake removes exactly the amount sent, and `unstake` reverts if the token would take more than that.
2. `emergencyWithdraw` cannot reduce the `stakeToken` balance.
3. Each position is minted exactly one soulbound NFT; NFT is non-transferable while owned by a non-zero address.
4. Voting power of a closed / zero-amount position is `0`.
5. Voting power is monotonically non-decreasing in time within `[stakedAt, stakedAt + position.durationSeconds]` and constant afterwards. Each position uses the weight curve snapshotted at stake; later global updates do not change existing positions or `votingPowerOfPositionAt`.
6. One vote per `(pollId, positionId)`; per-vote weight ≤ `votingPowerOfPosition(positionId)`. A position that voted cannot be unstaked until `voteLockedUntil(positionId)` has passed, so the same tokens are never counted twice in one poll and every vote stays backed by stake until the poll ends.
7. Poll deadlines only move forward, only before the first vote, and an extended deadline is always in the future; `finalizePoll` cannot run before the deadline.
8. `wireStaking` on each position NFT is settable exactly once, to a non-zero address.

---

## Build & test

```bash
npm install
npm run compile
npm test
npm run coverage
```

### Coverage (latest run)

| Contract | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| ClaimSharePausable.sol | 100% | 100% | 100% | 100% |
| ClaimSharePositionNFT.sol | 100% | 100% | 100% | 100% |
| ClaimShareStaking.sol | 99.3% | 97.9% | 100% | 100% |
| **All in-scope** | **99.4%** | **98.1%** | **100%** | **100%** |

92 passing tests across 9 spec files. `MockERC20.sol` (test-only contracts) is excluded from the coverage report by `.solcover.js`.

The remaining uncovered branches are four defensive checks that cannot be reached by design:
- `p.amount == 0` in `_castPollVote`: an open position always has a non-zero amount.
- `c.closed` in `stakeCase`: closing a case also marks it inactive, so `!c.active` triggers first.
- `!cases[p.caseId].registered` in `_requireCasePositionForPoll`: case positions only exist for registered cases.
- `p.durationSeconds == 0` in `_weightWadAt`: the duration is validated as non-zero before it is stored.

---

## Deployment order

The three production contracts must be deployed in this order:

1. Deploy `PlatformPositionNFT(admin)` and `CasePositionNFT(admin)`.
2. Deploy `ClaimShareStaking(stakeToken, platformNFT, caseNFT, admin, lockDuration, platformWeights, caseWeights)`.
3. From `admin`, on each NFT:
   - `wireStaking(stakingAddress)` — one-time, non-zero, sets the VP view.
   - `grantRole(MINTER_ROLE, stakingAddress)` — allows the staking contract to mint position NFTs.

The constructor validates all addresses are non-zero and both weight configurations pass `_validateWeightConfig`.

---

## Notes for auditors

- **No signature or hash-based logic**; the only hashes are constant role identifiers.
- **All external state mutations use custom errors**; there are no `require(string)` reverts.
- **Reentrancy:** `stakePlatform`, `stakeCase` and `unstake` are `nonReentrant`, which the tests check with a contract staker that tries to re-enter from its NFT callback. `unstake` updates state before transferring. A stake must pull tokens first to measure what arrived, so it relies on the guard. `emergencyWithdraw` is admin-only, changes no contract state and cannot touch the stake token.
- **No `delegatecall`, no `selfdestruct`, no assembly** in the in-scope contracts.
- **No upgradability** — contracts are non-proxied and immutable after deploy.
- **Centralization surface** is documented above (§ Roles). Admin can update lock/weight configs (new positions only) and pause the system; admin cannot drain the stakeToken.

---

## Environment

`.env.example` shows the variables consumed by `hardhat.config.ts`. Only `PRIVATE_KEY` + `RPC_URL` are needed for a live deploy; tests run against the in-memory Hardhat network and require nothing.
