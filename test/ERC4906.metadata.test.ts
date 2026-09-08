import { expect } from "chai";
import { ethers } from "hardhat";
import { deployTestStack, meta } from "./helpers/deploy";

describe("Position NFTs — EIP-4906", () => {
  it("emits MetadataUpdate on platform mint", async () => {
    const { user, platformNFT, staking } = await deployTestStack();
    await expect(staking.connect(user).stakePlatform(ethers.parseEther("1"), meta("4906")))
      .to.emit(platformNFT, "MetadataUpdate")
      .withArgs(1n);
  });
});
