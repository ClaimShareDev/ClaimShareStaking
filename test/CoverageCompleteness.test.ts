import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  deployTestStack,
  meta,
  pollMeta,
  PLATFORM_WEIGHT_START,
  PLATFORM_WEIGHT_END,
  CASE_WEIGHT_START,
  CASE_WEIGHT_END,
  TEST_PLATFORM_RAMP_SECONDS,
  TEST_CASE_RAMP_SECONDS,
  TEST_LOCK_SECONDS,
} from "./helpers/deploy";

// This suite exists to reach ~100% branch/line coverage on the three in-scope
// contracts: ClaimShareStaking, ClaimSharePositionNFT, ClaimSharePausable.

describe("Coverage — constructor validation", () => {
  async function factories() {
    const [owner] = await ethers.getSigners();
    const claim = await (await ethers.getContractFactory("MockERC20")).deploy("CLAIM", "CLAIM", 18);
    const plat = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
    const cs = await (await ethers.getContractFactory("CasePositionNFT")).deploy(owner.address);
    const Staking = await ethers.getContractFactory("ClaimShareStaking");
    const goodWeights = {
      weightStartWad: PLATFORM_WEIGHT_START,
      weightEndWad: PLATFORM_WEIGHT_END,
      durationSeconds: TEST_PLATFORM_RAMP_SECONDS,
    };
    const goodCase = {
      weightStartWad: CASE_WEIGHT_START,
      weightEndWad: CASE_WEIGHT_END,
      durationSeconds: TEST_CASE_RAMP_SECONDS,
    };
    return { owner, claim, plat, cs, Staking, goodWeights, goodCase };
  }

  it("reverts on zero admin", async () => {
    const { claim, plat, cs, Staking, goodWeights, goodCase } = await factories();
    await expect(
      Staking.deploy(
        await claim.getAddress(),
        await plat.getAddress(),
        await cs.getAddress(),
        ethers.ZeroAddress,
        TEST_LOCK_SECONDS,
        goodWeights,
        goodCase
      )
    ).to.be.revertedWithCustomError(Staking, "ZeroAddress");
  });

  it("reverts on zero stakeToken", async () => {
    const { owner, plat, cs, Staking, goodWeights, goodCase } = await factories();
    await expect(
      Staking.deploy(
        ethers.ZeroAddress,
        await plat.getAddress(),
        await cs.getAddress(),
        owner.address,
        TEST_LOCK_SECONDS,
        goodWeights,
        goodCase
      )
    ).to.be.revertedWithCustomError(Staking, "ZeroAddress");
  });

  it("reverts on zero platformNFT", async () => {
    const { owner, claim, cs, Staking, goodWeights, goodCase } = await factories();
    await expect(
      Staking.deploy(
        await claim.getAddress(),
        ethers.ZeroAddress,
        await cs.getAddress(),
        owner.address,
        TEST_LOCK_SECONDS,
        goodWeights,
        goodCase
      )
    ).to.be.revertedWithCustomError(Staking, "ZeroAddress");
  });

  it("reverts on zero caseNFT", async () => {
    const { owner, claim, plat, Staking, goodWeights, goodCase } = await factories();
    await expect(
      Staking.deploy(
        await claim.getAddress(),
        await plat.getAddress(),
        ethers.ZeroAddress,
        owner.address,
        TEST_LOCK_SECONDS,
        goodWeights,
        goodCase
      )
    ).to.be.revertedWithCustomError(Staking, "ZeroAddress");
  });

  it("reverts on invalid platform weights (end < start)", async () => {
    const { owner, claim, plat, cs, Staking, goodCase } = await factories();
    const bad = { weightStartWad: 10n ** 18n, weightEndWad: 1n, durationSeconds: 10n };
    await expect(
      Staking.deploy(
        await claim.getAddress(),
        await plat.getAddress(),
        await cs.getAddress(),
        owner.address,
        TEST_LOCK_SECONDS,
        bad,
        goodCase
      )
    ).to.be.revertedWithCustomError(Staking, "InvalidWeights");
  });

  it("reverts on invalid case weights (duration 0)", async () => {
    const { owner, claim, plat, cs, Staking, goodWeights } = await factories();
    const bad = { weightStartWad: 1n, weightEndWad: 2n, durationSeconds: 0n };
    await expect(
      Staking.deploy(
        await claim.getAddress(),
        await plat.getAddress(),
        await cs.getAddress(),
        owner.address,
        TEST_LOCK_SECONDS,
        goodWeights,
        bad
      )
    ).to.be.revertedWithCustomError(Staking, "InvalidDuration");
  });
});

