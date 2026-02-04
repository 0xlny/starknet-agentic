/**
 * Utility functions for Starknet MCP Server
 */

import { validateAndParseAddress } from "starknet";
import { getTokenService } from "./services/index.js";

/**
 * Maximum number of tokens that can be queried in a single batch balance request.
 * Limited by BalanceChecker contract capacity.
 */
export const MAX_BATCH_TOKENS = 200;

/**
 * Resolve token symbol to contract address.
 * Accepts well-known symbols (ETH, STRK, USDC, USDT) case-insensitively,
 * or any hex address string.
 *
 * Delegates to TokenService internally.
 *
 * @param token - Token symbol (case-insensitive) or contract address (0x...)
 * @returns Normalized contract address
 * @throws Error if token symbol is unknown and not a valid hex address
 *
 * @example
 * ```typescript
 * resolveTokenAddress("ETH")    // → "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
 * resolveTokenAddress("eth")    // → "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
 * resolveTokenAddress("0x123")  // → "0x0...0123" (normalized)
 * resolveTokenAddress("UNKNOWN") // → throws Error
 * ```
 */
export function resolveTokenAddress(token: string): string {
  return getTokenService().resolveSymbol(token);
}

/**
 * Resolve token symbol to contract address asynchronously.
 * For unknown symbols, fetches from avnu SDK.
 *
 * @param token - Token symbol (case-insensitive) or contract address (0x...)
 * @returns Normalized contract address
 * @throws Error if token cannot be resolved
 */
export async function resolveTokenAddressAsync(token: string): Promise<string> {
  return getTokenService().resolveSymbolAsync(token);
}

/**
 * Normalize a Starknet address to lowercase with 0x prefix and 64 hex characters.
 * Uses starknet.js validateAndParseAddress which validates and pads the address.
 *
 * @param address - Raw Starknet address (may be short or uppercase)
 * @returns Normalized address (0x + 64 lowercase hex chars)
 * @throws Error if address is invalid
 *
 * @example
 * ```typescript
 * normalizeAddress("0x123")     // → "0x0000...0123" (64 chars)
 * normalizeAddress("0x49D3...")  // → "0x049d..." (lowercase)
 * ```
 */
export function normalizeAddress(address: string): string {
  return validateAndParseAddress(address).toLowerCase();
}

/**
 * Get cached decimal value for a known token address.
 * Returns undefined for unknown tokens - caller should use getDecimalsAsync.
 *
 * Delegates to TokenService internally.
 *
 * @param tokenAddress - Token contract address
 * @returns Token decimals (e.g., 18 for ETH) or undefined if not cached
 *
 * @example
 * ```typescript
 * getCachedDecimals(TOKENS.ETH)     // → 18
 * getCachedDecimals(TOKENS.USDC)    // → 6
 * getCachedDecimals("0xunknown")    // → undefined
 * ```
 */
export function getCachedDecimals(tokenAddress: string): number | undefined {
  return getTokenService().getDecimals(tokenAddress);
}

/**
 * Get decimals for a token address asynchronously.
 * For unknown tokens, fetches from avnu SDK.
 *
 * @param tokenAddress - Token contract address
 * @returns Token decimals
 */
export async function getDecimalsAsync(tokenAddress: string): Promise<number> {
  return getTokenService().getDecimalsAsync(tokenAddress);
}

/**
 * Validate and resolve tokens input for batch balance queries.
 * Checks for empty array, max tokens limit, and duplicates.
 *
 * @param tokens - Array of token symbols or addresses
 * @returns Array of resolved token addresses
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * validateTokensInput(["ETH", "USDC"])  // → ["0x049d...", "0x053c..."]
 * validateTokensInput([])               // → throws "At least one token is required"
 * validateTokensInput(["ETH", "ETH"])   // → throws "Duplicate tokens in request"
 * ```
 */
export function validateTokensInput(tokens: string[] | undefined): string[] {
  if (!tokens || tokens.length === 0) {
    throw new Error("At least one token is required");
  }
  if (tokens.length > MAX_BATCH_TOKENS) {
    throw new Error(`Maximum ${MAX_BATCH_TOKENS} tokens per request`);
  }
  const tokenAddresses = tokens.map(resolveTokenAddress);
  // resolveTokenAddress already returns normalized addresses, so we can check directly
  if (new Set(tokenAddresses).size !== tokens.length) {
    throw new Error("Duplicate tokens in request");
  }
  return tokenAddresses;
}
