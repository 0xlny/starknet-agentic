import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { normalizeAddress, TOKENS } from "../../src/utils.js";

let moduleUnderTest: typeof import("../../src/index.js");

beforeAll(async () => {
  process.env.STARKNET_RPC_URL = "http://localhost:5050";
  process.env.STARKNET_ACCOUNT_ADDRESS = "0x123";
  process.env.STARKNET_PRIVATE_KEY = "0xabc";
  moduleUnderTest = await import("../../src/index.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("starknet_get_balances integration", () => {
  it("returns formatted balances with method", async () => {
    const balances = [
      {
        token: "ETH",
        tokenAddress: TOKENS.ETH,
        balance: 1000000000000000000n,
        decimals: 18,
      },
      {
        token: "USDC",
        tokenAddress: TOKENS.USDC,
        balance: 1234567n,
        decimals: 6,
      },
    ];

    vi.spyOn(moduleUnderTest, "fetchTokenBalances").mockResolvedValue({
      balances,
      method: "balance_checker",
    });

    const result = await moduleUnderTest.getBalancesResult({
      address: "0x123",
      tokens: ["ETH", "USDC"],
    });

    expect(result).toEqual({
      address: "0x123",
      balances: [
        {
          token: "ETH",
          tokenAddress: TOKENS.ETH,
          balance: "1",
          raw: "1000000000000000000",
          decimals: 18,
        },
        {
          token: "USDC",
          tokenAddress: TOKENS.USDC,
          balance: "1.234567",
          raw: "1234567",
          decimals: 6,
        },
      ],
      tokensQueried: 2,
      method: "balance_checker",
    });
  });

  it("throws on empty token array", async () => {
    await expect(
      moduleUnderTest.getBalancesResult({
        address: "0x123",
        tokens: [],
      })
    ).rejects.toThrow("At least one token is required");
  });

  it("preserves duplicate tokens and order", async () => {
    vi.spyOn(moduleUnderTest, "fetchTokenBalances").mockImplementation(
      async (_address, tokens, tokenAddresses) => {
        expect(tokens).toEqual(["ETH", "ETH"]);
        expect(tokenAddresses).toEqual([TOKENS.ETH, TOKENS.ETH]);
        return {
          balances: [
            {
              token: "ETH",
              tokenAddress: TOKENS.ETH,
              balance: 0n,
              decimals: 18,
            },
            {
              token: "ETH",
              tokenAddress: TOKENS.ETH,
              balance: 0n,
              decimals: 18,
            },
          ],
          method: "batch_rpc",
        };
      }
    );

    const result = await moduleUnderTest.getBalancesResult({
      address: "0x123",
      tokens: ["ETH", "ETH"],
    });

    expect(result.balances).toHaveLength(2);
    expect(result.balances[0].token).toBe("ETH");
    expect(result.balances[1].token).toBe("ETH");
  });

  it("supports mixed symbols and addresses", async () => {
    const customAddress = "0x123abc456def";
    const normalized = normalizeAddress(customAddress);

    vi.spyOn(moduleUnderTest, "fetchTokenBalances").mockImplementation(
      async (_address, tokens, tokenAddresses) => {
        expect(tokens).toEqual(["ETH", customAddress]);
        expect(tokenAddresses).toEqual([TOKENS.ETH, normalized]);
        return {
          balances: [
            {
              token: "ETH",
              tokenAddress: TOKENS.ETH,
              balance: 0n,
              decimals: 18,
            },
            {
              token: customAddress,
              tokenAddress: normalized,
              balance: 0n,
              decimals: 18,
            },
          ],
          method: "batch_rpc",
        };
      }
    );

    const result = await moduleUnderTest.getBalancesResult({
      address: "0x123",
      tokens: ["ETH", customAddress],
    });

    expect(result.balances[1].tokenAddress).toBe(normalized);
  });

  it("rejects invalid token addresses", async () => {
    await expect(
      moduleUnderTest.getBalancesResult({
        address: "0x123",
        tokens: ["0xNOTHEX"],
      })
    ).rejects.toThrow();
  });
});

describe("fetchTokenBalances fallback", () => {
  it("falls back to batch RPC when BalanceChecker fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(moduleUnderTest, "fetchTokenBalancesViaBalanceChecker").mockRejectedValue(
      new Error("balance checker down")
    );
    vi.spyOn(moduleUnderTest, "fetchTokenBalancesViaBatchRpc").mockResolvedValue([
      {
        token: "ETH",
        tokenAddress: TOKENS.ETH,
        balance: 0n,
        decimals: 18,
      },
    ]);

    const result = await moduleUnderTest.fetchTokenBalances(
      "0x123",
      ["ETH"],
      [TOKENS.ETH]
    );

    expect(result.method).toBe("batch_rpc");
    expect(warnSpy).toHaveBeenCalled();
  });
});
