#!/usr/bin/env node

/**
 * Starknet MCP Server
 *
 * Exposes Starknet operations as MCP tools for AI agents.
 * Works with any MCP-compatible client: Claude, ChatGPT, Cursor, OpenClaw.
 *
 * Tools:
 * - starknet_get_balance: Check token balances
 * - starknet_transfer: Send tokens
 * - starknet_call_contract: Read contract state
 * - starknet_invoke_contract: Write to contracts
 * - starknet_swap: Execute swaps via avnu
 * - starknet_get_quote: Get swap quotes
 * - starknet_get_staking_info: Get staking pool and user position info
 * - starknet_stake: Stake tokens to earn rewards
 * - starknet_claim_staking_rewards: Claim or restake earned rewards
 * - starknet_initiate_unstake: Start the unstaking process (begins cooldown)
 * - starknet_complete_unstake: Claim tokens after cooldown period
 * - starknet_get_unbonding_status: Check unstaking cooldown status
 *
 * Usage:
 *   STARKNET_RPC_URL=... STARKNET_ACCOUNT_ADDRESS=... STARKNET_PRIVATE_KEY=... node dist/index.js
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Account,
  RpcProvider,
  Contract,
  CallData,
  cairo,
  uint256,
  ETransactionVersion,
  type Call,
  type PaymasterDetails,
} from "starknet";
import {
  getQuotes,
  quoteToCalls,
  getAvnuStakingInfo,
  getUserStakingInfo,
  stakeToCalls,
  initiateUnstakeToCalls,
  unstakeToCalls,
  claimRewardsToCalls,
  type QuoteRequest,
  type StakingInfo,
  type UserStakingInfo,
} from "@avnu/avnu-sdk";
import { z } from "zod";
import { formatAmount, formatQuoteFields, formatErrorMessage } from "./utils/formatter.js";

// Environment validation
const envSchema = z.object({
  STARKNET_RPC_URL: z.string().url(),
  STARKNET_ACCOUNT_ADDRESS: z.string().startsWith("0x"),
  STARKNET_PRIVATE_KEY: z.string().startsWith("0x"),
  AVNU_BASE_URL: z.string().url().optional(),
  AVNU_PAYMASTER_URL: z.string().url().optional(),
  AVNU_PAYMASTER_API_KEY: z.string().optional(),
});

const env = envSchema.parse({
  STARKNET_RPC_URL: process.env.STARKNET_RPC_URL,
  STARKNET_ACCOUNT_ADDRESS: process.env.STARKNET_ACCOUNT_ADDRESS,
  STARKNET_PRIVATE_KEY: process.env.STARKNET_PRIVATE_KEY,
  AVNU_BASE_URL: process.env.AVNU_BASE_URL || "https://starknet.api.avnu.fi",
  AVNU_PAYMASTER_URL: process.env.AVNU_PAYMASTER_URL || "https://starknet.paymaster.avnu.fi",
  AVNU_PAYMASTER_API_KEY: process.env.AVNU_PAYMASTER_API_KEY,
});

// Token addresses (Mainnet)
const TOKENS = {
  ETH: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
  STRK: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  USDC: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8",
  USDT: "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8",
};

// Stakeable tokens with unbonding periods
const STAKEABLE_TOKENS: Record<string, { address: string; unbondingDays: number }> = {
  STRK: { address: TOKENS.STRK, unbondingDays: 21 },
  WBTC: { address: "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac", unbondingDays: 7 },
  TBTC: { address: "0x05958238523c56709bff7a99567939bbba64718daa527571789f1ee5e66c7f85", unbondingDays: 7 },
  SOLVBTC: { address: "0x0153b21b6b1d1b36d5b43c6bcffabb0c22e8d17e1a61f79d4e9aa6b1a03c7e8d", unbondingDays: 7 },
  LBTC: { address: "0x025fcc7ed5e0a5d5f0b4c3c2a9da34c6a5cca2a0b1b5e4b3c2a1d0e9f8c7b6a5", unbondingDays: 7 },
};

// Get unbonding period in days for a token address
function getUnbondingDays(tokenAddress: string): number {
  const normalizedAddress = tokenAddress.toLowerCase();
  for (const [, info] of Object.entries(STAKEABLE_TOKENS)) {
    if (info.address.toLowerCase() === normalizedAddress) {
      return info.unbondingDays;
    }
  }
  // Default to STRK unbonding period if unknown
  return 21;
}

// ERC20 ABI (minimal)
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "felt" }],
    outputs: [{ name: "balance", type: "Uint256" }],
    stateMutability: "view",
  },
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "recipient", type: "felt" },
      { name: "amount", type: "Uint256" },
    ],
    outputs: [{ name: "success", type: "felt" }],
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ name: "decimals", type: "felt" }],
    stateMutability: "view",
  },
];

// Initialize Starknet provider and account
const provider = new RpcProvider({ nodeUrl: env.STARKNET_RPC_URL });
const account = new Account({
  provider,
  address: env.STARKNET_ACCOUNT_ADDRESS,
  signer: env.STARKNET_PRIVATE_KEY,
  transactionVersion: ETransactionVersion.V3,
});

// Fee mode: sponsored (gasfree, dApp pays) vs default (user pays in gasToken)
const isSponsored = !!env.AVNU_PAYMASTER_API_KEY;

/**
 * Execute transaction with optional gasfree mode.
 * - gasfree=false: standard account.execute
 * - gasfree=true + API key: sponsored mode (dApp pays all gas)
 * - gasfree=true + no API key: user pays gas in gasToken
 */
