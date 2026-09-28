import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
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
    const [owner, user] = await ethers.getSigners();
    const claim = await (await ethers.getContractFactory("FeeOnTransferMock")).deploy(feeBps);
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
    await claim.mint(user.address, ethers.parseEther("10000"));
    await claim.connect(user).approve(stakingAddr, ethers.MaxUint256);
    return { owner, user, claim, staking, stakingAddr };
  }

  it("standard token still credits the full requested amount", async () => {
    const { user, staking, claim } = await deployTestStack();
    const amt = ethers.parseEther("1000");
    const before = await claim.balanceOf(await staking.getAddress());
    await expect(staking.connect(user).stakePlatform(amt, meta("full")))
      .to.emit(staking, "StakedPlatform")
      .withArgs(user.address, 1n, amt);
    expect((await staking.positions(1n)).amount).to.equal(amt);
    expect(await claim.balanceOf(await staking.getAddress())).to.equal(before + amt);
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

    await time.increase(61);
    const userBefore = await claim.balanceOf(user.address);
    await staking.connect(user).unstake(1n);
    // Outbound transfer can also take a fee. The contract sends the credited amount.
    const outboundFee = (received * 1000n) / 10_000n;
    expect(await claim.balanceOf(user.address) - userBefore).to.equal(received - outboundFee);
    expect(await claim.balanceOf(stakingAddr)).to.equal(received);
  });

  it("reverts when a fee takes the entire transfer", async () => {
    const { user, staking } = await deployWithFeeToken(10_000n);
    await expect(staking.connect(user).stakePlatform(ethers.parseEther("1"), meta("all-fee"))).to.be.revertedWithCustomError(
      staking,
      "ZeroAmount"
    );
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
