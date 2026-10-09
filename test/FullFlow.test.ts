import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployTestStack, meta, pollMeta } from "./helpers/deploy";

describe("Full flow — case → stake → vote → close → unstake", () => {
  it("end-to-end on Hardhat", async () => {
    const { owner, user, platformNFT, staking } = await deployTestStack();
    const caseId = 42n;

    await staking.connect(owner).registerCase(caseId, "ipfs://case/42");
    await staking.connect(user).stakePlatform(ethers.parseEther("1000"), meta("plat"));
    await staking.connect(user).setPayoutPreference(caseId, 1, 0);

    const platPos = await staking.positions(1n);
    await staking.connect(owner).createPoll(1n, 7n * 86400n, 2, pollMeta(1, 2));
    const vp = await staking.votingPower(1n);
    await staking.connect(user).voteOnPoll(1n, 1n, 0, vp / 2n);

    await staking.connect(owner).closeCase(caseId);
    expect(await staking.isCaseClosed(caseId)).to.equal(true);

    // The normal lock is over, but the vote keeps the stake locked until the poll ends.
    await time.increaseTo(platPos.lockEnd + 1n);
    await expect(staking.connect(user).unstake(1n)).to.be.revertedWithCustomError(staking, "LockedByVote");

    const { deadline } = await staking.pollState(1n);
    await time.increaseTo(deadline + 1n);
    await staking.connect(owner).finalizePoll(1n);
    await staking.connect(user).unstake(1n);
    expect(await platformNFT.ownerOf(1n)).to.equal(user.address);
    expect(await staking.votingPower(1n)).to.equal(0n);
  });
});