async function executeTransaction(
  calls: Call | Call[],
  gasfree: boolean,
  gasToken: string = TOKENS.STRK
): Promise<string> {
  if (!gasfree) {
    const result = await account.execute(calls);
    return result.transaction_hash;
  }

  const callsArray = Array.isArray(calls) ? calls : [calls];
  const feeDetails: PaymasterDetails = isSponsored
    ? { feeMode: { mode: "sponsored" } }
    : { feeMode: { mode: "default", gasToken } };

  const estimation = await account.estimatePaymasterTransactionFee(callsArray, feeDetails);
  const result = await account.executePaymasterTransaction(
    callsArray,
    feeDetails,
    estimation.suggested_max_fee_in_gas_token
  );

  return result.transaction_hash;
}

// MCP Server setup
const server = new Server(
  {
    name: "starknet-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions
const tools: Tool[] = [
  {
    name: "starknet_get_balance",
    description:
      "Get token balance for an address on Starknet. Supports ETH, STRK, USDC, USDT, or any token address.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "The address to check balance for (defaults to agent's address)",
        },
        token: {
          type: "string",
          description: "Token symbol (ETH, STRK, USDC, USDT) or contract address",
        },
      },
      required: ["token"],
    },
  },
  {
    name: "starknet_transfer",
    description: "Transfer tokens to another address on Starknet. Supports gasfree mode where gas is paid in an ERC-20 token instead of ETH/STRK.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: {
          type: "string",
          description: "Recipient address (must start with 0x)",
        },
        token: {
          type: "string",
          description: "Token symbol (ETH, STRK, USDC, USDT) or contract address",
        },
        amount: {
          type: "string",
          description: "Amount to transfer in human-readable format (e.g., '1.5' for 1.5 tokens)",
        },
        gasfree: {
          type: "boolean",
          description: "Use gasfree mode (paymaster pays gas or gas paid in token)",
          default: false,
        },
        gasToken: {
          type: "string",
          description: "Token to pay gas fees in (symbol or address). Only used when gasfree=true and no API key is set.",
        },
      },
      required: ["recipient", "token", "amount"],
    },
  },
  {
    name: "starknet_call_contract",
    description: "Call a read-only contract function on Starknet",
    inputSchema: {
      type: "object",
      properties: {
        contractAddress: {
          type: "string",
          description: "Contract address",
        },
        entrypoint: {
          type: "string",
          description: "Function name to call",
        },
        calldata: {
          type: "array",
          items: { type: "string" },
          description: "Function arguments as array of strings",
          default: [],
        },
      },
      required: ["contractAddress", "entrypoint"],
    },
  },
  {
    name: "starknet_invoke_contract",
    description: "Invoke a state-changing contract function on Starknet. Supports gasfree mode where gas is paid in an ERC-20 token instead of ETH/STRK.",
    inputSchema: {
      type: "object",
      properties: {
        contractAddress: {
          type: "string",
          description: "Contract address",
        },
        entrypoint: {
          type: "string",
          description: "Function name to call",
        },
        calldata: {
          type: "array",
          items: { type: "string" },
          description: "Function arguments as array of strings",
          default: [],
        },
        gasfree: {
          type: "boolean",
          description: "Use gasfree mode (paymaster pays gas or gas paid in token)",
          default: false,
        },
        gasToken: {
          type: "string",
          description: "Token to pay gas fees in (symbol or address). Only used when gasfree=true and no API key is set.",
        },
      },
      required: ["contractAddress", "entrypoint"],
    },
  },
  {
    name: "starknet_swap",
    description:
      "Execute a token swap on Starknet using avnu aggregator for best prices. Supports gasfree mode where gas is paid via paymaster.",
    inputSchema: {
      type: "object",
      properties: {
        sellToken: {
          type: "string",
          description: "Token to sell (symbol or address)",
        },
        buyToken: {
          type: "string",
          description: "Token to buy (symbol or address)",
        },
        amount: {
          type: "string",
          description: "Amount to sell in human-readable format",
        },
        slippage: {
          type: "number",
          description: "Maximum slippage tolerance (0.01 = 1%)",
          default: 0.01,
        },
        gasfree: {
          type: "boolean",
          description: "Use gasfree mode (paymaster pays gas or gas paid in token)",
          default: false,
        },
        gasToken: {
          type: "string",
          description: "Token to pay gas fees in (symbol or address). Defaults to sellToken. Only used when gasfree=true and no API key is set.",
        },
      },
      required: ["sellToken", "buyToken", "amount"],
    },
  },
  {
    name: "starknet_get_quote",
    description: "Get swap quote without executing the trade",
    inputSchema: {
      type: "object",
      properties: {
        sellToken: {
          type: "string",
          description: "Token to sell (symbol or address)",
        },
        buyToken: {
          type: "string",
          description: "Token to buy (symbol or address)",
        },
        amount: {
          type: "string",
          description: "Amount to sell in human-readable format",
        },
      },
      required: ["sellToken", "buyToken", "amount"],
    },
  },
  {
    name: "starknet_estimate_fee",
    description: "Estimate transaction fee for a contract call",
    inputSchema: {
      type: "object",
      properties: {
        contractAddress: {
          type: "string",
          description: "Contract address",
        },
        entrypoint: {
          type: "string",
          description: "Function name",
        },
        calldata: {
          type: "array",
          items: { type: "string" },
          description: "Function arguments",
          default: [],
        },
      },
      required: ["contractAddress", "entrypoint"],
    },
  },
  {
    name: "starknet_get_staking_info",
    description:
      "Get staking pool information (APY, total staked) and user's staking position. Supports STRK and BTC variants (WBTC, tBTC, SolvBTC, LBTC).",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token to check staking info for (STRK, WBTC, etc.). Defaults to STRK.",
        },
        userAddress: {
          type: "string",
          description: "Address to check position for (defaults to agent's address)",
        },
      },
    },
  },
  {
    name: "starknet_stake",
    description:
      "Stake tokens to earn rewards via AVNU staking. Supports STRK and BTC variants. Tokens start earning rewards immediately.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token to stake (STRK, WBTC, tBTC, SolvBTC, LBTC)",
        },
        amount: {
          type: "string",
          description: "Amount to stake in human-readable format (e.g., '100' for 100 tokens)",
        },
      },
      required: ["token", "amount"],
    },
  },
  {
    name: "starknet_claim_staking_rewards",
    description:
      "Claim accumulated staking rewards. Can either withdraw to wallet or restake (compound) for higher returns.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token to claim rewards for. Defaults to STRK.",
        },
        restake: {
          type: "boolean",
          description: "If true, rewards are restaked (compounded). If false, withdrawn to wallet. Defaults to false.",
        },
      },
    },
  },
  {
    name: "starknet_initiate_unstake",
    description:
      "Start the unstaking process. This begins the cooldown period (21 days for STRK, 7 days for BTC variants). Tokens stop earning rewards during cooldown. Only one unstake can be active at a time.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token to unstake (STRK, WBTC, tBTC, SolvBTC, LBTC)",
        },
        amount: {
          type: "string",
          description: "Amount to unstake in human-readable format",
        },
      },
      required: ["token", "amount"],
    },
  },
  {
    name: "starknet_complete_unstake",
    description:
      "Complete the unstaking process and claim tokens after the cooldown period. Use starknet_get_unbonding_status to check if cooldown is complete.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token to complete unstaking for. Defaults to STRK.",
        },
      },
    },
  },
  {
    name: "starknet_get_unbonding_status",
    description:
      "Check the status of an active unstaking request. Returns whether in cooldown, ready to claim, or no active unstake.",
    inputSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description: "Token to check unbonding status for. Defaults to STRK.",
        },
        userAddress: {
          type: "string",
          description: "Address to check (defaults to agent's address)",
        },
      },
    },
  },
];