describe("Coverage — staking admin config", () => {
  it("setLockDuration emits event and updates value", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).setLockDuration(999n))
      .to.emit(staking, "LockDurationUpdated")
      .withArgs(999n);
    expect(await staking.lockDuration()).to.equal(999n);
  });

  it("setPlatformWeights validates and updates", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).setPlatformWeights(2n, 1n, 100n)).to.be.revertedWithCustomError(
      staking,
      "InvalidWeights"
    );
    await expect(staking.connect(owner).setPlatformWeights(1n, 2n, 0n)).to.be.revertedWithCustomError(
      staking,
      "InvalidDuration"
    );
    await expect(staking.connect(owner).setPlatformWeights(1n, 2n, 100n))
      .to.emit(staking, "PlatformWeightsUpdated")
      .withArgs(1n, 2n, 100n);
  });

  it("setCaseWeights validates and updates", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).setCaseWeights(5n, 3n, 10n)).to.be.revertedWithCustomError(
      staking,
      "InvalidWeights"
    );
    await expect(staking.connect(owner).setCaseWeights(1n, 5n, 0n)).to.be.revertedWithCustomError(
      staking,
      "InvalidDuration"
    );
    await expect(staking.connect(owner).setCaseWeights(1n, 5n, 200n))
      .to.emit(staking, "CaseWeightsUpdated")
      .withArgs(1n, 5n, 200n);
  });
});

