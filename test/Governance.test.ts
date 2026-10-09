import { expect } from "chai";
import { ethers } from "hardhat";
  import { time } from "@nomicfoundation/hardhat-network-helpers";
  import { deployTestStack, meta, pollMeta } from "./helpers/deploy";

  describe("On-chain polls (multi-option)", () => {
    it("platform position votes via voteOnPoll; case via voteOnPollCase", async () => {
      const { owner, user, staking } = await deployTestStack();
      await staking.connect(owner).registerCase(1n, "c");
      await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("plat"));
      await staking.connect(user).stakeCase(1n, ethers.parseEther("50"), meta("case"));

      await staking.connect(owner).createPoll(1n, 3600n, 3, pollMeta(1, 3));
      const platPower = await staking.votingPower(1n);
      const casePower = await staking.votingPower(2n);

      await expect(staking.connect(user).voteOnPoll(1n, 1n, 1, platPower))
        .to.emit(staking, "PollVoteCast")
        .withArgs(1n, user.address, 1n, 1, platPower);

      await expect(staking.connect(user).voteOnPollCase(1n, 2n, 0, casePower))
        .to.emit(staking, "PollVoteCast")
        .withArgs(1n, user.address, 2n, 0, casePower);

      expect(await staking.pollOptionVoteCount(1n, 1)).to.equal(platPower);
      expect(await staking.pollOptionVoteCount(1n, 0)).to.equal(casePower);

      await expect(staking.connect(user).voteOnPoll(1n, 2n, 0, 1n)).to.be.revertedWithCustomError(
        staking,
        "WrongPollScope"
      );
      await expect(staking.connect(user).voteOnPollCase(1n, 1n, 0, 1n)).to.be.revertedWithCustomError(
        staking,
        "WrongPollScope"
      );
    });

    it("user can vote twice on same poll with two platform positions", async () => {
      const { owner, user, staking } = await deployTestStack();
      await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("p1"));
      await staking.connect(user).stakePlatform(ethers.parseEther("200"), meta("p2"));
      await staking.connect(owner).createPoll(5n, 3600n, 2, pollMeta(5, 2));

      const vp1 = await staking.votingPower(1n);
      const vp2 = await staking.votingPower(2n);
      await staking.connect(user).voteOnPoll(5n, 1n, 0, vp1);
      await staking.connect(user).voteOnPoll(5n, 2n, 1, vp2);

      expect(await staking.pollOptionVoteCount(5n, 0)).to.equal(vp1);
      expect(await staking.pollOptionVoteCount(5n, 1)).to.equal(vp2);
      expect(await staking.hasVotedOnPoll(5n, 1n)).to.equal(true);
      expect(await staking.hasVotedOnPoll(5n, 2n)).to.equal(true);
    });

    it("case close does not block platform or case poll votes", async () => {
      const { owner, user, staking } = await deployTestStack();
      await staking.connect(owner).registerCase(5n, "c5");
      await staking.connect(user).stakePlatform(ethers.parseEther("100"), meta("plat"));
      await staking.connect(user).stakeCase(5n, ethers.parseEther("80"), meta("case"));
      await staking.connect(owner).createPoll(10n, 3600n, 2, pollMeta(10, 2));
      await staking.connect(owner).closeCase(5n);

      const platPower = await staking.votingPower(1n);
      const casePower = await staking.votingPower(2n);
      await expect(staking.connect(user).voteOnPoll(10n, 1n, 0, platPower)).to.emit(staking, "PollVoteCast");
      await expect(staking.connect(user).voteOnPollCase(10n, 2n, 1, casePower)).to.emit(staking, "PollVoteCast");
    });

    it("extendPollDeadline sets new absolute timestamp and allows late votes", async () => {
      const { owner, user, staking } = await deployTestStack();
      await staking.connect(user).stakePlatform(ethers.parseEther("50"), meta("p"));
      await staking.connect(owner).createPoll(7n, 100n, 2, pollMeta(7, 2));

      await time.increase(101);
      await expect(staking.connect(user).voteOnPoll(7n, 1n, 0, 1n)).to.be.revertedWithCustomError(
        staking,
        "PollExpired"
      );

      const newDeadline = BigInt(await time.latest()) + 3600n;
      await expect(staking.connect(owner).extendPollDeadline(7n, newDeadline))
        .to.emit(staking, "PollDeadlineExtended")
        .withArgs(7n, newDeadline);

      const stateAfter = await staking.pollState(7n);
      expect(stateAfter.deadline).to.equal(newDeadline);

      const w = await staking.votingPower(1n);
      await expect(staking.connect(user).voteOnPoll(7n, 1n, 0, w)).to.emit(staking, "PollVoteCast");
    });

    it("extendPollDeadline rejects shortening the deadline", async () => {
      const { owner, staking } = await deployTestStack();
      await staking.connect(owner).createPoll(11n, 3600n, 2, pollMeta(11, 2));
      const before = await staking.pollState(11n);

      await time.increase(60);
      const shorter = BigInt(await time.latest()) + 120n;
      expect(shorter).to.be.lt(before.deadline);

      // Shortening is now disallowed — deadline must only move forward
      await expect(staking.connect(owner).extendPollDeadline(11n, shorter)).to.be.revertedWithCustomError(
        staking,
        "DeadlineNotExtended"
      );
    });

    it("extendPollDeadline rejects deadline at or before current deadline", async () => {
      const { owner, staking } = await deployTestStack();
      await staking.connect(owner).createPoll(8n, 3600n, 2, pollMeta(8, 2));
      const state = await staking.pollState(8n);
      await expect(staking.connect(owner).extendPollDeadline(8n, state.deadline)).to.be.revertedWithCustomError(
        staking,
        "DeadlineNotExtended"
      );
      await expect(staking.connect(owner).extendPollDeadline(8n, state.deadline - 1n)).to.be.revertedWithCustomError(
        staking,
        "DeadlineNotExtended"
      );
    });

    it("extendPollDeadline on an expired poll must set a deadline in the future", async () => {
      const { owner, staking } = await deployTestStack();
      await staking.connect(owner).createPoll(9n, 100n, 2, pollMeta(9, 2));
      const { deadline } = await staking.pollState(9n);
      await time.increase(200);

      // Later than the old deadline, but still in the past: rejected.
      await expect(staking.connect(owner).extendPollDeadline(9n, deadline + 50n)).to.be.revertedWithCustomError(
        staking,
        "InvalidDeadline"
      );
      // In the future: accepted, and the poll reopens.
      const future = BigInt(await time.latest()) + 3600n;
      await expect(staking.connect(owner).extendPollDeadline(9n, future))
        .to.emit(staking, "PollDeadlineExtended")
        .withArgs(9n, future);
    });

    it("finalize poll picks option with most votes (after deadline)", async () => {
      const { owner, user, other, staking } = await deployTestStack();
      await staking.connect(user).stakePlatform(ethers.parseEther("200"), meta("p"));
      await staking.connect(other).stakePlatform(ethers.parseEther("100"), meta("p2"));
      await staking.connect(owner).createPoll(99n, 86400n, 3, pollMeta(99, 3));

      const p1 = await staking.votingPower(1n);
      const p2 = await staking.votingPower(2n);
      await staking.connect(user).voteOnPoll(99n, 1n, 2, p1);
      await staking.connect(other).voteOnPoll(99n, 2n, 1, p2);

      // Finalization requires the poll deadline to have passed
      await expect(staking.connect(owner).finalizePoll(99n)).to.be.revertedWithCustomError(
        staking,
        "PollNotExpired"
      );

      await time.increase(86401);

      await expect(staking.connect(owner).finalizePoll(99n))
        .to.emit(staking, "PollFinalized")
        .withArgs(99n, 2);

      const state = await staking.pollState(99n);
      expect(state.winningOption).to.equal(2);
    });

    it("rejects invalid option index and double vote on same position", async () => {
      const { owner, user, staking } = await deployTestStack();
    await staking.connect(user).stakePlatform(ethers.parseEther("50"), meta("p"));
    await staking.connect(owner).createPoll(3n, 3600n, 2, pollMeta(3, 2));
    const w = await staking.votingPower(1n);

    await expect(staking.connect(user).voteOnPoll(3n, 1n, 2, w)).to.be.revertedWithCustomError(
      staking,
      "InvalidOptionIndex"
    );

    await staking.connect(user).voteOnPoll(3n, 1n, 0, w);
    await expect(staking.connect(user).voteOnPoll(3n, 1n, 1, 1n)).to.be.revertedWithCustomError(
      staking,
      "AlreadyVoted"
    );
  });

  it("requires at least 2 options", async () => {
    const { owner, staking } = await deployTestStack();
    await expect(staking.connect(owner).createPoll(1n, 3600n, 1, pollMeta(1, 1))).to.be.revertedWithCustomError(
      staking,
      "InvalidOptionCount"
    );
  });

  it("stores metadataURI and rejects empty URI", async () => {
    const { owner, staking } = await deployTestStack();
    const uri = pollMeta(42, 2);

    await expect(staking.connect(owner).createPoll(42n, 3600n, 2, uri)).to.emit(staking, "PollCreated");

    expect(await staking.pollMetadataURI(42n)).to.equal(uri);
    const state = await staking.pollState(42n);
    expect(state.metadataURI).to.equal(uri);

    await expect(staking.connect(owner).createPoll(43n, 3600n, 2, "")).to.be.revertedWithCustomError(
      staking,
      "EmptyURI"
    );
  });
});
