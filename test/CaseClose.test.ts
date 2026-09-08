import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployTestStack, meta } from "./helpers/deploy";

describe("closeCase — settled on-chain", () => {
  it("closeCase sets closed; blocks stake and payout preference", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(1n, "diesel");
    await staking.connect(user).setPayoutPreference(1n, 1, 0); // FullOnChain

    await expect(staking.connect(owner).closeCase(1n)).to.emit(staking, "CaseClosed");
    expect(await staking.isCaseClosed(1n)).to.equal(true);
    expect(await staking.isCaseActive(1n)).to.equal(false);

    await expect(staking.connect(user).stakeCase(1n, 1n, meta("x"))).to.be.revertedWithCustomError(
      staking,
      "CaseNotActive"
    );
    await expect(staking.connect(user).setPayoutPreference(1n, 2, 0)).to.be.revertedWithCustomError(
      staking,
      "CaseIsClosed"
    );
  });

  it("cannot close twice", async () => {
    const { owner, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(2n, "c");
    await staking.connect(owner).closeCase(2n);
    await expect(staking.connect(owner).closeCase(2n)).to.be.revertedWithCustomError(staking, "CaseAlreadyClosed");
  });
});
