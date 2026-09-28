# ClaimShareStaking

Smart-contract audit package for the ClaimShare staking, position-NFT, and on-chain governance system on Base L2.

- **Target chain:** Base (L2), Solidity `0.8.20`
- **Framework:** Hardhat + `@openzeppelin/contracts@5.0.0`
- **License:** MIT

---

## Scope

Three production contracts plus a test-only mock:

| File | Role |
| --- | --- |
| `contracts/ClaimSharePausable.sol` | Abstract base: `AccessControl` + `Pausable`, `PAUSER_ROLE`, internal `_emergencyWithdraw` helper. |
| `contracts/ClaimSharePositionNFT.sol` | Abstract soulbound ERC-721 (with `ERC4906`) + `PlatformPositionNFT` / `CasePositionNFT` concrete instances. |
| `contracts/ClaimShareStaking.sol` | Main contract: two-tier staking, linear voting-power ramp, case lifecycle, multi-option polls, payout preferences, emergency controls. |
| `contracts/MockERC20.sol` | Test fixture only (excluded from coverage via `.solcover.js`). Not deployed to production. |

---

## Architecture

### Two-tier staking
- **Platform stakes** — global voting power. VP ramps linearly from `weightStart` (0.5×) → `weightEnd` (1.5×) over `platformWeights.durationSeconds`.
- **Case stakes** — case-scoped voting power. VP ramps linearly from `weightStart` (0.75×) → `weightEnd` (2.25×) over `caseWeights.durationSeconds`.
- Each stake mints one **soulbound** position NFT (`PlatformPositionNFT` / `CasePositionNFT`). Non-transferable; burn allowed at the ERC-721 layer but no burn is exposed.
- `lockDuration` blocks `unstake` only; it does **not** reduce voting power.

### Cases (`CASE_MANAGER_ROLE`)
`registerCase` → `deactivateCase` (optional; blocks new case stakes) → `closeCase` (final; sets `closedAt`). Users may set an on-chain / off-chain payout preference (`setPayoutPreference`) at any point before the case is closed; this is advisory metadata used off-chain.

### Governance / Polls (`GOVERNANCE_ADMIN_ROLE`)
- Multi-option polls (2–16 options) with per-position, one-shot votes.
- Vote weight ≤ current position voting power.
- Platform positions vote via `voteOnPoll`; case positions via `voteOnPollCase`.
- Admin can only **extend** the deadline (monotonic; shortening is disallowed).
- `finalizePoll` requires the deadline to have passed.

### Emergency controls (`PAUSER_ROLE` / `DEFAULT_ADMIN_ROLE`)
- `pause` / `unpause` gates user-facing entrypoints (stake, unstake, vote, set payout preference).
- `emergencyWithdraw(token)` recovers stranded ERC-20 tokens **but explicitly reverts if `token == stakeToken`** so user deposits can never be drained.

---

## Roles

| Role | Powers |
| --- | --- |
| `DEFAULT_ADMIN_ROLE` | Role management, weight/lock config, emergency withdraw of non-stake tokens. |
| `CASE_MANAGER_ROLE` | `registerCase`, `deactivateCase`, `closeCase`. |
| `GOVERNANCE_ADMIN_ROLE` | `createPoll`, `extendPollDeadline`, `finalizePoll`. |
| `PAUSER_ROLE` | `pause`, `unpause`. |
| `MINTER_ROLE` (NFTs) | Mint / `setTokenURI` on position NFTs. Granted to the staking contract after wiring. |

All roles are granted to the deployer's `admin` at construction. Downstream role delegation is out-of-band.

---

## Invariants (informal)

1. `stakeToken` balance of the staking contract ≥ Σ open position amounts.
2. `emergencyWithdraw` cannot reduce the `stakeToken` balance.
3. Each position is minted exactly one soulbound NFT; NFT is non-transferable while owned by a non-zero address.
4. Voting power of a closed / zero-amount position is `0`.
5. Voting power is monotonically non-decreasing in time within `[stakedAt, stakedAt + position.durationSeconds]` and constant afterwards. Each position uses the weight curve snapshotted at stake; later global updates do not change existing positions or `votingPowerOfPositionAt`.
6. One vote per `(pollId, positionId)`; per-vote weight ≤ `votingPowerOfPosition(positionId)`.
7. Poll deadlines only move forward; `finalizePoll` cannot run before the deadline.
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
| ClaimSharePositionNFT.sol | 100% | 88.9% | 100% | 100% |
| ClaimShareStaking.sol | 99.2% | 90.6% | 100% | 100% |
| **All in-scope** | **99.4%** | **90.8%** | **100%** | **100%** |

61 passing tests across 9 spec files. `MockERC20.sol` is excluded from the coverage report by `.solcover.js`.

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

- **`abi.encode` is used for all struct-like hashing** where present; no `abi.encodePacked` with dynamic types.
- **All external state mutations use custom errors**; there are no `require(string)` reverts.
- **`nonReentrant` + CEI** on every ERC-20 interaction (`stake`, `unstake`, `emergencyWithdraw`).
- **No `delegatecall`, no `selfdestruct`, no assembly.**
- **No upgradability** — contracts are non-proxied and immutable after deploy.
- **Centralization surface** is documented above (§ Roles). Admin can update lock/weight configs and pause the system; admin cannot drain the stakeToken.

---

## Environment

`.env.example` shows the variables consumed by `hardhat.config.ts`. Only `PRIVATE_KEY` + `RPC_URL` are needed for a live deploy; tests run against the in-memory Hardhat network and require nothing.
