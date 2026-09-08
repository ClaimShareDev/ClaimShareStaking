import { expect } from "chai";
import { ethers } from "hardhat";
import { deployTestStack, meta } from "./helpers/deploy";

describe("Case registration — CASE_MANAGER_ROLE", () => {
  it("admin registers case; closeCase marks settled", async () => {
    const { owner, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(100n, "ipfs://case");
    expect(await staking.isCaseClosed(100n)).to.equal(false);
    await staking.connect(owner).closeCase(100n);
    expect(await staking.isCaseClosed(100n)).to.equal(true);
  });

  it("non-manager cannot registerCase", async () => {
    const { user, staking } = await deployTestStack();
    await expect(staking.connect(user).registerCase(1n, "x")).to.be.reverted;
  });

  it("deactivateCase blocks new stakes until closed", async () => {
    const { owner, user, staking } = await deployTestStack();
    await staking.connect(owner).registerCase(5n, "c5");
    await staking.connect(owner).deactivateCase(5n);
    await expect(staking.connect(user).stakeCase(5n, 1n, meta("new"))).to.be.revertedWithCustomError(
      staking,
      "CaseNotActive"
    );
  });
});
