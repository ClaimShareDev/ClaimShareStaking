import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { FeeOnTopMock, FeeOnTransferMock } from "../typechain-types";
import {
  CASE_WEIGHT_END,
  CASE_WEIGHT_START,
  PLATFORM_WEIGHT_END,
  PLATFORM_WEIGHT_START,
  TEST_CASE_RAMP_SECONDS,
  TEST_PLATFORM_RAMP_SECONDS,
  WAD,
  deployTestStack,
  meta,
  pollMeta,
  votingPowerAt,
} from "./helpers/deploy";

describe("CLA-02 — credit tokens actually received", () => {
  async function deployWithFeeToken(feeBps: bigint) {
    return deployStakingFor(await (await ethers.getContractFactory("FeeOnTransferMock")).deploy(feeBps));
  }

  async function deployWithFeeOnTopToken(feeBps: bigint) {
    return deployStakingFor(await (await ethers.getContractFactory("FeeOnTopMock")).deploy(feeBps));
  }

  async function deployStakingFor<T extends FeeOnTransferMock | FeeOnTopMock>(claim: T) {
    const [owner, user, other] = await ethers.getSigners();
    const platformNFT = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
    const caseNFT = await (await ethers.getContractFactory("CasePositionNFT")).deploy(owner.address);
    const platformWeights = {
      weightStartWad: PLATFORM_WEIGHT_START,
      weightEndWad: PLATFORM_WEIGHT_END,
      durationSeconds: TEST_PLATFORM_RAMP_SECONDS,
    };
    const caseWeights = {
      weightStartWad: CASE_WEIGHT_START,
      weightEndWad: CASE_WEIGHT_END,
      durationSeconds: TEST_CASE_RAMP_SECONDS,
    };
    const staking = await (
      await ethers.getContractFactory("ClaimShareStaking")
    ).deploy(
      await claim.getAddress(),
      await platformNFT.getAddress(),
      await caseNFT.getAddress(),
      owner.address,
      60n,
      platformWeights,
      caseWeights
    );
    const stakingAddr = await staking.getAddress();
    const minter = await platformNFT.MINTER_ROLE();
    await platformNFT.connect(owner).wireStaking(stakingAddr);
    await caseNFT.connect(owner).wireStaking(stakingAddr);
    await platformNFT.connect(owner).grantRole(minter, stakingAddr);
    await caseNFT.connect(owner).grantRole(minter, stakingAddr);
    for (const s of [user, other]) {
      await claim.mint(s.address, ethers.parseEther("10000"));
      await claim.connect(s).approve(stakingAddr, ethers.MaxUint256);
    }
    return { owner, user, other, claim, staking, stakingAddr };
  }

  it("standard token still credits and returns the full amount", async () => {
    const { user, staking, claim } = await deployTestStack();
    const amt = ethers.parseEther("1000");
    const stakingAddr = await staking.getAddress();
    const before = await claim.balanceOf(stakingAddr);
    await expect(staking.connect(user).stakePlatform(amt, meta("full")))
      .to.emit(staking, "StakedPlatform")
      .withArgs(user.address, 1n, amt);
    expect((await staking.positions(1n)).amount).to.equal(amt);
    expect(await staking.totalStaked()).to.equal(amt);
    expect(await claim.balanceOf(stakingAddr)).to.equal(before + amt);

    await time.increase(61);
    await expect(staking.connect(user).unstake(1n))
      .to.emit(staking, "Unstaked")
      .withArgs(user.address, 1n, amt)
      .and.to.emit(staking, "UnstakeReceived")
      .withArgs(user.address, 1n, amt);
    expect(await staking.totalStaked()).to.equal(0n);
    expect(await claim.balanceOf(stakingAddr)).to.equal(before);
  });

  it("fee-on-transfer token credits only what arrived, and unstake returns that", async () => {
    const { owner, user, claim, staking, stakingAddr } = await deployWithFeeToken(1000n); // 10%
    const requested = ethers.parseEther("1000");
    const received = (requested * 9000n) / 10_000n;

    await staking.connect(owner).registerCase(1n, meta("c"));
    await expect(staking.connect(user).stakePlatform(requested, meta("fee")))
      .to.emit(staking, "StakedPlatform")
      .withArgs(user.address, 1n, received);

    expect((await staking.positions(1n)).amount).to.equal(received);
    expect(await claim.balanceOf(stakingAddr)).to.equal(received);
    expect(await staking.votingPower(1n)).to.equal((received * PLATFORM_WEIGHT_START) / WAD);

    await expect(staking.connect(user).stakeCase(1n, requested, meta("fee-case")))
      .to.emit(staking, "StakedCase")
      .withArgs(user.address, 1n, 2n, received);
    expect((await staking.positions(2n)).amount).to.equal(received);

    expect(await staking.totalStaked()).to.equal(2n * received);

    await time.increase(61);
    const userBefore = await claim.balanceOf(user.address);
    // The contract sends the full credited amount; the outbound fee is borne by the holder.
    const outboundFee = (received * 1000n) / 10_000n;
    await expect(staking.connect(user).unstake(1n))
      .to.emit(staking, "Unstaked")
      .withArgs(user.address, 1n, received)
      .and.to.emit(staking, "UnstakeReceived")
      .withArgs(user.address, 1n, received - outboundFee);
    expect(await claim.balanceOf(user.address) - userBefore).to.equal(received - outboundFee);
    expect(await staking.totalStaked()).to.equal(received);
    expect(await claim.balanceOf(stakingAddr)).to.equal(received);
  });

  it("reverts when a fee takes the entire transfer", async () => {
    const { user, staking } = await deployWithFeeToken(10_000n);
    await expect(staking.connect(user).stakePlatform(ethers.parseEther("1"), meta("all-fee"))).to.be.revertedWithCustomError(
      staking,
      "ZeroAmount"
    );
  });

  it("a fee switched on after staking is borne by the holder; the pool stays fully backed", async () => {
    const { user, other, claim, staking, stakingAddr } = await deployWithFeeToken(0n);
    const amt = ethers.parseEther("1000");
    await staking.connect(user).stakePlatform(amt, meta("a"));
    await staking.connect(other).stakePlatform(amt, meta("b"));
    expect(await staking.totalStaked()).to.equal(2n * amt);
    await time.increase(61);

    await claim.setFeeBps(5000n); // 50% outbound fee
    await expect(staking.connect(user).unstake(1n))
      .to.emit(staking, "Unstaked")
      .withArgs(user.address, 1n, amt)
      .and.to.emit(staking, "UnstakeReceived")
      .withArgs(user.address, 1n, amt / 2n);
    expect(await staking.totalStaked()).to.equal(amt);
    expect(await claim.balanceOf(stakingAddr)).to.equal(amt);

    await claim.setFeeBps(10_000n); // fee takes everything: holder receives nothing, pool still balanced
    const otherBefore = await claim.balanceOf(other.address);
    await expect(staking.connect(other).unstake(2n))
      .to.emit(staking, "UnstakeReceived")
      .withArgs(other.address, 2n, 0n);
    expect(await claim.balanceOf(other.address)).to.equal(otherBefore);
    expect(await staking.totalStaked()).to.equal(0n);
    expect(await claim.balanceOf(stakingAddr)).to.equal(0n);
  });

  it("a token that charges the sender extra cannot pay out of other positions", async () => {
    const { user, other, claim, staking, stakingAddr } = await deployWithFeeOnTopToken(1000n); // 10% on top
    const amt = ethers.parseEther("1000");
    // The staker pays the extra fee; the contract receives and credits the full amount.
    await staking.connect(user).stakePlatform(amt, meta("a"));
    await staking.connect(other).stakePlatform(amt, meta("b"));
    expect((await staking.positions(1n)).amount).to.equal(amt);
    expect(await staking.totalStaked()).to.equal(2n * amt);
    expect(await claim.balanceOf(stakingAddr)).to.equal(2n * amt);

    await time.increase(61);
    await expect(staking.connect(user).unstake(1n)).to.be.revertedWithCustomError(staking, "UnsupportedStakeToken");
    // Nothing moved: the position is still open and both positions remain fully backed.
    expect((await staking.positions(1n)).closed).to.equal(false);
    expect(await staking.totalStaked()).to.equal(2n * amt);
    expect(await claim.balanceOf(stakingAddr)).to.equal(2n * amt);
  });

  it("tokens sent directly to the contract are never credited to a position", async () => {
    const { user, other, claim, staking } = await deployTestStack();
    const stakingAddr = await staking.getAddress();
    const stray = ethers.parseEther("500");
    await claim.connect(other).transfer(stakingAddr, stray);

    const amt = ethers.parseEther("100");
    await staking.connect(user).stakePlatform(amt, meta("p"));
    expect((await staking.positions(1n)).amount).to.equal(amt);
    expect(await staking.totalStaked()).to.equal(amt);
    expect(await claim.balanceOf(stakingAddr)).to.equal(amt + stray);
  });
});

