/**
 * On-chain mint + freeze authority check for a SPL token mint.
 *
 * Layout of the SPL Token mint account (82 bytes):
 *
 *   0..4    mintAuthorityOption  (u32 LE; 1 = authority set, 0 = null)
 *   4..36   mintAuthority pubkey (meaningful only when option = 1)
 *   36..44  supply               (u64 LE)
 *   44      decimals             (u8)
 *   45      isInitialized        (u8)
 *   46..50  freezeAuthorityOption (u32 LE)
 *   50..82  freezeAuthority pubkey
 *
 * Token-2022 (TLV-extended) mints are ≥ 165 bytes but the base mint
 * fields occupy the same first 82 bytes, so the same offsets work.
 *
 * "Disabled" mint authority = the deployer cannot mint more supply.
 * "Disabled" freeze authority = the deployer cannot freeze user tokens.
 * A live mint authority is an instant rug vector (mint infinite, dump).
 * A live freeze authority is a softer but still real rug vector (freeze
 * user balances to prevent selling).
 */
import type { Logger } from '../lpAgent/types';
import { noopLogger } from '../lpAgent/types';

const MINT_AUTHORITY_OPTION_OFFSET = 0;
const FREEZE_AUTHORITY_OPTION_OFFSET = 46;
const REQUEST_TIMEOUT_MS = 6_000;

export interface MintAuthorityStatus {
  /** True iff mintAuthorityOption = 0 (rug-safer). */
  mintDisabled: boolean;
  /** True iff freezeAuthorityOption = 0 (rug-safer). */
  freezeDisabled: boolean;
  /** False when the on-chain fetch failed — caller MUST fail-CLOSED. */
  sourceOk: boolean;
}

export interface GetMintAuthorityOptions {
  /**
   * Full Helius RPC URL (or any Solana RPC). Defaults to
   * `process.env.HELIUS_RPC_URL`.
   */
  rpcUrl?: string;
  logger?: Logger;
}

interface RpcAccountInfoResponse {
  result?: {
    value?: {
      data?: [string, string]; // [base64Data, encoding]
    } | null;
  };
  error?: { message?: string };
}

export async function getMintAuthorityStatus(
  tokenMint: string,
  opts: GetMintAuthorityOptions = {},
): Promise<MintAuthorityStatus> {
  const logger = opts.logger ?? noopLogger;
  const rpcUrl = opts.rpcUrl ?? process.env.HELIUS_RPC_URL;

  const closed: MintAuthorityStatus = {
    mintDisabled: false,
    freezeDisabled: false,
    sourceOk: false,
  };

  if (!rpcUrl) {
    logger.error(
      '[rugProtection.mintAuthority] no RPC URL configured (HELIUS_RPC_URL)',
    );
    return closed;
  }

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'mint-auth',
        method: 'getAccountInfo',
        params: [tokenMint, { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.error(
        `[rugProtection.mintAuthority] HTTP ${res.status} for ${tokenMint.slice(0, 8)}…`,
      );
      return closed;
    }

    const json = (await res.json()) as RpcAccountInfoResponse;
    if (json?.error) {
      logger.error(
        `[rugProtection.mintAuthority] RPC error for ${tokenMint.slice(0, 8)}…: ${json.error.message ?? ''}`,
      );
      return closed;
    }

    const data = json?.result?.value?.data;
    if (!data || !Array.isArray(data) || data.length < 2) {
      logger.error(
        `[rugProtection.mintAuthority] unexpected response shape for ${tokenMint.slice(0, 8)}…`,
      );
      return closed;
    }

    const buf = Buffer.from(data[0], 'base64');
    if (buf.length < 82) {
      logger.error(
        `[rugProtection.mintAuthority] account data too short (${buf.length} bytes) for ${tokenMint.slice(0, 8)}…`,
      );
      return closed;
    }

    const mintOption = buf.readUInt32LE(MINT_AUTHORITY_OPTION_OFFSET);
    const freezeOption = buf.readUInt32LE(FREEZE_AUTHORITY_OPTION_OFFSET);
    return {
      mintDisabled: mintOption === 0,
      freezeDisabled: freezeOption === 0,
      sourceOk: true,
    };
  } catch (error) {
    logger.error(
      `[rugProtection.mintAuthority] fetch failed for ${tokenMint.slice(0, 8)}…: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return closed;
  }
}
