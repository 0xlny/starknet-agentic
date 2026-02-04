import { describe, it, expect, beforeEach, vi } from "vitest";
import { TokenService } from "../../src/services/TokenService.js";
import { resetTokenService, getTokenService } from "../../src/services/index.js";
import { TOKEN_TTL_MS } from "../../src/types/token.js";

// Mock avnu SDK
vi.mock("@avnu/avnu-sdk", () => ({
  fetchTokenByAddress: vi.fn(),
  fetchVerifiedTokenBySymbol: vi.fn(),
}));

import { fetchTokenByAddress, fetchVerifiedTokenBySymbol } from "@avnu/avnu-sdk";

const MOCK_LORDS_TOKEN = {
  address: "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49",
  symbol: "LORDS",
  name: "Lords",
  decimals: 18,
  logoUri: "https://example.com/lords.png",
  lastDailyVolumeUsd: 50000,
  tags: ["Verified"] as const,
  extensions: {},
};

const MOCK_ZEND_TOKEN = {
  address: "0x00585c32b625999e6e5e78645ff8df7a9001cf5cf3eb6b80ccdd16cb64bd3a34",
  symbol: "ZEND",
  name: "ZkLend Token",
  decimals: 18,
  logoUri: null,
  lastDailyVolumeUsd: 25000,
  tags: ["Verified"] as const,
  extensions: {},
};

