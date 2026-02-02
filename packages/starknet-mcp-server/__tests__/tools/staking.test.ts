import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TOKENS,
  MOCK_POOL_ADDRESS,
  mockStakingInfo,
  mockUserStakingInfo,
  mockUserStakingInfoUnbonding,
  mockUserStakingInfoUnbondingReady,
  mockUserStakingInfoNoRewards,
  mockAvnuCalls,
  mockStakingTxResult,
  createMockAvnuStaking,
  createMockAvnuStakingWithUnbonding,
  createMockAvnuStakingUnbondingReady,
  createMockAvnuStakingNoRewards,
} from "../providers/avnu.mock";

// Mock the @avnu/avnu-sdk module
vi.mock("@avnu/avnu-sdk", () => ({
  getQuotes: vi.fn(),
  executeSwap: vi.fn(),
  getAvnuStakingInfo: vi.fn(),
  getUserStakingInfo: vi.fn(),
  stakeToCalls: vi.fn(),
  initiateUnstakeToCalls: vi.fn(),
  unstakeToCalls: vi.fn(),
  claimRewardsToCalls: vi.fn(),
}));

// Mock starknet module
vi.mock("starknet", () => ({
  Account: vi.fn().mockImplementation(() => ({
    address: "0x1234567890abcdef",
    execute: vi.fn().mockResolvedValue(mockStakingTxResult),
  })),
  RpcProvider: vi.fn().mockImplementation(() => ({
    callContract: vi.fn(),
    waitForTransaction: vi.fn().mockResolvedValue({}),
  })),
  Contract: vi.fn().mockImplementation(() => ({
    balanceOf: vi.fn().mockResolvedValue({ low: BigInt(1e18), high: BigInt(0) }),
    decimals: vi.fn().mockResolvedValue(18),
  })),
  constants: {
    TRANSACTION_VERSION: { V3: 3 },
  },
  CallData: {
    compile: vi.fn((data) => data),
  },
  uint256: {
    uint256ToBN: vi.fn((val: { low: bigint; high: bigint }) => val.low + (val.high << 128n)),
  },
  cairo: {
    uint256: vi.fn((n) => ({ low: n, high: BigInt(0) })),
  },
  PaymasterRpc: vi.fn().mockImplementation(() => ({})),
  ETransactionVersion: { V3: 3 },
}));

import {
  getAvnuStakingInfo,
  getUserStakingInfo,
  stakeToCalls,
  initiateUnstakeToCalls,
  unstakeToCalls,
  claimRewardsToCalls,
} from "@avnu/avnu-sdk";

