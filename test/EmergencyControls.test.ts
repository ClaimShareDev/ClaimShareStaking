import { expect } from "chai";
import { ethers } from "hardhat";
import { deployTestStack, meta, pollMeta } from "./helpers/deploy";

describe("Pause and emergency withdraw", function () {
  it("PAUSER_ROLE can pause and unpause; non-pauser cannot", async function () {
    const { staking, owner, user } = await deployTestStack();
    const pauser = await staking.PAUSER_ROLE();

    await expect(staking.connect(user).pause()).to.be.reverted;
    await staking.connect(owner).pause();
    expect(await staking.paused()).to.equal(true);

    await expect(staking.connect(user).unpause()).to.be.reverted;
    await staking.connect(owner).unpause();
    expect(await staking.paused()).to.equal(false);

    expect(await staking.hasRole(pauser, owner.address)).to.equal(true);
  });

  it("blocks stake, unstake, vote, and payout preference while paused", async function () {
    const { staking, owner, user, lockSeconds } = await deployTestStack();
    const caseId = 1n;
    await staking.connect(owner).registerCase(caseId, meta("case-pause"));
    await staking.connect(owner).createPoll(1n, 3600n, 2, pollMeta(1, 2));

    const amount = ethers.parseEther("1000");
    await staking.connect(user).stakePlatform(amount, meta("pre-pause"));
    const positionId = 1n;

    await staking.connect(owner).pause();

    await expect(staking.connect(user).stakePlatform(amount, meta("paused-stake"))).to.be.revertedWithCustomError(
      staking,
      "EnforcedPause"
    );
    await expect(staking.connect(user).stakeCase(caseId, amount, meta("paused-case"))).to.be.revertedWithCustomError(
      staking,
      "EnforcedPause"
    );
    await expect(staking.connect(user).setPayoutPreference(caseId, 1, 0)).to.be.revertedWithCustomError(
      staking,
      "EnforcedPause"
    );
    await expect(
      staking.connect(user).voteOnPoll(1n, positionId, 0, ethers.parseEther("500"))
    ).to.be.revertedWithCustomError(staking, "EnforcedPause");

    await ethers.provider.send("evm_increaseTime", [Number(lockSeconds) + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(staking.connect(user).unstake(positionId)).to.be.revertedWithCustomError(staking, "EnforcedPause");

    await staking.connect(owner).unpause();
    await expect(staking.connect(user).stakePlatform(amount, meta("after-unpause"))).to.not.be.reverted;
  });

  it("admin ops still work while paused", async function () {
    const { staking, owner } = await deployTestStack();
    await staking.connect(owner).pause();

    await expect(staking.connect(owner).registerCase(99n, meta("paused-register"))).to.not.be.reverted;
    await expect(staking.connect(owner).createPoll(50n, 600n, 2, pollMeta(50, 2))).to.not.be.reverted;
    await expect(staking.connect(owner).setLockDuration(120n)).to.not.be.reverted;
  });

  it("emergencyWithdraw rescues accidentally sent tokens (not stakeToken)", async function () {
    const { staking, owner, usdt } = await deployTestStack();
    const stray = ethers.parseUnits("500", 6);
    await usdt.mint(await staking.getAddress(), stray);

    const adminBefore = await usdt.balanceOf(owner.address);
    await expect(staking.connect(owner).emergencyWithdraw(await usdt.getAddress()))
      .to.emit(staking, "EmergencyWithdraw")
      .withArgs(owner.address, await usdt.getAddress(), stray);

    expect(await usdt.balanceOf(await staking.getAddress())).to.equal(0n);
    expect(await usdt.balanceOf(owner.address)).to.equal(adminBefore + stray);
  });

  it("emergencyWithdraw works while paused; only DEFAULT_ADMIN may call", async function () {
    const { staking, owner, user, usdt } = await deployTestStack();
    const stray = ethers.parseUnits("100", 6);
    await usdt.mint(await staking.getAddress(), stray);

    await staking.connect(owner).pause();

    await expect(staking.connect(user).emergencyWithdraw(await usdt.getAddress())).to.be.reverted;

    await staking.connect(owner).emergencyWithdraw(await usdt.getAddress());
    expect(await usdt.balanceOf(owner.address)).to.be.gte(stray);
  });

  it("emergencyWithdraw reverts on zero token, empty balance, or stakeToken", async function () {
    const { staking, owner, claim, usdt } = await deployTestStack();

    await expect(staking.connect(owner).emergencyWithdraw(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      staking,
      "EmergencyWithdrawZeroToken"
    );

    await expect(staking.connect(owner).emergencyWithdraw(await claim.getAddress())).to.be.revertedWithCustomError(
      staking,
      "CannotWithdrawStakeToken"
    );

    await expect(staking.connect(owner).emergencyWithdraw(await usdt.getAddress())).to.be.revertedWithCustomError(
      staking,
      "EmergencyWithdrawZeroBalance"
    );
  });
});