describe("CLA-03 — payout preference BPS normalization", () => {
  it("FullOnChain always stores and emits 10000 regardless of caller BPS", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, meta("c"));

    await expect(staking.connect(user).setPayoutPreference(1n, 1, 0))
      .to.emit(staking, "PayoutPreferenceSet")
      .withArgs(1n, user.address, 1, 10_000);
    expect(await staking.payoutOnChainBps(1n, user.address)).to.equal(10_000);

    await expect(staking.connect(user).setPayoutPreference(1n, 1, 999_999))
      .to.emit(staking, "PayoutPreferenceSet")
      .withArgs(1n, user.address, 1, 10_000);
    expect(await staking.payoutPreference(1n, user.address)).to.equal(1);
    expect(await staking.payoutOnChainBps(1n, user.address)).to.equal(10_000);
  });

  it("FullOffChain always stores and emits 0 regardless of caller BPS", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, meta("c"));

    await expect(staking.connect(user).setPayoutPreference(1n, 2, 8000))
      .to.emit(staking, "PayoutPreferenceSet")
      .withArgs(1n, user.address, 2, 0);
    expect(await staking.payoutPreference(1n, user.address)).to.equal(2);
    expect(await staking.payoutOnChainBps(1n, user.address)).to.equal(0);
  });

  it("Partial still requires 1..9999 and stores the provided BPS", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, meta("c"));

    await expect(staking.connect(user).setPayoutPreference(1n, 3, 1))
      .to.emit(staking, "PayoutPreferenceSet")
      .withArgs(1n, user.address, 3, 1);
    expect(await staking.payoutOnChainBps(1n, user.address)).to.equal(1);

    await expect(staking.connect(user).setPayoutPreference(1n, 3, 9999))
      .to.emit(staking, "PayoutPreferenceSet")
      .withArgs(1n, user.address, 3, 9999);
    expect(await staking.payoutOnChainBps(1n, user.address)).to.equal(9999);

    await expect(staking.connect(user).setPayoutPreference(1n, 3, 0)).to.be.revertedWithCustomError(
      staking,
      "InvalidBps"
    );
    await expect(staking.connect(user).setPayoutPreference(1n, 3, 10_000)).to.be.revertedWithCustomError(
      staking,
      "InvalidBps"
    );
  });
});

