import { vi } from "vitest";
import type { Quote, StakingInfo, UserStakingInfo } from "@avnu/avnu-sdk";

// Token addresses for testing
export const TOKENS = {
  ETH: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  STRK: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  USDC: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
  USDT: "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8",
};

// Mock staking pool address
export const MOCK_POOL_ADDRESS = "0x0mock_pool_address_for_strk_staking";

// Mock quote matching SDK v4 structure
export const mockQuote = {
  quoteId: "mock-quote-id-123",
  sellTokenAddress: TOKENS.ETH,
  buyTokenAddress: TOKENS.USDC,
  sellAmount: BigInt(1e18), // 1 ETH
  buyAmount: BigInt(3200e6), // 3200 USDC
  sellAmountInUsd: 3200.0,
  buyAmountInUsd: 3199.5,
  priceImpact: 15, // 0.15% in basis points
  gasFees: BigInt(0),
  gasFeesInUsd: 0.02,
  chainId: "SN_MAIN",
  routes: [
    { name: "Ekubo", address: "0x123", percent: 0.8, sellTokenAddress: TOKENS.ETH, buyTokenAddress: TOKENS.USDC, routes: [], alternativeSwapCount: 0 },
    { name: "JediSwap", address: "0x456", percent: 0.2, sellTokenAddress: TOKENS.ETH, buyTokenAddress: TOKENS.USDC, routes: [], alternativeSwapCount: 0 },
  ],
  fee: {
    feeToken: TOKENS.ETH,
    avnuFees: BigInt(0),
    avnuFeesInUsd: 0,
    avnuFeesBps: BigInt(0),
    integratorFees: BigInt(0),
    integratorFeesInUsd: 0,
    integratorFeesBps: BigInt(0),
  },
} as Quote;

// Mock quote with no liquidity
export const mockEmptyQuotes: Quote[] = [];

// Mock swap result
export const mockSwapResult = {
  transactionHash: "0x123abc456def789",
};

// Create mock avnu SDK functions
export function createMockAvnu() {
  return {
    getQuotes: vi.fn().mockResolvedValue([mockQuote]),
    executeSwap: vi.fn().mockResolvedValue(mockSwapResult),
  };
}

// Create mock for no quotes scenario
export function createMockAvnuNoQuotes() {
  return {
    getQuotes: vi.fn().mockResolvedValue([]),
    executeSwap: vi.fn().mockRejectedValue(new Error("No quotes available")),
  };
}

// Create mock for error scenarios
export function createMockAvnuWithError(errorMessage: string) {
  return {
    getQuotes: vi.fn().mockRejectedValue(new Error(errorMessage)),
    executeSwap: vi.fn().mockRejectedValue(new Error(errorMessage)),
  };
}

// ==================== STAKING MOCKS ====================

// Mock staking info matching SDK structure
export const mockStakingInfo: StakingInfo = {
  selfStakedAmount: BigInt(1000000e18),
  selfStakedAmountInUsd: 500000.0,
  operationalAddress: "0x0operational_address",
  rewardAddress: "0x0reward_address",
  stakerAddress: "0x0staker_address",
  commission: 0.1,
  delegationPools: [
    {
      poolAddress: MOCK_POOL_ADDRESS,
      tokenAddress: TOKENS.STRK,
      stakedAmount: BigInt(5000000e18),
      stakedAmountInUsd: 2500000.0,
      apr: 0.12, // 12% APR
    },
  ],
};

// Mock user staking info with no active unbonding
export const mockUserStakingInfo: UserStakingInfo = {
  tokenAddress: TOKENS.STRK,
  tokenPriceInUsd: 0.5,
  poolAddress: MOCK_POOL_ADDRESS,
  userAddress: "0x1234567890abcdef",
  amount: BigInt(1000e18), // 1000 STRK staked
  amountInUsd: 500.0,
  unclaimedRewards: BigInt(50e18), // 50 STRK rewards
  unclaimedRewardsInUsd: 25.0,
  unpoolAmount: BigInt(0), // No active unbonding
  unpoolAmountInUsd: 0,
  unpoolTime: undefined,
  totalClaimedRewards: BigInt(100e18),
  totalClaimedRewardsHistoricalUsd: 40.0,
  totalClaimedRewardsUsd: 50.0,
  userActions: [],
  totalUserActionsCount: 5,
  expectedYearlyStrkRewards: BigInt(120e18), // 120 STRK yearly
  aprs: [{ date: new Date(), apr: 0.12 }],
};

