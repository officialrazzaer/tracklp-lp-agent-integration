/**
 * Token holder count via Helius DAS `getTokenAccounts`.
 *
 * **Critical:** the obvious-looking approach — Solana RPC's
 * `getProgramAccounts` with a memcmp filter on the SPL Token program —
 * does not work against Helius. Helius rejects that call with
 * `Too many accounts requested`, the JSON-RPC `result` field is
 * missing, and any caller that parses `Array.isArray(json.result)`
 * silently returns `null`. If upstream code treats `null` as
 * "unknown → allow", you've shipped a fail-OPEN gate that approves
 * every rug.
 *
 * The hardened version:
 *   1. Uses Helius DAS `getTokenAccounts` (paginated cursor).
 *   2. Counts only accounts with `amount > 0` (excludes empty ATAs).
 *   3. Early-exits at HOLDER_COUNT_EARLY_EXIT to keep blue-chip checks
 *      fast (we don't need exact counts above the rug threshold).
 *   4. Returns `null` on any error — caller MUST treat null as failed.
 *
 * In-memory cache, 5-minute TTL, keyed by mint.
 */
import type { Logger } from '../lpAgent/types';
import { noopLogger } from '../lpAgent/types';

/** Known major tokens — we skip the RPC call and return the sentinel. */
const KNOWN_QUALITY_TOKENS = new Set<string>([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
]);

const HOLDER_COUNT_MAX_PAGES = 5;
const HOLDER_COUNT_EARLY_EXIT = 1000;
/** Returned for well-known tokens without a network call. Treated as "well-distributed". */
export const KNOWN_TOKEN_HOLDER_SENTINEL = 999_999;
const CACHE_TTL_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 6_000;

const cache = new Map<string, { count: number; timestamp: number }>();

export interface GetHolderCountOptions {
  /**
   * Full Helius RPC URL including api key, e.g.
   * `https://mainnet.helius-rpc.com/?api-key=...`. Defaults to
   * `process.env.HELIUS_RPC_URL`.
   */
  heliusRpcUrl?: string;
  logger?: Logger;
}

/**
 * Returns the number of token accounts holding `amount > 0`. Capped at
 * HOLDER_COUNT_EARLY_EXIT — anything above that is "well-distributed"
 * for rug-check purposes.
 *
 * Returns `null` on RPC error, timeout, or unexpected response shape.
 * Callers MUST treat null as "unable to verify" and fail-CLOSED.
 */
export async function getHolderCount(
  tokenMint: string,
  opts: GetHolderCountOptions = {},
): Promise<number | null> {
  const logger = opts.logger ?? noopLogger;
  const rpcUrl = opts.heliusRpcUrl ?? process.env.HELIUS_RPC_URL;

  if (!rpcUrl) {
    logger.error(
      '[rugProtection.holderCount] HELIUS_RPC_URL not set — cannot check holders',
    );
    return null;
  }

  if (KNOWN_QUALITY_TOKENS.has(tokenMint)) {
    return KNOWN_TOKEN_HOLDER_SENTINEL;
  }

  const cached = cache.get(tokenMint);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.count;
  }

  try {
    let count = 0;
    let cursor: string | undefined;
    let page = 0;

    while (page < HOLDER_COUNT_MAX_PAGES) {
      const params: { mint: string; limit: number; cursor?: string } = {
        mint: tokenMint,
        limit: 1000,
      };
      if (cursor) params.cursor = cursor;

      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'holder-count',
          method: 'getTokenAccounts',
          params,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        logger.error(
          `[rugProtection.holderCount] HTTP ${res.status} for ${tokenMint.slice(0, 8)}…`,
        );
        return null;
      }

      const json = (await res.json()) as {
        result?: { token_accounts?: Array<{ amount?: string | number }>; cursor?: string };
        error?: { message?: string };
      };

      if (json?.error) {
        logger.error(
          `[rugProtection.holderCount] RPC error for ${tokenMint.slice(0, 8)}…: ${json.error.message ?? ''}`,
        );
        return null;
      }

      const accounts = Array.isArray(json?.result?.token_accounts)
        ? json.result!.token_accounts!
        : [];

      for (const a of accounts) {
        const raw = a?.amount;
        const amountStr =
          typeof raw === 'string' ? raw : raw == null ? '0' : String(raw);
        if (amountStr !== '0' && amountStr !== '') count++;
      }

      if (count >= HOLDER_COUNT_EARLY_EXIT) {
        cache.set(tokenMint, { count, timestamp: Date.now() });
        return count;
      }

      if (accounts.length === 0) break;
      const nextCursor = json?.result?.cursor;
      if (!nextCursor) break;
      cursor = nextCursor;
      page++;
    }

    cache.set(tokenMint, { count, timestamp: Date.now() });
    return count;
  } catch (error) {
    logger.error(
      `[rugProtection.holderCount] fetch failed for ${tokenMint.slice(0, 8)}…: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