describe("Coverage — stake / unstake error paths", () => {
  it("stakePlatform reverts on zero amount and empty URI", async () => {
    const { user, staking } = await deployTestStack();
    await expect(staking.connect(user).stakePlatform(0n, meta("x"))).to.be.revertedWithCustomError(
      staking,
      "ZeroAmount"
    );
    await expect(staking.connect(user).stakePlatform(ethers.parseEther("1"), "")).to.be.revertedWithCustomError(
      staking,
      "EmptyURI"
    );
  });

  it("stakeCase reverts when case not registered/active/closed", async () => {
    const { owner, user, staking } = await deployTestStack();
    await expect(
      staking.connect(user).stakeCase(999n, ethers.parseEther("1"), meta("c"))
    ).to.be.revertedWithCustomError(staking, "CaseNotActive");

    await staking.connect(owner).registerCase(1n, meta("c1"));
    await staking.connect(owner).deactivateCase(1n);
    await expect(
      staking.connect(user).stakeCase(1n, ethers.parseEther("1"), meta("c"))
    ).to.be.revertedWithCustomError(staking, "CaseNotActive");

    await staking.connect(owner).registerCase(2n, meta("c2"));
    await staking.connect(owner).closeCase(2n);
    await expect(
      staking.connect(user).stakeCase(2n, ethers.parseEther("1"), meta("c"))
    ).to.be.revertedWithCustomError(staking, "CaseNotActive");
  });

  it("unstake reverts on not owner, closed, still locked", async () => {
    const { user, other, staking, lockSeconds } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("10"), meta("u"));

    await expect(staking.connect(other).unstake(1n)).to.be.revertedWithCustomError(staking, "NotOwner");
    await expect(staking.connect(user).unstake(1n)).to.be.revertedWithCustomError(staking, "StillLocked");

    await time.increase(Number(lockSeconds) + 1);
    await staking.connect(user).unstake(1n);
    await expect(staking.connect(user).unstake(1n)).to.be.revertedWithCustomError(staking, "PositionClosed");
  });

  it("registerCase reverts on duplicate and empty URI", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).registerCase(1n, "")).to.be.revertedWithCustomError(staking, "EmptyURI");
    await staking.connect(owner).registerCase(1n, meta("c"));
    await expect(staking.connect(owner).registerCase(1n, meta("c"))).to.be.revertedWithCustomError(
      staking,
      "CaseAlreadyRegistered"
    );
  });

  it("deactivateCase revert paths (unregistered / already inactive / closed)", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).deactivateCase(99n)).to.be.revertedWithCustomError(
      staking,
      "CaseNotRegistered"
    );
    await staking.connect(owner).registerCase(1n, meta("c"));
    await staking.connect(owner).deactivateCase(1n);
    await expect(staking.connect(owner).deactivateCase(1n)).to.be.revertedWithCustomError(staking, "CaseNotActive");

    await staking.connect(owner).registerCase(2n, meta("c2"));
    await staking.connect(owner).closeCase(2n);
    await expect(staking.connect(owner).deactivateCase(2n)).to.be.revertedWithCustomError(staking, "CaseIsClosed");
  });

  it("closeCase revert paths (unregistered)", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).closeCase(999n)).to.be.revertedWithCustomError(staking, "CaseNotRegistered");
  });

  it("isCaseActive / isCaseClosed / positionNft views", async () => {
    const { owner, user, staking, platformNFT, caseNFT } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, meta("c"));
    expect(await staking.isCaseActive(1n)).to.equal(true);
    expect(await staking.isCaseClosed(1n)).to.equal(false);

    await staking.connect(user).stakePlatform(ethers.parseEther("1"), meta("p"));
    await staking.connect(user).stakeCase(1n, ethers.parseEther("1"), meta("c"));

    expect(await staking.positionNft(1n)).to.equal(await platformNFT.getAddress());
    expect(await staking.positionNft(2n)).to.equal(await caseNFT.getAddress());

    await staking.connect(owner).closeCase(1n);
    expect(await staking.isCaseActive(1n)).to.equal(false);
    expect(await staking.isCaseClosed(1n)).to.equal(true);
  });
});

describe("Coverage — payout preferences", () => {
  it("rejects NotSet, unregistered case, closed case, invalid partial bps", async () => {
    const { owner, user, staking } = await deployTestStack();
    await expect(staking.connect(user).setPayoutPreference(999n, 1, 0)).to.be.revertedWithCustomError(
      staking,
      "CaseNotRegistered"
    );

    await staking.connect(owner).registerCase(1n, meta("c"));
    await expect(staking.connect(user).setPayoutPreference(1n, 0, 0)).to.be.revertedWithCustomError(
      staking,
      "InvalidPreference"
    );
    await expect(staking.connect(user).setPayoutPreference(1n, 3, 0)).to.be.revertedWithCustomError(
      staking,
      "InvalidBps"
    );
    await expect(staking.connect(user).setPayoutPreference(1n, 3, 10_000)).to.be.revertedWithCustomError(
      staking,
      "InvalidBps"
    );

    await expect(staking.connect(user).setPayoutPreference(1n, 3, 4000))
      .to.emit(staking, "PayoutPreferenceSet")
      .withArgs(1n, user.address, 3, 4000);
    expect(await staking.payoutPreference(1n, user.address)).to.equal(3);
    expect(await staking.payoutOnChainBps(1n, user.address)).to.equal(4000);

    await expect(staking.connect(user).setPayoutPreference(1n, 1, 8000))
      .to.emit(staking, "PayoutPreferenceSet")
      .withArgs(1n, user.address, 1, 10_000);
    expect(await staking.payoutPreference(1n, user.address)).to.equal(1);
    expect(await staking.payoutOnChainBps(1n, user.address)).to.equal(10_000);

    await expect(staking.connect(user).setPayoutPreference(1n, 2, 8000))
      .to.emit(staking, "PayoutPreferenceSet")
      .withArgs(1n, user.address, 2, 0);
    expect(await staking.payoutPreference(1n, user.address)).to.equal(2);
    expect(await staking.payoutOnChainBps(1n, user.address)).to.equal(0);

    await staking.connect(owner).closeCase(1n);
    await expect(staking.connect(user).setPayoutPreference(1n, 1, 0)).to.be.revertedWithCustomError(
      staking,
      "CaseIsClosed"
    );
  });
});