// Helper: Resolve token address from symbol
function resolveTokenAddress(token: string): string {
  const upperToken = token.toUpperCase();
  if (upperToken in TOKENS) {
    return TOKENS[upperToken as keyof typeof TOKENS];
  }
  if (token.startsWith("0x")) {
    return token;
  }
  throw new Error(`Unknown token: ${token}`);
}

// Helper: Parse amount with decimals
async function parseAmount(
  amount: string,
  tokenAddress: string
): Promise<bigint> {
  const contract = new Contract({ abi: ERC20_ABI, address: tokenAddress, providerOrAccount: provider });
  const decimals = await contract.decimals();
  const decimalsBigInt = BigInt(decimals.toString());

  // Handle decimal amounts
  const [whole, fraction = ""] = amount.split(".");
  const paddedFraction = fraction.padEnd(Number(decimalsBigInt), "0");
  const amountStr = whole + paddedFraction.slice(0, Number(decimalsBigInt));

  return BigInt(amountStr);
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "starknet_get_balance": {
        const { address = env.STARKNET_ACCOUNT_ADDRESS, token } = args as {
          address?: string;
          token: string;
        };

        const tokenAddress = resolveTokenAddress(token);
        const contract = new Contract({ abi: ERC20_ABI, address: tokenAddress, providerOrAccount: provider });

        const balance = await contract.balanceOf(address);
        const decimals = await contract.decimals();

        const balanceBigInt = uint256.uint256ToBN(balance);
        const formattedBalance = formatAmount(balanceBigInt, Number(decimals));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                address,
                token,
                balance: formattedBalance,
                raw: balanceBigInt.toString(),
                decimals: Number(decimals),
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_transfer": {
        const { recipient, token, amount, gasfree = false, gasToken } = args as {
          recipient: string;
          token: string;
          amount: string;
          gasfree?: boolean;
          gasToken?: string;
        };

        const tokenAddress = resolveTokenAddress(token);
        const amountWei = await parseAmount(amount, tokenAddress);
        const gasTokenAddress = gasToken ? resolveTokenAddress(gasToken) : TOKENS.STRK;

        const transferCall: Call = {
          contractAddress: tokenAddress,
          entrypoint: "transfer",
          calldata: CallData.compile({
            recipient,
            amount: cairo.uint256(amountWei),
          }),
        };

        const transactionHash = await executeTransaction(transferCall, gasfree, gasTokenAddress);
        await provider.waitForTransaction(transactionHash);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                transactionHash,
                recipient,
                token,
                amount,
                gasfree,
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_call_contract": {
        const { contractAddress, entrypoint, calldata = [] } = args as {
          contractAddress: string;
          entrypoint: string;
          calldata?: string[];
        };

        const result = await provider.callContract({
          contractAddress,
          entrypoint,
          calldata,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                result: Array.isArray(result) ? result : (result as any).result,
                contractAddress,
                entrypoint,
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_invoke_contract": {
        const { contractAddress, entrypoint, calldata = [], gasfree = false, gasToken } = args as {
          contractAddress: string;
          entrypoint: string;
          calldata?: string[];
          gasfree?: boolean;
          gasToken?: string;
        };

        const gasTokenAddress = gasToken ? resolveTokenAddress(gasToken) : TOKENS.STRK;
        const invokeCall: Call = { contractAddress, entrypoint, calldata };

        const transactionHash = await executeTransaction(invokeCall, gasfree, gasTokenAddress);
        await provider.waitForTransaction(transactionHash);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                transactionHash,
                contractAddress,
                entrypoint,
                gasfree,
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_swap": {
        const { sellToken, buyToken, amount, slippage = 0.01, gasfree = false, gasToken } = args as {
          sellToken: string;
          buyToken: string;
          amount: string;
          slippage?: number;
          gasfree?: boolean;
          gasToken?: string;
        };

        const sellTokenAddress = resolveTokenAddress(sellToken);
        const buyTokenAddress = resolveTokenAddress(buyToken);
        const sellAmount = await parseAmount(amount, sellTokenAddress);

        const quoteParams: QuoteRequest = {
          sellTokenAddress,
          buyTokenAddress,
          sellAmount,
          takerAddress: account.address,
        };

        const quotes = await getQuotes(quoteParams, { baseUrl: env.AVNU_BASE_URL });
        if (!quotes || quotes.length === 0) {
          throw new Error("No quotes available for this swap");
        }

        const bestQuote = quotes[0];

        const { calls } = await quoteToCalls({
          quoteId: bestQuote.quoteId,
          takerAddress: account.address,
          slippage,
          executeApprove: true,
        }, { baseUrl: env.AVNU_BASE_URL });

        const gasTokenAddress = gasToken ? resolveTokenAddress(gasToken) : sellTokenAddress;
        const transactionHash = await executeTransaction(calls, gasfree, gasTokenAddress);
        await provider.waitForTransaction(transactionHash);

        const buyTokenContract = new Contract({ abi: ERC20_ABI, address: buyTokenAddress, providerOrAccount: provider });
        const buyDecimals = Number(await buyTokenContract.decimals());
        const quoteFields = formatQuoteFields(bestQuote, buyDecimals);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                transactionHash,
                sellToken,
                buyToken,
                sellAmount: amount,
                ...quoteFields,
                buyAmountInUsd: bestQuote.buyAmountInUsd?.toFixed(2),
                slippage,
                gasfree,
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_get_quote": {
        const { sellToken, buyToken, amount } = args as {
          sellToken: string;
          buyToken: string;
          amount: string;
        };

        const sellTokenAddress = resolveTokenAddress(sellToken);
        const buyTokenAddress = resolveTokenAddress(buyToken);
        const sellAmount = await parseAmount(amount, sellTokenAddress);

        const quoteParams: QuoteRequest = {
          sellTokenAddress,
          buyTokenAddress,
          sellAmount,
          takerAddress: account.address,
        };

        const quotes = await getQuotes(quoteParams, { baseUrl: env.AVNU_BASE_URL });
        if (!quotes || quotes.length === 0) {
          throw new Error("No quotes available");
        }

        const bestQuote = quotes[0];

        const buyTokenContract = new Contract({ abi: ERC20_ABI, address: buyTokenAddress, providerOrAccount: provider });
        const buyDecimals = Number(await buyTokenContract.decimals());
        const quoteFields = formatQuoteFields(bestQuote, buyDecimals);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sellToken,
                buyToken,
                sellAmount: amount,
                ...quoteFields,
                sellAmountInUsd: bestQuote.sellAmountInUsd?.toFixed(2),
                buyAmountInUsd: bestQuote.buyAmountInUsd?.toFixed(2),
                quoteId: bestQuote.quoteId,
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_estimate_fee": {
        const { contractAddress, entrypoint, calldata = [] } = args as {
          contractAddress: string;
          entrypoint: string;
          calldata?: string[];
        };

        const fee = await account.estimateInvokeFee({
          contractAddress,
          entrypoint,
          calldata,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                overallFee: formatAmount(
                  BigInt(fee.overall_fee.toString()),
                  18
                ),
                resourceBounds: fee.resourceBounds,
                unit: fee.unit || "STRK",
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_get_staking_info": {
        const { token = "STRK", userAddress = env.STARKNET_ACCOUNT_ADDRESS } = args as {
          token?: string;
          userAddress?: string;
        };

        const tokenAddress = resolveTokenAddress(token);

        // Get pool info from AVNU
        const stakingInfo: StakingInfo = await getAvnuStakingInfo({ baseUrl: env.AVNU_BASE_URL });

        // Find the pool for this token
        const pool = stakingInfo.delegationPools.find(
          (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
        );

        if (!pool) {
          throw new Error(`No staking pool found for token ${token}`);
        }

        // Get user's staking position
        const userInfo: UserStakingInfo = await getUserStakingInfo(
          tokenAddress,
          userAddress,
          { baseUrl: env.AVNU_BASE_URL }
        );

        // Get token decimals for formatting
        const contract = new Contract({ abi: ERC20_ABI, address: tokenAddress, providerOrAccount: provider });
        const decimals = await contract.decimals();
        const decimalsNum = Number(decimals);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                pool: {
                  tokenAddress: pool.tokenAddress,
                  poolAddress: pool.poolAddress,
                  apr: `${(pool.apr * 100).toFixed(2)}%`,
                  totalStaked: formatAmount(pool.stakedAmount, decimalsNum),
                  totalStakedUsd: pool.stakedAmountInUsd?.toFixed(2),
                },
                user: {
                  address: userAddress,
                  stakedAmount: formatAmount(userInfo.amount, decimalsNum),
                  stakedAmountUsd: userInfo.amountInUsd?.toFixed(2),
                  unclaimedRewards: formatAmount(userInfo.unclaimedRewards, decimalsNum),
                  unclaimedRewardsUsd: userInfo.unclaimedRewardsInUsd?.toFixed(2),
                  expectedYearlyRewards: formatAmount(userInfo.expectedYearlyStrkRewards, decimalsNum),
                },
                token,
                unbondingPeriodDays: getUnbondingDays(tokenAddress),
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_stake": {
        const { token, amount } = args as {
          token: string;
          amount: string;
        };

        const tokenAddress = resolveTokenAddress(token);
        const amountWei = await parseAmount(amount, tokenAddress);

        // Get pool info to find pool address
        const stakingInfo: StakingInfo = await getAvnuStakingInfo({ baseUrl: env.AVNU_BASE_URL });
        const pool = stakingInfo.delegationPools.find(
          (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
        );

        if (!pool) {
          throw new Error(`No staking pool found for token ${token}`);
        }

        // Build stake calls using avnu SDK
        const { calls } = await stakeToCalls(
          {
            poolAddress: pool.poolAddress,
            userAddress: account.address,
            amount: amountWei,
          },
          { baseUrl: env.AVNU_BASE_URL }
        );

        // Execute via starknet.js
        const result = await account.execute(calls);
        await provider.waitForTransaction(result.transaction_hash);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                transactionHash: result.transaction_hash,
                token,
                amount,
                poolAddress: pool.poolAddress,
                message: `Successfully staked ${amount} ${token}. Tokens are now earning rewards.`,
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_claim_staking_rewards": {
        const { token = "STRK", restake = false } = args as {
          token?: string;
          restake?: boolean;
        };

        const tokenAddress = resolveTokenAddress(token);

        // Get pool info
        const stakingInfo: StakingInfo = await getAvnuStakingInfo({ baseUrl: env.AVNU_BASE_URL });
        const pool = stakingInfo.delegationPools.find(
          (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
        );

        if (!pool) {
          throw new Error(`No staking pool found for token ${token}`);
        }

        // Check if there are rewards to claim
        const userInfo: UserStakingInfo = await getUserStakingInfo(
          tokenAddress,
          account.address,
          { baseUrl: env.AVNU_BASE_URL }
        );

        if (userInfo.unclaimedRewards === BigInt(0)) {
          throw new Error("No rewards available to claim");
        }

        // Build claim calls
        const { calls } = await claimRewardsToCalls(
          {
            poolAddress: pool.poolAddress,
            userAddress: account.address,
            restake,
          },
          { baseUrl: env.AVNU_BASE_URL }
        );

        // Execute
        const result = await account.execute(calls);
        await provider.waitForTransaction(result.transaction_hash);

        // Get decimals for formatting
        const contract = new Contract({ abi: ERC20_ABI, address: tokenAddress, providerOrAccount: provider });
        const decimals = await contract.decimals();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                transactionHash: result.transaction_hash,
                token,
                rewardsClaimed: formatAmount(userInfo.unclaimedRewards, Number(decimals)),
                rewardsClaimedUsd: userInfo.unclaimedRewardsInUsd?.toFixed(2),
                restaked: restake,
                message: restake
                  ? `Rewards restaked (compounded) to earn more.`
                  : `Rewards withdrawn to wallet.`,
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_initiate_unstake": {
        const { token, amount } = args as {
          token: string;
          amount: string;
        };

        const tokenAddress = resolveTokenAddress(token);
        const amountWei = await parseAmount(amount, tokenAddress);

        // Get pool info
        const stakingInfo: StakingInfo = await getAvnuStakingInfo({ baseUrl: env.AVNU_BASE_URL });
        const pool = stakingInfo.delegationPools.find(
          (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
        );

        if (!pool) {
          throw new Error(`No staking pool found for token ${token}`);
        }

        // Check if there's already an active unbonding
        const userInfo: UserStakingInfo = await getUserStakingInfo(
          tokenAddress,
          account.address,
          { baseUrl: env.AVNU_BASE_URL }
        );

        if (userInfo.unpoolAmount > BigInt(0)) {
          const contract = new Contract({ abi: ERC20_ABI, address: tokenAddress, providerOrAccount: provider });
          const decimals = await contract.decimals();
          throw new Error(
            `Already have an active unstake of ${formatAmount(userInfo.unpoolAmount, Number(decimals))} ${token}. ` +
            `Only one unstake can be active at a time. Complete the current unstake first.`
          );
        }

        // Check user has enough staked
        if (userInfo.amount < amountWei) {
          const contract = new Contract({ abi: ERC20_ABI, address: tokenAddress, providerOrAccount: provider });
          const decimals = await contract.decimals();
          throw new Error(
            `Insufficient staked balance. You have ${formatAmount(userInfo.amount, Number(decimals))} ${token} staked.`
          );
        }

        // Build initiate unstake calls
        const { calls } = await initiateUnstakeToCalls(
          {
            poolAddress: pool.poolAddress,
            userAddress: account.address,
            amount: amountWei,
          },
          { baseUrl: env.AVNU_BASE_URL }
        );

        // Execute
        const result = await account.execute(calls);
        await provider.waitForTransaction(result.transaction_hash);

        // Calculate cooldown end date
        const unbondingDays = getUnbondingDays(tokenAddress);
        const cooldownEndDate = new Date();
        cooldownEndDate.setDate(cooldownEndDate.getDate() + unbondingDays);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                transactionHash: result.transaction_hash,
                token,
                amount,
                poolAddress: pool.poolAddress,
                cooldownDays: unbondingDays,
                cooldownEndsAt: cooldownEndDate.toISOString(),
                warnings: [
                  `Tokens will NOT earn rewards during the ${unbondingDays}-day cooldown period.`,
                  `Use starknet_complete_unstake after ${cooldownEndDate.toDateString()} to claim tokens.`,
                  `Only one unstake can be active at a time.`,
                ],
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_complete_unstake": {
        const { token = "STRK" } = args as {
          token?: string;
        };

        const tokenAddress = resolveTokenAddress(token);

        // Get pool info
        const stakingInfo: StakingInfo = await getAvnuStakingInfo({ baseUrl: env.AVNU_BASE_URL });
        const pool = stakingInfo.delegationPools.find(
          (p) => p.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
        );

        if (!pool) {
          throw new Error(`No staking pool found for token ${token}`);
        }

        // Check unbonding status
        const userInfo: UserStakingInfo = await getUserStakingInfo(
          tokenAddress,
          account.address,
          { baseUrl: env.AVNU_BASE_URL }
        );

        if (userInfo.unpoolAmount === BigInt(0)) {
          throw new Error("No active unstake request. Use starknet_initiate_unstake first.");
        }

        // Check if cooldown is complete
        if (userInfo.unpoolTime && userInfo.unpoolTime > new Date()) {
          const timeRemaining = userInfo.unpoolTime.getTime() - Date.now();
          const daysRemaining = Math.ceil(timeRemaining / (1000 * 60 * 60 * 24));
          const hoursRemaining = Math.ceil(timeRemaining / (1000 * 60 * 60)) % 24;

          throw new Error(
            `Cooldown not complete. ${daysRemaining} days and ${hoursRemaining} hours remaining. ` +
            `Ready to claim on ${userInfo.unpoolTime.toDateString()}.`
          );
        }

        // Build unstake calls
        const { calls } = await unstakeToCalls(
          {
            poolAddress: pool.poolAddress,
            userAddress: account.address,
          },
          { baseUrl: env.AVNU_BASE_URL }
        );

        // Execute
        const result = await account.execute(calls);
        await provider.waitForTransaction(result.transaction_hash);

        // Get decimals for formatting
        const contract = new Contract({ abi: ERC20_ABI, address: tokenAddress, providerOrAccount: provider });
        const decimals = await contract.decimals();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                transactionHash: result.transaction_hash,
                token,
                amountClaimed: formatAmount(userInfo.unpoolAmount, Number(decimals)),
                message: "Unstake complete. Tokens have been returned to your wallet.",
              }, null, 2),
            },
          ],
        };
      }

      case "starknet_get_unbonding_status": {
        const { token = "STRK", userAddress = env.STARKNET_ACCOUNT_ADDRESS } = args as {
          token?: string;
          userAddress?: string;
        };

        const tokenAddress = resolveTokenAddress(token);

        // Get user staking info
        const userInfo: UserStakingInfo = await getUserStakingInfo(
          tokenAddress,
          userAddress,
          { baseUrl: env.AVNU_BASE_URL }
        );

        // Get decimals for formatting
        const contract = new Contract({ abi: ERC20_ABI, address: tokenAddress, providerOrAccount: provider });
        const decimals = await contract.decimals();

        // Determine status
        let status: "none" | "cooldown" | "ready";
        let timeRemaining: string | undefined;
        let nextAction: string;

        if (userInfo.unpoolAmount === BigInt(0)) {
          status = "none";
          nextAction = "No active unstake. Use starknet_initiate_unstake to start.";
        } else if (userInfo.unpoolTime && userInfo.unpoolTime > new Date()) {
          status = "cooldown";
          const remaining = userInfo.unpoolTime.getTime() - Date.now();
          const days = Math.floor(remaining / (1000 * 60 * 60 * 24));
          const hours = Math.floor((remaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
          const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
          timeRemaining = `${days}d ${hours}h ${minutes}m`;
          nextAction = `Wait for cooldown to complete on ${userInfo.unpoolTime.toDateString()}.`;
        } else {
          status = "ready";
          nextAction = "Use starknet_complete_unstake to claim your tokens.";
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status,
                token,
                userAddress,
                unbondingAmount: formatAmount(userInfo.unpoolAmount, Number(decimals)),
                unbondingAmountUsd: userInfo.unpoolAmountInUsd?.toFixed(2),
                cooldownEndsAt: userInfo.unpoolTime?.toISOString(),
                timeRemaining,
                nextAction,
              }, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const userMessage = formatErrorMessage(errorMessage);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: true,
            message: userMessage,
            originalError: errorMessage !== userMessage ? errorMessage : undefined,
            tool: name,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Starknet MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