describe("TokenService", () => {
  let service: TokenService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetTokenService();
    service = new TokenService();
  });

  describe("static tokens", () => {
    it("should have ETH, STRK, USDC, USDT loaded by default", () => {
      expect(service.getCacheSize()).toBe(4);
      expect(service.getDecimals("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7")).toBe(18);
      expect(service.getDecimals("0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d")).toBe(18);
      expect(service.getDecimals("0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8")).toBe(6);
      expect(service.getDecimals("0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8")).toBe(6);
    });

    it("should resolve static token symbols case-insensitively", () => {
      const ethAddr = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
      expect(service.resolveSymbol("ETH")).toBe(ethAddr);
      expect(service.resolveSymbol("eth")).toBe(ethAddr);
      expect(service.resolveSymbol("Eth")).toBe(ethAddr);
    });

    it("should mark static tokens as isStatic", () => {
      const ethInfo = service.getTokenInfo("ETH");
      expect(ethInfo).toBeDefined();
      expect(ethInfo?.isStatic).toBe(true);
    });
  });

  describe("symbol resolution", () => {
    it("should resolve known symbols", () => {
      expect(service.resolveSymbol("USDC")).toBe("0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8");
    });

    it("should pass through and normalize hex addresses", () => {
      // Short address should be normalized to full 64-char
      const result = service.resolveSymbol("0x123");
      expect(result).toMatch(/^0x0+123$/);
      expect(result.length).toBe(66); // 0x + 64 chars
    });

    it("should throw for unknown symbols", () => {
      expect(() => service.resolveSymbol("UNKNOWN")).toThrow("Unknown token: UNKNOWN");
    });
  });

  describe("getDecimals", () => {
    it("should return decimals for cached tokens", () => {
      expect(service.getDecimals("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7")).toBe(18);
    });

    it("should return undefined for unknown tokens", () => {
      expect(service.getDecimals("0x0000000000000000000000000000000000000000000000000000000000001234")).toBeUndefined();
    });
  });

  describe("async methods with avnu", () => {
    it("should fetch token by address from avnu when not cached", async () => {
      vi.mocked(fetchTokenByAddress).mockResolvedValueOnce(MOCK_LORDS_TOKEN);

      const token = await service.getTokenByAddress(MOCK_LORDS_TOKEN.address);

      expect(fetchTokenByAddress).toHaveBeenCalledWith(MOCK_LORDS_TOKEN.address, { baseUrl: "https://starknet.api.avnu.fi" });
      expect(token.symbol).toBe("LORDS");
      expect(token.decimals).toBe(18);
      expect(token.isStatic).toBe(false);
    });

    it("should cache token after fetching", async () => {
      vi.mocked(fetchTokenByAddress).mockResolvedValueOnce(MOCK_LORDS_TOKEN);

      await service.getTokenByAddress(MOCK_LORDS_TOKEN.address);

      // Second call should not fetch again
      const token = await service.getTokenByAddress(MOCK_LORDS_TOKEN.address);
      expect(fetchTokenByAddress).toHaveBeenCalledTimes(1);
      expect(token.symbol).toBe("LORDS");
    });

    it("should fetch token by symbol from avnu when not cached", async () => {
      vi.mocked(fetchVerifiedTokenBySymbol).mockResolvedValueOnce(MOCK_ZEND_TOKEN);

      const token = await service.getTokenBySymbol("ZEND");

      expect(fetchVerifiedTokenBySymbol).toHaveBeenCalledWith("ZEND", { baseUrl: "https://starknet.api.avnu.fi" });
      expect(token.address).toContain("0x00585c32b625999e6e5e78645ff8df7a9001cf5cf3eb6b80ccdd16cb64bd3a34");
      expect(token.decimals).toBe(18);
    });

    it("should use resolveSymbolAsync to fetch unknown symbol", async () => {
      vi.mocked(fetchVerifiedTokenBySymbol).mockResolvedValueOnce(MOCK_LORDS_TOKEN);

      const address = await service.resolveSymbolAsync("LORDS");

      expect(address).toContain("0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49");
    });

    it("should not fetch when symbol is already known (static)", async () => {
      const address = await service.resolveSymbolAsync("ETH");

      expect(fetchVerifiedTokenBySymbol).not.toHaveBeenCalled();
      expect(address).toBe("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7");
    });

    it("should get decimals async for unknown token", async () => {
      vi.mocked(fetchTokenByAddress).mockResolvedValueOnce(MOCK_LORDS_TOKEN);

      const decimals = await service.getDecimalsAsync(MOCK_LORDS_TOKEN.address);

      expect(decimals).toBe(18);
    });
  });

  describe("static token protection", () => {
    it("should never overwrite static tokens", async () => {
      const fakeETH = {
        ...MOCK_LORDS_TOKEN,
        address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        symbol: "ETH",
        decimals: 8, // Try to change decimals
      };

      vi.mocked(fetchTokenByAddress).mockResolvedValueOnce(fakeETH);

      const token = await service.getTokenByAddress(fakeETH.address);

      // Should still have original static decimals
      expect(token.decimals).toBe(18);
      expect(token.isStatic).toBe(true);
    });

    it("should not overwrite static token symbol index", async () => {
      const fakeETH = {
        ...MOCK_LORDS_TOKEN,
        symbol: "ETH", // Try to steal ETH symbol
      };

      vi.mocked(fetchTokenByAddress).mockResolvedValueOnce(fakeETH);

      await service.getTokenByAddress(MOCK_LORDS_TOKEN.address);

      // ETH should still resolve to the original address
      expect(service.resolveSymbol("ETH")).toBe("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7");
    });
  });

  describe("TTL expiration", () => {
    it("should re-fetch expired tokens", async () => {
      vi.mocked(fetchTokenByAddress).mockResolvedValue(MOCK_LORDS_TOKEN);

      // First fetch
      await service.getTokenByAddress(MOCK_LORDS_TOKEN.address);
      expect(fetchTokenByAddress).toHaveBeenCalledTimes(1);

      // Simulate time passing beyond TTL
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + TOKEN_TTL_MS + 1000);

      // Second fetch should call avnu again
      await service.getTokenByAddress(MOCK_LORDS_TOKEN.address);
      expect(fetchTokenByAddress).toHaveBeenCalledTimes(2);

      vi.restoreAllMocks();
    });

    it("should never expire static tokens", async () => {
      // Simulate time passing beyond TTL
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + TOKEN_TTL_MS + 1000);

      // Static tokens should still return their decimals
      expect(service.getDecimals("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7")).toBe(18);

      vi.restoreAllMocks();
    });
  });

  describe("cache management", () => {
    it("should clear dynamic cache but keep static tokens", async () => {
      vi.mocked(fetchTokenByAddress).mockResolvedValueOnce(MOCK_LORDS_TOKEN);

      await service.getTokenByAddress(MOCK_LORDS_TOKEN.address);
      expect(service.getCacheSize()).toBe(5); // 4 static + 1 dynamic

      service.clearDynamicCache();

      expect(service.getCacheSize()).toBe(4); // Only static
      expect(service.getTokenInfo("LORDS")).toBeUndefined();
      expect(service.getTokenInfo("ETH")).toBeDefined();
    });
  });

  describe("singleton", () => {
    it("should return same instance", () => {
      resetTokenService();
      const instance1 = getTokenService("https://test.api");
      const instance2 = getTokenService();

      expect(instance1).toBe(instance2);
    });
  });

  describe("on-chain fallback", () => {
    it("should return cached decimals without avnu or on-chain call", async () => {
      // ETH is static, should not call avnu
      const decimals = await service.getDecimalsAsync(
        "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
      );

      expect(decimals).toBe(18);
      expect(fetchTokenByAddress).not.toHaveBeenCalled();
    });

    it("should try avnu before on-chain fallback", async () => {
      vi.mocked(fetchTokenByAddress).mockResolvedValueOnce(MOCK_LORDS_TOKEN);

      const decimals = await service.getDecimalsAsync(MOCK_LORDS_TOKEN.address);

      expect(decimals).toBe(18);
      expect(fetchTokenByAddress).toHaveBeenCalledTimes(1);
    });

    it("should throw if avnu fails and no provider configured", async () => {
      vi.mocked(fetchTokenByAddress).mockRejectedValueOnce(new Error("avnu unavailable"));

      const unknownAddr = "0x0000000000000000000000000000000000000000000000000000000000001234";

      await expect(service.getDecimalsAsync(unknownAddr)).rejects.toThrow(
        "no RPC provider configured"
      );
    });
  });
});