describe("Coverage — polls edge paths", () => {
  it("createPoll revert paths", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).createPoll(1n, 0n, 2, pollMeta(1, 2))).to.be.revertedWithCustomError(
      staking,
      "InvalidDuration"
    );
    await expect(staking.connect(owner).createPoll(1n, 100n, 17, pollMeta(1, 17))).to.be.revertedWithCustomError(
      staking,
      "InvalidOptionCount"
    );
    await staking.connect(owner).createPoll(1n, 100n, 2, pollMeta(1, 2));
    await expect(staking.connect(owner).createPoll(1n, 100n, 2, pollMeta(1, 2))).to.be.revertedWithCustomError(
      staking,
      "PollAlreadyExists"
    );
  });

  it("extendPollDeadline: not found / already finalized", async () => {
    const { owner, user, staking } = await deployTestStack();
    await expect(staking.connect(owner).extendPollDeadline(42n, 999999n)).to.be.revertedWithCustomError(
      staking,
      "PollNotFound"
    );

    await staking.connect(user).stakePlatform(ethers.parseEther("10"), meta("p"));
    await staking.connect(owner).createPoll(1n, 60n, 2, pollMeta(1, 2));
    await time.increase(61);
    await staking.connect(owner).finalizePoll(1n);
    const future = BigInt(await time.latest()) + 3600n;
    await expect(staking.connect(owner).extendPollDeadline(1n, future)).to.be.revertedWithCustomError(
      staking,
      "PollIsFinalized"
    );
  });

  it("finalizePoll: not found and already finalized", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).finalizePoll(9n)).to.be.revertedWithCustomError(staking, "PollNotFound");

    await staking.connect(owner).createPoll(1n, 10n, 2, pollMeta(1, 2));
    await time.increase(11);
    await staking.connect(owner).finalizePoll(1n);
    await expect(staking.connect(owner).finalizePoll(1n)).to.be.revertedWithCustomError(staking, "PollIsFinalized");
  });

  it("voteOnPoll: all revert paths", async () => {
    const { owner, user, other, staking, lockSeconds } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("p"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));

    // not found
    await expect(staking.connect(user).voteOnPoll(99n, 1n, 0, 1n)).to.be.revertedWithCustomError(
      staking,
      "PollNotFound"
    );

    // not owner
    await expect(staking.connect(other).voteOnPoll(1n, 1n, 0, 1n)).to.be.revertedWithCustomError(staking, "NotOwner");

    // invalid option index
    const vp = await staking.votingPower(1n);
    await expect(staking.connect(user).voteOnPoll(1n, 1n, 2, vp)).to.be.revertedWithCustomError(
      staking,
      "InvalidOptionIndex"
    );

    // zero weight
    await expect(staking.connect(user).voteOnPoll(1n, 1n, 0, 0n)).to.be.revertedWithCustomError(staking, "ZeroAmount");

    // exceeds voting power (use a huge value to defeat per-second ramp growth)
    await expect(staking.connect(user).voteOnPoll(1n, 1n, 0, ethers.MaxUint256)).to.be.revertedWithCustomError(
      staking,
      "ExceedsVotingPower"
    );

    await staking.connect(user).voteOnPoll(1n, 1n, 0, vp);

    // already voted
    await expect(staking.connect(user).voteOnPoll(1n, 1n, 1, 1n)).to.be.revertedWithCustomError(
      staking,
      "AlreadyVoted"
    );

    // expired
    await staking.connect(user).stakePlatform(ethers.parseEther("50"), meta("p2"));
    await time.increase(3601);
    await expect(staking.connect(user).voteOnPoll(1n, 2n, 0, 1n)).to.be.revertedWithCustomError(
      staking,
      "PollExpired"
    );

    // finalized
    await staking.connect(owner).finalizePoll(1n);
    await expect(staking.connect(user).voteOnPoll(1n, 2n, 0, 1n)).to.be.revertedWithCustomError(
      staking,
      "PollIsFinalized"
    );

    // closed position (unstaked)
    await staking.connect(owner).createPoll(2n, 3600n, 2, pollMeta(2, 2));
    await time.increase(Number(lockSeconds) + 1);
    await staking.connect(user).unstake(1n);
    await expect(staking.connect(user).voteOnPoll(2n, 1n, 0, 1n)).to.be.revertedWithCustomError(
      staking,
      "PositionClosed"
    );
  });

  it("voteOnPollCase: WrongPollScope and CaseNotRegistered branches", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("p"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));
    // platform position used on case function
    await expect(staking.connect(user).voteOnPollCase(1n, 1n, 0, 1n)).to.be.revertedWithCustomError(
      staking,
      "WrongPollScope"
    );
  });

  it("pollMetadataURI: reverts on unknown poll", async () => {
    const { staking } = await deployTestStack();
    await expect(staking.pollMetadataURI(123n)).to.be.revertedWithCustomError(staking, "PollNotFound");
  });

  it("pollOptionVoteCount returns zero for missing poll/option", async () => {
    const { staking } = await deployTestStack();
    expect(await staking.pollOptionVoteCount(1n, 0)).to.equal(0n);
  });

  it("extendPollDeadline happy path emits event", async () => {
    const { owner, staking } = await deployTestStack();
    await staking.connect(owner).createPoll(1n, 100n, 2, pollMeta(1, 2));
    const state = await staking.pollState(1n);
    const newDeadline = state.deadline + 500n;
    await expect(staking.connect(owner).extendPollDeadline(1n, newDeadline))
      .to.emit(staking, "PollDeadlineExtended")
      .withArgs(1n, newDeadline);
  });
});

