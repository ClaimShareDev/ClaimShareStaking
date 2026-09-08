import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  CASE_WEIGHT_START,
  PLATFORM_WEIGHT_END,
  PLATFORM_WEIGHT_START,
  TEST_LOCK_SECONDS,
  TEST_PLATFORM_RAMP_SECONDS,
  WAD,
  deployTestStack,
  meta,
  votingPowerAt,
} from "./helpers/deploy";

describe("ClaimShareStaking — voting power (linear ramp from stake)", () => {
  it("starts at 0.5× at stake; ramps to 1.5× over 150s (lock does not zero VP)", async () => {
    const { user, staking } = await deployTestStack();
    const amt = ethers.parseEther("1000");
    await staking.connect(user).stakePlatform(amt, meta("p"));
    const pos = await staking.positions(1n);
    const stakedAt = pos.stakedAt;

    expect(await staking.votingPower(1n)).to.equal((amt * PLATFORM_WEIGHT_START) / WAD);

    const duringLock = stakedAt + TEST_LOCK_SECONDS / 2n;
    await time.increaseTo(duringLock);
    expect(await staking.votingPower(1n)).to.be.gt(0n);

    const mid = stakedAt + TEST_PLATFORM_RAMP_SECONDS / 2n;
    await time.increaseTo(mid);
    const expected = votingPowerAt(
      amt,
      mid,
      stakedAt,
      PLATFORM_WEIGHT_START,
      PLATFORM_WEIGHT_END,
      TEST_PLATFORM_RAMP_SECONDS
    );
    expect(await staking.votingPowerOfPositionAt(1n, mid)).to.equal(expected);

    await time.increaseTo(stakedAt + TEST_PLATFORM_RAMP_SECONDS);
    expect(await staking.votingPower(1n)).to.equal((amt * PLATFORM_WEIGHT_END) / WAD);
  });

  it("case stake starts at 0.75× (not 0.75%) at stake", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, "c1");
    const amt = ethers.parseEther("1000");
    await staking.connect(user).stakeCase(1n, amt, meta("c"));
    expect(await staking.votingPower(1n)).to.equal((amt * CASE_WEIGHT_START) / WAD);
    expect(await staking.votingPower(1n)).to.equal(ethers.parseEther("750"));
  });

  it("platform and case NFTs mint with correct ids and votingPower", async () => {
    const { owner, user, platformNFT, caseNFT, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, "c1");
    await staking.connect(user).stakePlatform(ethers.parseEther("10"), meta("p"));
    await staking.connect(user).stakeCase(1n, ethers.parseEther("5"), meta("c"));

    expect(await platformNFT.ownerOf(1n)).to.equal(user.address);
    expect(await caseNFT.ownerOf(2n)).to.equal(user.address);
    expect(await staking.positionNft(1n)).to.equal(await platformNFT.getAddress());
    expect(await staking.positionNft(2n)).to.equal(await caseNFT.getAddress());

    const pos = await staking.positions(2n);
    expect(await caseNFT.votingPower(2n)).to.equal(await staking.votingPower(2n));
  });
});