describe("CLA-04 — per-position weight snapshot", () => {
  it("copies the live curve onto the position at stake", async () => {
    const { user, staking } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("p"));
    const pos = await staking.positions(1n);
    expect(pos.weightStartWad).to.equal(PLATFORM_WEIGHT_START);
    expect(pos.weightEndWad).to.equal(PLATFORM_WEIGHT_END);
    expect(pos.durationSeconds).to.equal(TEST_PLATFORM_RAMP_SECONDS);
  });

  it("existing platform position keeps original VP after global weight change", async () => {
    const { owner, user, staking } = await deployTestStack();
    const amt = ethers.parseEther("1000");
    await staking.connect(user).stakePlatform(amt, meta("old"));
    const pos = await staking.positions(1n);
    const stakedAt = pos.stakedAt;

    expect(await staking.votingPower(1n)).to.equal((amt * PLATFORM_WEIGHT_START) / WAD);

    const newStart = 2n * 10n ** 17n; // 0.2×
    const newEnd = 4n * 10n ** 17n; // 0.4×
    const newDur = 10_000n;
    await staking.connect(owner).setPlatformWeights(newStart, newEnd, newDur);

    const now = BigInt(await time.latest());
    const expectedOld = votingPowerAt(
      amt,
      now,
      stakedAt,
      PLATFORM_WEIGHT_START,
      PLATFORM_WEIGHT_END,
      TEST_PLATFORM_RAMP_SECONDS
    );
    const expectedIfLive = votingPowerAt(amt, now, stakedAt, newStart, newEnd, newDur);
    expect(await staking.votingPower(1n)).to.equal(expectedOld);
    expect(await staking.votingPower(1n)).to.not.equal(expectedIfLive);

    const mid = stakedAt + TEST_PLATFORM_RAMP_SECONDS / 2n;
    await time.increaseTo(mid);
    expect(await staking.votingPower(1n)).to.equal(
      votingPowerAt(amt, mid, stakedAt, PLATFORM_WEIGHT_START, PLATFORM_WEIGHT_END, TEST_PLATFORM_RAMP_SECONDS)
    );
    expect(await staking.votingPowerOfPositionAt(1n, mid)).to.equal(
      votingPowerAt(amt, mid, stakedAt, PLATFORM_WEIGHT_START, PLATFORM_WEIGHT_END, TEST_PLATFORM_RAMP_SECONDS)
    );
    expect(await staking.currentWeightWad(1n)).to.equal(
      PLATFORM_WEIGHT_START +
        ((PLATFORM_WEIGHT_END - PLATFORM_WEIGHT_START) * (mid - stakedAt)) / TEST_PLATFORM_RAMP_SECONDS
    );

    await time.increaseTo(stakedAt + TEST_PLATFORM_RAMP_SECONDS);
    expect(await staking.votingPower(1n)).to.equal((amt * PLATFORM_WEIGHT_END) / WAD);
    expect(await staking.currentWeightWad(1n)).to.equal(PLATFORM_WEIGHT_END);
  });

  it("new platform stake after a weight change uses the new curve only", async () => {
    const { owner, user, other, staking } = await deployTestStack();
    const amt = ethers.parseEther("1000");
    await staking.connect(user).stakePlatform(amt, meta("old"));

    const newStart = 2n * 10n ** 17n;
    const newEnd = 8n * 10n ** 17n;
    const newDur = 200n;
    await staking.connect(owner).setPlatformWeights(newStart, newEnd, newDur);
    await staking.connect(other).stakePlatform(amt, meta("new"));

    const oldPos = await staking.positions(1n);
    const newPos = await staking.positions(2n);
    expect(oldPos.weightStartWad).to.equal(PLATFORM_WEIGHT_START);
    expect(newPos.weightStartWad).to.equal(newStart);
    expect(newPos.weightEndWad).to.equal(newEnd);
    expect(newPos.durationSeconds).to.equal(newDur);

    const now = BigInt(await time.latest());
    expect(await staking.votingPower(1n)).to.equal(
      votingPowerAt(
        amt,
        now,
        oldPos.stakedAt,
        PLATFORM_WEIGHT_START,
        PLATFORM_WEIGHT_END,
        TEST_PLATFORM_RAMP_SECONDS
      )
    );
    expect(await staking.votingPower(2n)).to.equal(
      votingPowerAt(amt, now, newPos.stakedAt, newStart, newEnd, newDur)
    );

    await time.increaseTo(newPos.stakedAt + newDur);
    expect(await staking.votingPower(2n)).to.equal((amt * newEnd) / WAD);
    expect(await staking.votingPower(1n)).to.equal(
      votingPowerAt(
        amt,
        newPos.stakedAt + newDur,
        oldPos.stakedAt,
        PLATFORM_WEIGHT_START,
        PLATFORM_WEIGHT_END,
        TEST_PLATFORM_RAMP_SECONDS
      )
    );
  });

  it("existing case position keeps original VP after setCaseWeights", async () => {
    const { owner, user, other, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, meta("c"));
    const amt = ethers.parseEther("1000");
    await staking.connect(user).stakeCase(1n, amt, meta("old-case"));

    expect(await staking.votingPower(1n)).to.equal((amt * CASE_WEIGHT_START) / WAD);

    const newStart = 1n * 10n ** 17n;
    const newEnd = 2n * 10n ** 17n;
    const newDur = 50n;
    await staking.connect(owner).setCaseWeights(newStart, newEnd, newDur);

    const oldPos = await staking.positions(1n);
    const now = BigInt(await time.latest());
    expect(await staking.votingPower(1n)).to.equal(
      votingPowerAt(amt, now, oldPos.stakedAt, CASE_WEIGHT_START, CASE_WEIGHT_END, TEST_CASE_RAMP_SECONDS)
    );
    expect(await staking.votingPower(1n)).to.not.equal(
      votingPowerAt(amt, now, oldPos.stakedAt, newStart, newEnd, newDur)
    );

    await staking.connect(other).stakeCase(1n, amt, meta("new-case"));
    const newPos = await staking.positions(2n);
    expect(await staking.votingPower(2n)).to.equal(
      votingPowerAt(amt, BigInt(await time.latest()), newPos.stakedAt, newStart, newEnd, newDur)
    );

    expect(oldPos.weightStartWad).to.equal(CASE_WEIGHT_START);
    expect(oldPos.weightEndWad).to.equal(CASE_WEIGHT_END);
    expect(oldPos.durationSeconds).to.equal(TEST_CASE_RAMP_SECONDS);
    expect(newPos.weightStartWad).to.equal(newStart);
  });

  it("historical query after a global change still uses the snapshotted curve", async () => {
    const { owner, user, staking } = await deployTestStack();
    const amt = ethers.parseEther("400");
    await staking.connect(user).stakePlatform(amt, meta("p"));
    const stakedAt = (await staking.positions(1n)).stakedAt;
    const mid = stakedAt + 30n;

    await staking.connect(owner).setPlatformWeights(1n, 2n, 1n);

    expect(await staking.votingPowerOfPositionAt(1n, stakedAt - 1n)).to.equal(0n);
    expect(await staking.votingPowerOfPositionAt(1n, mid)).to.equal(
      votingPowerAt(amt, mid, stakedAt, PLATFORM_WEIGHT_START, PLATFORM_WEIGHT_END, TEST_PLATFORM_RAMP_SECONDS)
    );
  });

  it("poll vote after a weight change still uses the position snapshot (not the new curve)", async () => {
    const { owner, user, staking } = await deployTestStack();
    const amt = ethers.parseEther("1000");
    await staking.connect(user).stakePlatform(amt, meta("p"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));

    await staking.connect(owner).setPlatformWeights(1n * 10n ** 16n, 2n * 10n ** 16n, 10_000n);

    const pos = await staking.positions(1n);
    const now = BigInt(await time.latest());
    const snapVp = votingPowerAt(
      amt,
      now,
      pos.stakedAt,
      PLATFORM_WEIGHT_START,
      PLATFORM_WEIGHT_END,
      TEST_PLATFORM_RAMP_SECONDS
    );
    const liveIfNoSnapshot = votingPowerAt(amt, now, pos.stakedAt, 1n * 10n ** 16n, 2n * 10n ** 16n, 10_000n);
    expect(await staking.votingPower(1n)).to.equal(snapVp);
    expect(snapVp).to.be.gt(liveIfNoSnapshot);

    await expect(staking.connect(user).voteOnPoll(1n, 1n, 0, snapVp)).to.emit(staking, "PollVoteCast");
    expect(await staking.pollOptionVoteCount(1n, 0)).to.equal(snapVp);
  });

  it("NFT votingPower follows the snapshotted staking VP", async () => {
    const { owner, user, platformNFT, staking } = await deployTestStack();
    const amt = ethers.parseEther("100");
    await staking.connect(user).stakePlatform(amt, meta("p"));
    await staking.connect(owner).setPlatformWeights(1n, 2n, 100n);

    const pos = await staking.positions(1n);
    const expected = votingPowerAt(
      amt,
      BigInt(await time.latest()),
      pos.stakedAt,
      PLATFORM_WEIGHT_START,
      PLATFORM_WEIGHT_END,
      TEST_PLATFORM_RAMP_SECONDS
    );
    expect(await platformNFT.votingPower(1n)).to.equal(expected);
    expect(await platformNFT.votingPower(1n)).to.equal(await staking.votingPower(1n));
  });
});