describe("Coverage — voting power views", () => {
  it("returns 0 for closed / zero-amount positions and non-existent id", async () => {
    const { user, staking, lockSeconds } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("10"), meta("p"));

    expect(await staking.votingPower(1n)).to.be.gt(0n);
    expect(await staking.currentWeightWad(1n)).to.be.gt(0n);
    expect(await staking.votingPowerOfPositionAt(1n, await time.latest())).to.be.gt(0n);

    // non-existent id → amount=0 → returns 0
    expect(await staking.votingPower(999n)).to.equal(0n);
    expect(await staking.currentWeightWad(999n)).to.equal(0n);
    expect(await staking.votingPowerOfPositionAt(999n, await time.latest())).to.equal(0n);

    await time.increase(Number(lockSeconds) + 1);
    await staking.connect(user).unstake(1n);
    expect(await staking.votingPower(1n)).to.equal(0n);
    expect(await staking.currentWeightWad(1n)).to.equal(0n);
    expect(await staking.votingPowerOfPositionAt(1n, await time.latest())).to.equal(0n);
  });

  it("_weightWadAt: pre-stake timestamp yields 0, past-duration yields end weight", async () => {
    const { user, staking, platformRampSeconds } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("p"));
    const now = BigInt(await time.latest());

    // pre-stake
    const beforeStake = await staking.votingPowerOfPositionAt(1n, now - 100n);
    expect(beforeStake).to.equal(0n);

    // well past duration → weightEnd
    await time.increase(Number(platformRampSeconds) + 10);
    const wEnd = await staking.currentWeightWad(1n);
    expect(wEnd).to.equal(PLATFORM_WEIGHT_END);
  });
});