// Mock user staking info with active unbonding in cooldown
export const mockUserStakingInfoUnbonding: UserStakingInfo = {
  ...mockUserStakingInfo,
  unpoolAmount: BigInt(500e18), // 500 STRK unbonding
  unpoolAmountInUsd: 250.0,
  unpoolTime: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // 10 days from now
};

// Mock user staking info with unbonding ready to claim
export const mockUserStakingInfoUnbondingReady: UserStakingInfo = {
  ...mockUserStakingInfo,
  unpoolAmount: BigInt(500e18),
  unpoolAmountInUsd: 250.0,
  unpoolTime: new Date(Date.now() - 1000), // Already passed
};

// Mock user staking info with no rewards
export const mockUserStakingInfoNoRewards: UserStakingInfo = {
  ...mockUserStakingInfo,
  unclaimedRewards: BigInt(0),
  unclaimedRewardsInUsd: 0,
};

// Mock user staking info with no staked balance
export const mockUserStakingInfoNoStake: UserStakingInfo = {
  ...mockUserStakingInfo,
  amount: BigInt(0),
  amountInUsd: 0,
  unclaimedRewards: BigInt(0),
  unclaimedRewardsInUsd: 0,
};

// Mock calls result from *ToCalls functions
export const mockAvnuCalls = {
  chainId: "SN_MAIN",
  calls: [
    {
      contractAddress: MOCK_POOL_ADDRESS,
      entrypoint: "stake",
      calldata: ["0x1000"],
    },
  ],
};

// Mock transaction result
export const mockStakingTxResult = {
  transaction_hash: "0xstaking_tx_hash_123",
};

// Create mock avnu staking functions
export function createMockAvnuStaking() {
  return {
    getAvnuStakingInfo: vi.fn().mockResolvedValue(mockStakingInfo),
    getUserStakingInfo: vi.fn().mockResolvedValue(mockUserStakingInfo),
    stakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    initiateUnstakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    unstakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    claimRewardsToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
  };
}

// Create mock for user with active unbonding
export function createMockAvnuStakingWithUnbonding() {
  return {
    getAvnuStakingInfo: vi.fn().mockResolvedValue(mockStakingInfo),
    getUserStakingInfo: vi.fn().mockResolvedValue(mockUserStakingInfoUnbonding),
    stakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    initiateUnstakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    unstakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    claimRewardsToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
  };
}

// Create mock for user with unbonding ready to claim
export function createMockAvnuStakingUnbondingReady() {
  return {
    getAvnuStakingInfo: vi.fn().mockResolvedValue(mockStakingInfo),
    getUserStakingInfo: vi.fn().mockResolvedValue(mockUserStakingInfoUnbondingReady),
    stakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    initiateUnstakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    unstakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    claimRewardsToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
  };
}

// Create mock for user with no rewards
export function createMockAvnuStakingNoRewards() {
  return {
    getAvnuStakingInfo: vi.fn().mockResolvedValue(mockStakingInfo),
    getUserStakingInfo: vi.fn().mockResolvedValue(mockUserStakingInfoNoRewards),
    stakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    initiateUnstakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    unstakeToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
    claimRewardsToCalls: vi.fn().mockResolvedValue(mockAvnuCalls),
  };
}

// Create mock for staking error scenarios
export function createMockAvnuStakingWithError(errorMessage: string) {
  return {
    getAvnuStakingInfo: vi.fn().mockRejectedValue(new Error(errorMessage)),
    getUserStakingInfo: vi.fn().mockRejectedValue(new Error(errorMessage)),
    stakeToCalls: vi.fn().mockRejectedValue(new Error(errorMessage)),
    initiateUnstakeToCalls: vi.fn().mockRejectedValue(new Error(errorMessage)),
    unstakeToCalls: vi.fn().mockRejectedValue(new Error(errorMessage)),
    claimRewardsToCalls: vi.fn().mockRejectedValue(new Error(errorMessage)),
  };
}
