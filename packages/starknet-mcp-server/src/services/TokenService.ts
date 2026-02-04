/**
 * Token Service for Starknet MCP Server.
 * Manages token resolution and caching.
 */

import {
  fetchTokenByAddress,
  fetchVerifiedTokenBySymbol,
  type Token,
} from "@avnu/avnu-sdk";
import { Contract, type RpcProvider } from "starknet";
import { type CachedToken, TOKEN_TTL_MS } from "../types/token.js";
import { normalizeAddress } from "../utils.js";

const ERC20_DECIMALS_ABI = [
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ name: "decimals", type: "felt" }],
    stateMutability: "view",
  },
];

/** Static token defaults - shared by all static tokens */
const STATIC_TOKEN_DEFAULTS = {
  logoUri: null,
  lastDailyVolumeUsd: 0,
  tags: ["Verified"] as const,
  extensions: {},
  isStatic: true,
  lastUpdated: 0,
} as const;

/** Core token data - only the fields that differ per token */
const STATIC_TOKEN_DATA = [
  { address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", symbol: "ETH", name: "Ether", decimals: 18 },
  { address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", symbol: "STRK", name: "Starknet Token", decimals: 18 },
  { address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8", symbol: "USDC", name: "USD Coin", decimals: 6 },
  { address: "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8", symbol: "USDT", name: "Tether USD", decimals: 6 },
] as const;

/**
 * Static token definitions - these always take precedence and never expire.
 * Single source of truth for token addresses and decimals.
 */
export const STATIC_TOKENS: CachedToken[] = STATIC_TOKEN_DATA.map((token) => ({
  ...STATIC_TOKEN_DEFAULTS,
  ...token,
}));

/**
 * Token addresses indexed by symbol for easy access.
 */
export const TOKENS = Object.fromEntries(
  STATIC_TOKENS.map((t) => [t.symbol, t.address])
) as Record<"ETH" | "STRK" | "USDC" | "USDT", string>;

/**
 * Check if a cached token has expired (TTL 24h).
 * Static tokens never expire.
 */
function isExpired(token: CachedToken): boolean {
  if (token.isStatic) return false;
  return Date.now() - token.lastUpdated > TOKEN_TTL_MS;
}

/**
 * Convert an avnu Token to a CachedToken.
 */
function toCachedToken(token: Token, isStatic: boolean): CachedToken {
  return {
    ...token,
    address: normalizeAddress(token.address),
    isStatic,
    lastUpdated: Date.now(),
  };
}

/**
 * TokenService manages token resolution and caching.
 * Uses avnu SDK for lazy fetching of unknown tokens.
 */
export class TokenService {
  /** Token cache by normalized address */
  private cache: Map<string, CachedToken> = new Map();
  /** Symbol to address index for fast lookup */
  private symbolIndex: Map<string, string> = new Map();
  /** avnu API base URL */
  private baseUrl: string;
  /** RPC provider for on-chain fallback */
  private provider: RpcProvider | null = null;

  constructor(baseUrl: string = "https://starknet.api.avnu.fi") {
    this.baseUrl = baseUrl;
    this.loadStaticTokens();
  }

  /**
   * Set the RPC provider for on-chain fallback when avnu is unavailable.
   */
  setProvider(provider: RpcProvider): void {
    this.provider = provider;
  }

  /**
   * Load static tokens into cache.
   */
  private loadStaticTokens(): void {
    for (const token of STATIC_TOKENS) {
      const normalized = normalizeAddress(token.address);
      this.cache.set(normalized, { ...token, address: normalized });
      this.symbolIndex.set(token.symbol.toUpperCase(), normalized);
    }
  }

  /**
   * Add a token to cache. Never overwrites static tokens.
   */
  private addToCache(token: Token, isStatic: boolean): CachedToken {
    const normalized = normalizeAddress(token.address);

    // Never overwrite static tokens
    const existing = this.cache.get(normalized);
    if (existing?.isStatic) {
      return existing;
    }

    const cached = toCachedToken(token, isStatic);
    cached.address = normalized;
    this.cache.set(normalized, cached);

    // Only index symbol if not already taken by a static token
    const upperSymbol = token.symbol.toUpperCase();
    const existingAddr = this.symbolIndex.get(upperSymbol);
    if (!existingAddr || !this.cache.get(existingAddr)?.isStatic) {
      this.symbolIndex.set(upperSymbol, normalized);
    }

    return cached;
  }

  // ============================================
  // SYNCHRONOUS METHODS (cache only)
  // ============================================

  /**
   * Resolve token symbol or address to normalized address.
   * Synchronous - only checks cache.
   * @throws Error if symbol not found in cache and not a hex address
   */
  resolveSymbol(symbolOrAddress: string): string {
    const upper = symbolOrAddress.toUpperCase();

    // Check symbol index first
    const indexed = this.symbolIndex.get(upper);
    if (indexed) {
      return indexed;
    }

    // If it's a hex address, normalize and return
    if (symbolOrAddress.startsWith("0x")) {
      return normalizeAddress(symbolOrAddress);
    }

    throw new Error(`Unknown token: ${symbolOrAddress}`);
  }

  /**
   * Get cached decimals for a token.
   * Returns undefined if not in cache.
   */
  getDecimals(address: string): number | undefined {
    const normalized = normalizeAddress(address);
    const cached = this.cache.get(normalized);
    if (!cached || isExpired(cached)) {
      return undefined;
    }
    return cached.decimals;
  }

  /**
   * Get cached token info.
   * Returns undefined if not in cache or expired.
   */
  getTokenInfo(addressOrSymbol: string): CachedToken | undefined {
    let normalized: string;

    if (addressOrSymbol.startsWith("0x")) {
      normalized = normalizeAddress(addressOrSymbol);
    } else {
      const addr = this.symbolIndex.get(addressOrSymbol.toUpperCase());
      if (!addr) return undefined;
      normalized = addr;
    }

    const cached = this.cache.get(normalized);
    if (!cached || isExpired(cached)) {
      return undefined;
    }
    return cached;
  }

  // ============================================
  // ASYNCHRONOUS METHODS (with avnu fetch)
  // ============================================

  /**
   * Get token by address, fetching from avnu if not cached or expired.
   */
  async getTokenByAddress(address: string): Promise<CachedToken> {
    const normalized = normalizeAddress(address);
    const cached = this.cache.get(normalized);

    // Return cached if valid and not expired
    if (cached && !isExpired(cached)) {
      return cached;
    }

    // Fetch from avnu
    try {
      const token = await fetchTokenByAddress(address, { baseUrl: this.baseUrl });
      return this.addToCache(token, false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch token by address ${address}: ${msg}`);
    }
  }

  /**
   * Get token by symbol, fetching from avnu if not cached or expired.
   * Only fetches verified tokens from avnu.
   */
  async getTokenBySymbol(symbol: string): Promise<CachedToken> {
    const upper = symbol.toUpperCase();
    const addr = this.symbolIndex.get(upper);

    if (addr) {
      const cached = this.cache.get(addr);
      if (cached && !isExpired(cached)) {
        return cached;
      }
    }

    // Fetch from avnu (verified tokens only)
    try {
      const token = await fetchVerifiedTokenBySymbol(symbol, { baseUrl: this.baseUrl });
      return this.addToCache(token, false);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch token by symbol "${symbol}": ${msg}`);
    }
  }

  /**
   * Resolve symbol or address asynchronously.
   * Fetches from avnu if symbol not in cache.
   */
  async resolveSymbolAsync(symbolOrAddress: string): Promise<string> {
    // Try sync first
    try {
      return this.resolveSymbol(symbolOrAddress);
    } catch {
      // If not a hex address, try fetching from avnu
      if (!symbolOrAddress.startsWith("0x")) {
        const token = await this.getTokenBySymbol(symbolOrAddress);
        return token.address;
      }
      throw new Error(`Unknown token: ${symbolOrAddress}`);
    }
  }

  /**
   * Get decimals asynchronously.
   * Tries: cache → avnu → on-chain (if provider set).
   * Results are cached to avoid repeated calls.
   */
  async getDecimalsAsync(address: string): Promise<number> {
    const cached = this.getDecimals(address);
    if (cached !== undefined) {
      return cached;
    }

    // Try avnu first
    try {
      const token = await this.getTokenByAddress(address);
      return token.decimals;
    } catch {
      // Fall back to on-chain if provider available
      if (!this.provider) {
        throw new Error(`Token ${address} not found and no RPC provider configured for on-chain fallback`);
      }

      const contract = new Contract({
        abi: ERC20_DECIMALS_ABI,
        address,
        providerOrAccount: this.provider,
      });
      const result = await contract.decimals();
      const decimals = Number(result?.decimals ?? result);

      this.cacheOnChainDecimals(address, decimals);
      return decimals;
    }
  }

  /**
   * Cache decimals fetched from on-chain call.
   * Creates a minimal token entry for unknown tokens.
   */
  private cacheOnChainDecimals(address: string, decimals: number): void {
    const normalized = normalizeAddress(address);

    // Don't overwrite existing cache entries
    if (this.cache.has(normalized)) return;

    const shortAddr = `${normalized.slice(0, 10)}...${normalized.slice(-6)}`;
    const cached: CachedToken = {
      address: normalized,
      symbol: shortAddr,
      name: "Unknown Token",
      decimals,
      logoUri: null,
      lastDailyVolumeUsd: 0,
      tags: [],
      extensions: {},
      isStatic: false,
      lastUpdated: Date.now(),
    };
    this.cache.set(normalized, cached);
  }

  /**
   * Get full token info asynchronously, fetching from avnu if not cached.
   */
  async getTokenInfoAsync(addressOrSymbol: string): Promise<CachedToken> {
    if (addressOrSymbol.startsWith("0x")) {
      return this.getTokenByAddress(addressOrSymbol);
    }
    return this.getTokenBySymbol(addressOrSymbol);
  }

  // ============================================
  // CACHE MANAGEMENT
  // ============================================

  /**
   * Clear all non-static tokens from cache.
   */
  clearDynamicCache(): void {
    for (const [addr, token] of this.cache) {
      if (!token.isStatic) {
        this.cache.delete(addr);
      }
    }

    for (const [symbol, addr] of this.symbolIndex) {
      if (!this.cache.has(addr)) {
        this.symbolIndex.delete(symbol);
      }
    }
  }

  /**
   * Get all cached tokens (for debugging/inspection).
   */
  getAllCached(): CachedToken[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get cache size.
   */
  getCacheSize(): number {
    return this.cache.size;
  }
}