describe("Coverage — Position NFT (soulbound, wiring, interface, uri)", () => {
  it("wireStaking: rejects zero and re-wire", async () => {
    const [owner] = await ethers.getSigners();
    const plat = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
    await expect(plat.wireStaking(ethers.ZeroAddress)).to.be.revertedWithCustomError(plat, "ZeroAddress");

    // wire once, then re-wire fails
    const { staking } = await deployTestStack();
    const cs = await (await ethers.getContractFactory("CasePositionNFT")).deploy(owner.address);
    await cs.wireStaking(await staking.getAddress());
    await expect(cs.wireStaking(await staking.getAddress())).to.be.revertedWithCustomError(cs, "StakingAlreadyWired");
  });

  it("mint: rejects non-minter and duplicate tokenId; setTokenURI works", async () => {
    const [owner, user] = await ethers.getSigners();
    const plat = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
    // owner has MINTER_ROLE by constructor
    await plat.connect(owner).mint(user.address, 1n, "ipfs://a");
    await expect(plat.connect(user).mint(user.address, 2n, "ipfs://x")).to.be.reverted;
    await expect(plat.connect(owner).mint(user.address, 1n, "ipfs://b")).to.be.revertedWithCustomError(
      plat,
      "TokenExists"
    );

    await expect(plat.connect(owner).setTokenURI(1n, "ipfs://updated"))
      .to.emit(plat, "MetadataUpdate")
      .withArgs(1n);
    expect(await plat.tokenURI(1n)).to.equal("ipfs://updated");
  });

  it("tokenURI reverts for non-existent token", async () => {
    const [owner] = await ethers.getSigners();
    const plat = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
    await expect(plat.tokenURI(999n)).to.be.reverted;
  });

  it("votingPower: returns 0 when staking unwired, real value when wired", async () => {
    const [owner] = await ethers.getSigners();
    const solo = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
    await solo.connect(owner).mint(owner.address, 1n, "ipfs://a");
    expect(await solo.votingPower(1n)).to.equal(0n);

    const { user, staking, platformNFT } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("10"), meta("p"));
    expect(await platformNFT.votingPower(1n)).to.equal(await staking.votingPower(1n));
  });

  it("supportsInterface returns true for ERC4906 and inherited AC/ERC721", async () => {
    const { platformNFT } = await deployTestStack();
    // ERC4906
    expect(await platformNFT.supportsInterface("0x49064906")).to.equal(true);
    // ERC721
    expect(await platformNFT.supportsInterface("0x80ac58cd")).to.equal(true);
    // AccessControl
    expect(await platformNFT.supportsInterface("0x7965db0b")).to.equal(true);
    // random
    expect(await platformNFT.supportsInterface("0xffffffff")).to.equal(false);
  });

  it("soulbound: transfer blocked, but staking mint (from=0) allowed", async () => {
    const { user, other, staking, platformNFT } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("10"), meta("p"));
    await expect(
      platformNFT.connect(user).transferFrom(user.address, other.address, 1n)
    ).to.be.revertedWithCustomError(platformNFT, "TransfersDisabled");
  });

  it("StakingWired event emitted", async () => {
    const [owner] = await ethers.getSigners();
    const fresh = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
    const { staking } = await deployTestStack();
    const stakingAddr = await staking.getAddress();
    await expect(fresh.connect(owner).wireStaking(stakingAddr))
      .to.emit(fresh, "StakingWired")
      .withArgs(stakingAddr);
  });
});

describe("Coverage — Pausable base", () => {
  it("non-admin cannot emergencyWithdraw and non-pauser cannot pause", async () => {
    const { user, staking } = await deployTestStack();
    await expect(staking.connect(user).emergencyWithdraw(ethers.ZeroAddress)).to.be.reverted;
    await expect(staking.connect(user).pause()).to.be.reverted;
  });
});

