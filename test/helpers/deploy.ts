import { ethers } from "hardhat";

export const WAD = 10n ** 18n;

/** Test: 60s lock, 150s platform ramp, 120s case ramp. */
export const TEST_LOCK_SECONDS = 60n;
export const TEST_PLATFORM_RAMP_SECONDS = 150n;
export const TEST_CASE_RAMP_SECONDS = 120n;

export const PROD_LOCK_SECONDS = 7n * 86400n;
export const PROD_PLATFORM_WEIGHT_SECONDS = 25n * 30n * 86400n;
export const PROD_CASE_WEIGHT_SECONDS = 15n * 30n * 86400n;

export const PLATFORM_WEIGHT_START = 5n * 10n ** 17n;
export const PLATFORM_WEIGHT_END = 15n * 10n ** 17n;
export const CASE_WEIGHT_START = 75n * 10n ** 16n; // 0.75e18 = 0.75×
export const CASE_WEIGHT_END = 225n * 10n ** 16n;

export function meta(seed: string) {
  return `ipfs://QmTest/${seed}.json`;
}

export function pollMeta(pollId: bigint | number, optionCount: number) {
  return `ipfs://QmPollTest/${pollId}-${optionCount}.json`;
}

export function weightWadAt(
  timestamp: bigint,
  stakedAt: bigint,
  weightStart: bigint,
  weightEnd: bigint,
  durationSeconds: bigint
): bigint {
  if (timestamp < stakedAt) return 0n;
  const elapsed = timestamp - stakedAt;
  if (durationSeconds === 0n) return weightEnd;
  if (elapsed >= durationSeconds) return weightEnd;
  return weightStart + ((weightEnd - weightStart) * elapsed) / durationSeconds;
}

export function votingPowerAt(
  amount: bigint,
  timestamp: bigint,
  stakedAt: bigint,
  weightStart: bigint,
  weightEnd: bigint,
  durationSeconds: bigint
): bigint {
  return (amount * weightWadAt(timestamp, stakedAt, weightStart, weightEnd, durationSeconds)) / WAD;
}

export async function deployTestStack(opts?: {
  lockSeconds?: bigint;
  platformRampSeconds?: bigint;
  caseRampSeconds?: bigint;
}) {
  const lockSeconds = opts?.lockSeconds ?? TEST_LOCK_SECONDS;
  const platformRampSeconds = opts?.platformRampSeconds ?? TEST_PLATFORM_RAMP_SECONDS;
  const caseRampSeconds = opts?.caseRampSeconds ?? TEST_CASE_RAMP_SECONDS;

  const [owner, user, other, manager] = await ethers.getSigners();

  const claim = await (await ethers.getContractFactory("MockERC20")).deploy("CLAIM", "CLAIM", 18);
  const usdt = await (await ethers.getContractFactory("MockERC20")).deploy("Tether USD", "USDT", 6);

  const platformNFT = await (await ethers.getContractFactory("PlatformPositionNFT")).deploy(owner.address);
  const caseNFT = await (await ethers.getContractFactory("CasePositionNFT")).deploy(owner.address);

  const platformWeights = {
    weightStartWad: PLATFORM_WEIGHT_START,
    weightEndWad: PLATFORM_WEIGHT_END,
    durationSeconds: platformRampSeconds,
  };
  const caseWeights = {
    weightStartWad: CASE_WEIGHT_START,
    weightEndWad: CASE_WEIGHT_END,
    durationSeconds: caseRampSeconds,
  };

  const staking = await (
    await ethers.getContractFactory("ClaimShareStaking")
  ).deploy(
    await claim.getAddress(),
    await platformNFT.getAddress(),
    await caseNFT.getAddress(),
    owner.address,
    lockSeconds,
    platformWeights,
    caseWeights
  );

  const stakingAddr = await staking.getAddress();
  const MINTER = await platformNFT.MINTER_ROLE();
  await platformNFT.connect(owner).wireStaking(stakingAddr);
  await caseNFT.connect(owner).wireStaking(stakingAddr);
  await platformNFT.connect(owner).grantRole(MINTER, stakingAddr);
  await caseNFT.connect(owner).grantRole(MINTER, stakingAddr);

  await claim.mint(user.address, ethers.parseEther("1000000"));
  await claim.mint(other.address, ethers.parseEther("1000000"));
  await claim.connect(user).approve(stakingAddr, ethers.MaxUint256);
  await claim.connect(other).approve(stakingAddr, ethers.MaxUint256);

  return {
    owner,
    user,
    other,
    manager,
    claim,
    usdt,
    platformNFT,
    caseNFT,
    staking,
    lockSeconds,
    platformRampSeconds,
    caseRampSeconds,
  };
}