describe("CLA-05 — vote lock and empty-poll result", () => {
  it("anyone can vote, including positions staked after the poll opened", async () => {
    const { owner, user, other, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, meta("c"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("late"));
    await staking.connect(other).stakeCase(1n, ethers.parseEther("100"), meta("late-case"));

    await expect(staking.connect(user).voteOnPoll(1n, 1n, 0, 1n)).to.emit(staking, "PollVoteCast");
    await expect(staking.connect(other).voteOnPollCase(1n, 2n, 1, 1n)).to.emit(staking, "PollVoteCast");
  });

  it("a position that voted stays locked until the poll ends, so its tokens cannot vote twice", async () => {
    const { owner, user, other, staking, lockSeconds } = await deployTestStack();
    const amt = ethers.parseEther("100");
    await staking.connect(user).stakePlatform(amt, meta("voter"));
    await staking.connect(other).stakePlatform(amt, meta("non-voter"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));
    await staking.connect(user).voteOnPoll(1n, 1n, 0, 1n);
    const { deadline } = await staking.pollState(1n);
    expect(await staking.voteLockedUntil(1n)).to.equal(deadline);
    expect(await staking.voteLockedUntil(2n)).to.equal(0n);

    // The normal lock is over but the poll is still open: the voter cannot take the tokens out
    // to vote again through a new position. A position that never voted is not affected.
    await time.increase(Number(lockSeconds) + 1);
    await expect(staking.connect(user).unstake(1n)).to.be.revertedWithCustomError(staking, "LockedByVote");
    await expect(staking.connect(other).unstake(2n)).to.emit(staking, "Unstaked");

    // Still locked just before the deadline; free once the deadline has passed.
    await time.increaseTo(deadline - 10n);
    await expect(staking.connect(user).unstake(1n)).to.be.revertedWithCustomError(staking, "LockedByVote");
    await time.increaseTo(deadline);
    await expect(staking.connect(user).unstake(1n)).to.emit(staking, "Unstaked");

    // The vote still counts once, and only once.
    expect((await staking.polls(1n)).totalVotes).to.equal(1n);
  });

  it("the lock runs until the last deadline among the polls voted on", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("p"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2)); // short
    await staking.connect(owner).createPoll(2n, 7200n, 2, pollMeta(2, 2)); // long
    await staking.connect(owner).createPoll(3n, 1800n, 2, pollMeta(3, 2)); // shortest
    const short = (await staking.pollState(1n)).deadline;
    const long = (await staking.pollState(2n)).deadline;

    await staking.connect(user).voteOnPoll(1n, 1n, 0, 1n);
    expect(await staking.voteLockedUntil(1n)).to.equal(short);
    await staking.connect(user).voteOnPoll(2n, 1n, 0, 1n); // a later deadline moves the lock out
    expect(await staking.voteLockedUntil(1n)).to.equal(long);
    await staking.connect(user).voteOnPoll(3n, 1n, 0, 1n); // an earlier deadline never shortens it
    expect(await staking.voteLockedUntil(1n)).to.equal(long);

    await time.increaseTo(short + 1n);
    await expect(staking.connect(user).unstake(1n)).to.be.revertedWithCustomError(staking, "LockedByVote");
    await time.increaseTo(long + 1n);
    await expect(staking.connect(user).unstake(1n)).to.emit(staking, "Unstaked");
  });

  it("voting keeps the stake in even with no lock duration, so borrowed tokens cannot vote and leave", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(owner).setLockDuration(0n);
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("borrowed"));
    await staking.connect(user).voteOnPoll(1n, 1n, 0, 1n);
    await expect(staking.connect(user).unstake(1n)).to.be.revertedWithCustomError(staking, "LockedByVote");
  });

  it("a poll cannot be extended once it has votes", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("p"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));
    const { deadline } = await staking.pollState(1n);

    // Before the first vote the deadline can still be extended.
    await expect(staking.connect(owner).extendPollDeadline(1n, deadline + 100n))
      .to.emit(staking, "PollDeadlineExtended")
      .withArgs(1n, deadline + 100n);

    await staking.connect(user).voteOnPoll(1n, 1n, 0, 1n);
    await expect(staking.connect(owner).extendPollDeadline(1n, deadline + 200n)).to.be.revertedWithCustomError(
      staking,
      "PollHasVotes"
    );
    // The unlock time the voter saw when voting is final.
    expect(await staking.voteLockedUntil(1n)).to.equal(deadline + 100n);
  });

  it("a poll with no votes finalizes with NO_WINNER, not option 0", async () => {
    const { owner, staking } = await deployTestStack();
    const NO_WINNER = await staking.NO_WINNER();
    expect(NO_WINNER).to.equal(255);

    await staking.connect(owner).createPoll(1n, 60n, 3, pollMeta(1, 3));
    expect((await staking.pollState(1n)).winningOption).to.equal(NO_WINNER); // not finalized yet

    await time.increase(61);
    await expect(staking.connect(owner).finalizePoll(1n)).to.emit(staking, "PollFinalized").withArgs(1n, NO_WINNER);
    const state = await staking.pollState(1n);
    expect(state.finalized).to.equal(true);
    expect(state.winningOption).to.equal(NO_WINNER);
    expect((await staking.polls(1n)).totalVotes).to.equal(0n);
  });

  it("totalVotes sums every vote, and option 0 never wins without votes", async () => {
    const { owner, user, other, staking } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("a"));
    await staking.connect(other).stakePlatform(ethers.parseEther("50"), meta("b"));
    await staking.connect(owner).createPoll(1n, 3600n, 3, pollMeta(1, 3));
    await staking.connect(user).voteOnPoll(1n, 1n, 1, 40n);
    await staking.connect(other).voteOnPoll(1n, 2n, 2, 40n); // tie between options 1 and 2
    expect((await staking.polls(1n)).totalVotes).to.equal(80n);

    await time.increase(3601);
    // Option 0 had no votes; the tie goes to the lowest index among the leaders.
    await expect(staking.connect(owner).finalizePoll(1n)).to.emit(staking, "PollFinalized").withArgs(1n, 1);
  });
});