describe("Coverage — every privileged function rejects unauthorized callers", () => {
  it("staking contract: each admin function checks its exact role", async () => {
    const { owner, user, staking, usdt } = await deployTestStack();
    const ADMIN = await staking.DEFAULT_ADMIN_ROLE();
    const PAUSER = await staking.PAUSER_ROLE();
    const CASE_MANAGER = await staking.CASE_MANAGER_ROLE();
    const GOVERNANCE_ADMIN = await staking.GOVERNANCE_ADMIN_ROLE();
    await staking.connect(owner).registerCase(1n, meta("c"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));
    const u = staking.connect(user);
    const usdtAddr = await usdt.getAddress();

    // Each call is started only when checked, so no rejection is left unhandled.
    const cases: [() => Promise<unknown>, string][] = [
      [() => u.registerCase(2n, meta("x")), CASE_MANAGER],
      [() => u.deactivateCase(1n), CASE_MANAGER],
      [() => u.closeCase(1n), CASE_MANAGER],
      [() => u.createPoll(2n, 3600n, 2, pollMeta(2, 2)), GOVERNANCE_ADMIN],
      [() => u.extendPollDeadline(1n, 10n ** 12n), GOVERNANCE_ADMIN],
      [() => u.finalizePoll(1n), GOVERNANCE_ADMIN],
      [() => u.setLockDuration(1n), ADMIN],
      [() => u.setPlatformWeights(1n, 2n, 3n), ADMIN],
      [() => u.setCaseWeights(1n, 2n, 3n), ADMIN],
      [() => u.emergencyWithdraw(usdtAddr), ADMIN],
      [() => u.pause(), PAUSER],
      [() => u.unpause(), PAUSER],
    ];
    for (const [call, role] of cases) {
      await expect(call()).to.be.revertedWithCustomError(staking, "AccessControlUnauthorizedAccount").withArgs(user.address, role);
    }
  });

  it("position NFTs: wiring, minting and metadata check their roles", async () => {
    const [owner, user] = await ethers.getSigners();
    const nft = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
    const ADMIN = await nft.DEFAULT_ADMIN_ROLE();
    const MINTER = await nft.MINTER_ROLE();
    await nft.connect(owner).mint(owner.address, 1n, "ipfs://a");
    const u = nft.connect(user);

    await expect(u.wireStaking(user.address))
      .to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount")
      .withArgs(user.address, ADMIN);
    await expect(u.mint(user.address, 2n, "ipfs://b"))
      .to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount")
      .withArgs(user.address, MINTER);
    await expect(u.setTokenURI(1n, "ipfs://c"))
      .to.be.revertedWithCustomError(nft, "AccessControlUnauthorizedAccount")
      .withArgs(user.address, MINTER);
  });

  it("case-position votes are blocked while paused", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, meta("c"));
    await staking.connect(user).stakeCase(1n, ethers.parseEther("10"), meta("p"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));
    await staking.connect(owner).pause();
    await expect(staking.connect(user).voteOnPollCase(1n, 1n, 0, 1n)).to.be.revertedWithCustomError(
      staking,
      "EnforcedPause"
    );
  });
});

describe("Coverage — reentrancy guard", () => {
  // A contract staker gets a callback when its position NFT is minted. Any attempt to call back
  // into stake, stakeCase or unstake during that callback must revert.
  async function deployAttacker() {
    const ctx = await deployTestStack();
    const { owner, claim, staking } = ctx;
    await staking.connect(owner).registerCase(1n, meta("c"));
    const attacker = await (await ethers.getContractFactory("ReentrantStaker")).deploy(
      await staking.getAddress(),
      await claim.getAddress()
    );
    await claim.mint(await attacker.getAddress(), ethers.parseEther("1000"));
    return { ...ctx, attacker };
  }

  it("a contract staker without re-entry stakes normally", async () => {
    const { attacker, staking } = await deployAttacker();
    await attacker.stake(ethers.parseEther("10"));
    expect((await staking.positions(1n)).owner).to.equal(await attacker.getAddress());
  });

  for (const [mode, label] of [
    [1, "stakePlatform"],
    [2, "stakeCase"],
    [3, "unstake"],
  ] as const) {
    it(`re-entering ${label} from the NFT callback reverts`, async () => {
      const { attacker, staking } = await deployAttacker();
      await attacker.setMode(mode);
      await expect(attacker.stake(ethers.parseEther("10"))).to.be.revertedWithCustomError(
        staking,
        "ReentrancyGuardReentrantCall"
      );
    });
  }
});