describe("Staking Tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getAvnuStakingInfo", () => {
    it("should return staking pool info", async () => {
      const mock = createMockAvnuStaking();
      vi.mocked(getAvnuStakingInfo).mockImplementation(mock.getAvnuStakingInfo);

      const info = await getAvnuStakingInfo();

      expect(info).toBeDefined();
      expect(info.delegationPools).toHaveLength(1);
      expect(info.delegationPools[0].poolAddress).toBe(MOCK_POOL_ADDRESS);
      expect(info.delegationPools[0].apr).toBe(0.12);
    });
  });

  describe("getUserStakingInfo", () => {
    it("should return user staking position", async () => {
      const mock = createMockAvnuStaking();
      vi.mocked(getUserStakingInfo).mockImplementation(mock.getUserStakingInfo);

      const info = await getUserStakingInfo(TOKENS.STRK, "0x1234567890abcdef");

      expect(info).toBeDefined();
      expect(info.amount).toBe(BigInt(1000e18));
      expect(info.unclaimedRewards).toBe(BigInt(50e18));
      expect(info.unpoolAmount).toBe(BigInt(0));
    });

    it("should return user with active unbonding", async () => {
      const mock = createMockAvnuStakingWithUnbonding();
      vi.mocked(getUserStakingInfo).mockImplementation(mock.getUserStakingInfo);

      const info = await getUserStakingInfo(TOKENS.STRK, "0x1234567890abcdef");

      expect(info.unpoolAmount).toBe(BigInt(500e18));
      expect(info.unpoolTime).toBeDefined();
      expect(info.unpoolTime!.getTime()).toBeGreaterThan(Date.now());
    });

    it("should return user with unbonding ready to claim", async () => {
      const mock = createMockAvnuStakingUnbondingReady();
      vi.mocked(getUserStakingInfo).mockImplementation(mock.getUserStakingInfo);

      const info = await getUserStakingInfo(TOKENS.STRK, "0x1234567890abcdef");

      expect(info.unpoolAmount).toBe(BigInt(500e18));
      expect(info.unpoolTime).toBeDefined();
      expect(info.unpoolTime!.getTime()).toBeLessThan(Date.now());
    });
  });

  describe("stakeToCalls", () => {
    it("should build stake calls", async () => {
      const mock = createMockAvnuStaking();
      vi.mocked(stakeToCalls).mockImplementation(mock.stakeToCalls);

      const { calls } = await stakeToCalls({
        poolAddress: MOCK_POOL_ADDRESS,
        userAddress: "0x1234567890abcdef",
        amount: BigInt(100e18),
      });

      expect(calls).toBeDefined();
      expect(calls).toHaveLength(1);
      expect(mock.stakeToCalls).toHaveBeenCalledWith(
        expect.objectContaining({
          poolAddress: MOCK_POOL_ADDRESS,
          amount: BigInt(100e18),
        })
      );
    });
  });

  describe("initiateUnstakeToCalls", () => {
    it("should build initiate unstake calls", async () => {
      const mock = createMockAvnuStaking();
      vi.mocked(initiateUnstakeToCalls).mockImplementation(mock.initiateUnstakeToCalls);

      const { calls } = await initiateUnstakeToCalls({
        poolAddress: MOCK_POOL_ADDRESS,
        userAddress: "0x1234567890abcdef",
        amount: BigInt(100e18),
      });

      expect(calls).toBeDefined();
      expect(calls).toHaveLength(1);
    });
  });

  describe("unstakeToCalls", () => {
    it("should build complete unstake calls", async () => {
      const mock = createMockAvnuStaking();
      vi.mocked(unstakeToCalls).mockImplementation(mock.unstakeToCalls);

      const { calls } = await unstakeToCalls({
        poolAddress: MOCK_POOL_ADDRESS,
        userAddress: "0x1234567890abcdef",
      });

      expect(calls).toBeDefined();
      expect(calls).toHaveLength(1);
    });
  });

  describe("claimRewardsToCalls", () => {
    it("should build claim rewards calls with restake=false", async () => {
      const mock = createMockAvnuStaking();
      vi.mocked(claimRewardsToCalls).mockImplementation(mock.claimRewardsToCalls);

      const { calls } = await claimRewardsToCalls({
        poolAddress: MOCK_POOL_ADDRESS,
        userAddress: "0x1234567890abcdef",
        restake: false,
      });

      expect(calls).toBeDefined();
      expect(mock.claimRewardsToCalls).toHaveBeenCalledWith(
        expect.objectContaining({
          restake: false,
        })
      );
    });

    it("should build claim rewards calls with restake=true", async () => {
      const mock = createMockAvnuStaking();
      vi.mocked(claimRewardsToCalls).mockImplementation(mock.claimRewardsToCalls);

      const { calls } = await claimRewardsToCalls({
        poolAddress: MOCK_POOL_ADDRESS,
        userAddress: "0x1234567890abcdef",
        restake: true,
      });

      expect(calls).toBeDefined();
      expect(mock.claimRewardsToCalls).toHaveBeenCalledWith(
        expect.objectContaining({
          restake: true,
        })
      );
    });
  });
});

describe("Staking Business Logic", () => {
  describe("Unbonding status calculation", () => {
    it("should return status 'none' when no active unbonding", () => {
      const userInfo = mockUserStakingInfo;
      const status = userInfo.unpoolAmount === BigInt(0) ? "none" : "cooldown";
      expect(status).toBe("none");
    });

    it("should return status 'cooldown' when unbonding in progress", () => {
      const userInfo = mockUserStakingInfoUnbonding;
      let status: string;
      if (userInfo.unpoolAmount === BigInt(0)) {
        status = "none";
      } else if (userInfo.unpoolTime && userInfo.unpoolTime > new Date()) {
        status = "cooldown";
      } else {
        status = "ready";
      }
      expect(status).toBe("cooldown");
    });

    it("should return status 'ready' when cooldown complete", () => {
      const userInfo = mockUserStakingInfoUnbondingReady;
      let status: string;
      if (userInfo.unpoolAmount === BigInt(0)) {
        status = "none";
      } else if (userInfo.unpoolTime && userInfo.unpoolTime > new Date()) {
        status = "cooldown";
      } else {
        status = "ready";
      }
      expect(status).toBe("ready");
    });
  });

  describe("Time remaining calculation", () => {
    it("should calculate days and hours remaining correctly", () => {
      const unpoolTime = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000); // 10 days 5 hours
      const remaining = unpoolTime.getTime() - Date.now();
      const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
      const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

      expect(days).toBe(10);
      expect(hours).toBeGreaterThanOrEqual(4); // Allow for test execution time
      expect(hours).toBeLessThanOrEqual(5);
    });
  });

  describe("Unbonding period lookup", () => {
    const STAKEABLE_TOKENS: Record<string, { address: string; unbondingDays: number }> = {
      STRK: { address: TOKENS.STRK, unbondingDays: 21 },
      WBTC: { address: "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac", unbondingDays: 7 },
    };

    function getUnbondingDays(tokenAddress: string): number {
      const normalizedAddress = tokenAddress.toLowerCase();
      for (const [, info] of Object.entries(STAKEABLE_TOKENS)) {
        if (info.address.toLowerCase() === normalizedAddress) {
          return info.unbondingDays;
        }
      }
      return 21; // Default
    }

    it("should return 21 days for STRK", () => {
      expect(getUnbondingDays(TOKENS.STRK)).toBe(21);
    });

    it("should return 7 days for WBTC", () => {
      expect(getUnbondingDays("0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac")).toBe(7);
    });

    it("should return default 21 days for unknown token", () => {
      expect(getUnbondingDays("0xunknown")).toBe(21);
    });
  });

  describe("Error scenarios", () => {
    it("should detect when user already has active unbonding", () => {
      const userInfo = mockUserStakingInfoUnbonding;
      const hasActiveUnbonding = userInfo.unpoolAmount > BigInt(0);
      expect(hasActiveUnbonding).toBe(true);
    });

    it("should detect when user has no rewards to claim", () => {
      const userInfo = mockUserStakingInfoNoRewards;
      const hasRewards = userInfo.unclaimedRewards > BigInt(0);
      expect(hasRewards).toBe(false);
    });

    it("should detect insufficient staked balance", () => {
      const userInfo = mockUserStakingInfo;
      const amountToUnstake = BigInt(2000e18); // More than staked
      const hasEnoughStaked = userInfo.amount >= amountToUnstake;
      expect(hasEnoughStaked).toBe(false);
    });

    it("should detect cooldown not complete", () => {
      const userInfo = mockUserStakingInfoUnbonding;
      const cooldownComplete = !userInfo.unpoolTime || userInfo.unpoolTime <= new Date();
      expect(cooldownComplete).toBe(false);
    });
  });
});

describe("Amount formatting for staking", () => {
  function formatAmount(amount: bigint, decimals: number): string {
    const amountStr = amount.toString().padStart(decimals + 1, "0");
    const whole = amountStr.slice(0, -decimals) || "0";
    const fraction = amountStr.slice(-decimals);
    return `${whole}.${fraction}`.replace(/\.?0+$/, "");
  }

  it("should format whole token amounts correctly", () => {
    expect(formatAmount(BigInt(1000e18), 18)).toBe("1000");
  });

  it("should format fractional amounts correctly", () => {
    expect(formatAmount(BigInt(1.5e18), 18)).toBe("1.5");
  });

  it("should format small reward amounts correctly", () => {
    expect(formatAmount(BigInt(50e18), 18)).toBe("50");
  });

  it("should format very small amounts with trailing zeros removed", () => {
    expect(formatAmount(BigInt(1e15), 18)).toBe("0.001");
  });
});
