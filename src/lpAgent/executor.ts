/**
 * Server-side custodial Zap executor.
 *
 * This is the pattern TrackLP ships in production: a user clicks
 * "Zap-copy" on a leader's open position, the server uses LP Agent's
 * Zap-in API to build the transactions, signs them with the user's
 * server-held custodial copy-wallet keypair, then lands the bundle via
 * Jito. Same shape on close — generate → sign → land.
 *
 * The module is signer-agnostic: pass a `Signer` (see types) and the
 * executor handles the orchestration. For the canonical server-keypair
 * case there's a `serverKeypairSigner(keypair)` factory in this file
 * that bundles the decode/sign/encode loop.
 *
 * Browser flow (non-custodial Phantom etc.) is also supported — pass a
 * signer whose `signAll()` defers to a wallet-adapter call. The
 * executor doesn't care.
 *
 * What this module does NOT include:
 *   • Encrypted keypair storage (per-user AES-GCM with userId-bound KDF)
 *     — that's how TrackLP backs `serverKeypairSigner` in production but
 *     the encryption layer is product-specific. Plug in your own.
 *   • Audit logging — supply `onExecutionRecord` to persist however you
 *     like (we use a Supabase table called `copy_trade_executions`).
 *   • SOL-only / rug-protection gating — apply those checks before
 *     calling the executor.
 */

import type {
  GenerateZapInResult,
  LandZapInResult,
  GenerateZapOutResult,
  LandZapOutResult,
  ZapStrategy,
  Logger,
} from './types';
import { noopLogger } from './types';
import {
  generateZapInTx,
  landZapInTx,
  generateZapOutTx,
  landZapOutTx,
} from './zap';

// --- Signer interface ---

/**
 * Minimal signing capability the executor needs. Any wallet, custodial
 * or non-custodial, that can sign a base64-serialized VersionedTransaction
 * fits.
 *
 * Implementations:
 *   • `serverKeypairSigner(keypair)` — wraps a server-held @solana/web3.js
 *     Keypair (the TrackLP production pattern)
 *   • A wallet-adapter wrapper — let the user sign in Phantom via
 *     signAllTransactions
 *   • An HSM / MPC service client — sign over the network
 */
export interface Signer {
  /** Owner address (base58) that the LP Agent endpoints will use. */
  publicKey: string;
  /**
   * Sign every supplied base64-serialized VersionedTransaction and return
   * the signed bytes in the same order. The order MUST be preserved —
   * LP Agent's landing endpoint expects swap and add-liquidity arrays
   * separately and the executor zips signed output back into those arrays.
   */
  signAll(serializedTxsB64: string[]): Promise<string[]>;
}

/**
 * Build a Signer from a server-held @solana/web3.js Keypair.
 *
 * This is the canonical custodial pattern. In production, TrackLP loads
 * the keypair from an AES-GCM-encrypted column on `copy_trading_wallets`,
 * keyed by user id (defense-in-depth) and audit-logs every decrypt. The
 * encryption layer is application-specific — wrap your decrypted keypair
 * with this helper and the executor takes it from there.
 *
 * Lazy-imports @solana/web3.js so callers who only need the wrapper
 * functions don't pay the bundle cost.
 */
export async function serverKeypairSigner(
  // We accept `unknown` for the keypair to avoid forcing the consumer's
  // @solana/web3.js version to match ours. Duck-typed at call time.
  keypair: { publicKey: { toBase58(): string }; secretKey: Uint8Array },
): Promise<Signer> {
  const { VersionedTransaction } = await import('@solana/web3.js');
  return {
    publicKey: keypair.publicKey.toBase58(),
    async signAll(serializedTxsB64) {
      return serializedTxsB64.map((b64) => {
        const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
        // @solana/web3.js Keypair satisfies the Signer shape tx.sign expects.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx.sign([keypair as any]);
        return Buffer.from(tx.serialize()).toString('base64');
      });
    },
  };
}

// --- Execution-record hook (optional consumer-side audit) ---

export interface ExecutionRecord {
  readonly action: 'OPEN' | 'CLOSE';
  readonly status: 'confirmed' | 'failed';
  readonly transactionSignature?: string;
  readonly owner: string;
  readonly poolAddress: string;
  readonly sourcePositionAddress: string;
  readonly copyAmountSol?: number;
  readonly errorMessage?: string;
}

export type ExecutionRecordHook = (record: ExecutionRecord) => Promise<void>;

// --- Zap-copy open ---

export interface ExecuteZapCopyInput {
  /** Pool the leader's position lives in. */
  poolAddress: string;
  /** Solana account address of the leader's position (for audit only). */
  sourcePositionAddress: string;
  /** SOL amount to deposit on behalf of the signer. */
  copyAmountSol: number;
  /** Leader's bin range, mirrored exactly. */
  fromBinId: number;
  toBinId: number;
  /** Leader's detected strategy. */
  strategy: ZapStrategy;
  /**
   * Capital allocation to token X, in [0, 1]. REQUIRED by LP Agent
   * alongside `inputSOL`. For SOL-only deposits it's binary:
   *   SOL is token X → 1
   *   SOL is token Y → 0
   * For mixed deposits, pass the leader's token-X ratio.
   */
  percentX: number;
  /** Default 500 (5%). */
  slippageBps?: number;
}

export interface ZapCopyResult {
  status: 'confirmed' | 'failed';
  transactionSignature?: string;
  error?: string;
}

export async function executeZapCopyOpen(
  input: ExecuteZapCopyInput,
  signer: Signer,
  options: {
    logger?: Logger;
    onExecutionRecord?: ExecutionRecordHook;
  } = {},
): Promise<ZapCopyResult> {
  const log = options.logger ?? noopLogger;
  let generated: GenerateZapInResult | null = null;
  let landed: LandZapInResult | null = null;

  try {
    // 1. Build unsigned Zap-in transactions.
    generated = await generateZapInTx({
      poolAddress: input.poolAddress,
      owner: signer.publicKey,
      inputSOL: input.copyAmountSol,
      percentX: input.percentX,
      fromBinId: input.fromBinId,
      toBinId: input.toBinId,
      strategy: input.strategy,
      slippageBps: input.slippageBps,
    });

    // 2. Hand the base64 arrays to the signer.
    //    Concat-then-split keeps the signer agnostic to the swap/add
    //    distinction; LP Agent rebuilds the bundle on the landing call.
    const swapCount = generated.swapTxsWithJito?.length ?? 0;
    const all = [
      ...(generated.swapTxsWithJito ?? []),
      ...generated.addLiquidityTxsWithJito,
    ];
    const signed = await signer.signAll(all);
    const signedSwap = signed.slice(0, swapCount);
    const signedAdd = signed.slice(swapCount);

    // 3. Land via Jito.
    landed = await landZapInTx({
      lastValidBlockHeight: generated.lastValidBlockHeight,
      swapTxsWithJito: signedSwap,
      addLiquidityTxsWithJito: signedAdd,
      meta: generated.meta ?? {},
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Zap-copy failed';
    log.error(`[executeZapCopyOpen] ${message}`);
    try {
      await options.onExecutionRecord?.({
        action: 'OPEN',
        status: 'failed',
        owner: signer.publicKey,
        poolAddress: input.poolAddress,
        sourcePositionAddress: input.sourcePositionAddress,
        copyAmountSol: input.copyAmountSol,
        errorMessage: message,
      });
    } catch (hookErr) {
      log.warn(
        `[executeZapCopyOpen] execution-record hook failed: ${
          hookErr instanceof Error ? hookErr.message : String(hookErr)
        }`,
      );
    }
    return { status: 'failed', error: message };
  }

  // 4. The on-chain trade has landed. The audit hook errors below are
  //    logged but never fail the overall result — the trade is final.
  try {
    await options.onExecutionRecord?.({
      action: 'OPEN',
      status: 'confirmed',
      transactionSignature: landed.signature,
      owner: signer.publicKey,
      poolAddress: input.poolAddress,
      sourcePositionAddress: input.sourcePositionAddress,
      copyAmountSol: input.copyAmountSol,
    });
  } catch (hookErr) {
    log.warn(
      `[executeZapCopyOpen] execution-record hook failed: ${
        hookErr instanceof Error ? hookErr.message : String(hookErr)
      }`,
    );
  }

  return {
    status: 'confirmed',
    transactionSignature: landed.signature,
  };
}

// --- Zap-out close ---

export interface ExecuteZapCloseInput {
  /** Pool the position lives in (for audit only). */
  poolAddress: string;
  /** Solana account address of the position (for audit only). */
  sourcePositionAddress: string;
  /**
   * LP Agent's encrypted position id. Resolve it by calling
   * /lp-positions/opening?owner=<signer.publicKey> via LPAgentClient
   * (`getWalletOpeningRaw`) and matching by `positionAddress`.
   */
  positionId: string;
  /** Basis points to withdraw, 1-10000. Default 10000 (full close). */
  bps?: number;
  /** Default 500 (5%). */
  slippageBps?: number;
  /** Default 'allBaseToken' (collapse remaining liquidity into SOL). */
  output?: 'allToken0' | 'allToken1' | 'both' | 'allBaseToken';
}

export async function executeZapCloseOpen(
  input: ExecuteZapCloseInput,
  signer: Signer,
  options: {
    logger?: Logger;
    onExecutionRecord?: ExecutionRecordHook;
  } = {},
): Promise<ZapCopyResult> {
  const log = options.logger ?? noopLogger;
  let generated: GenerateZapOutResult | null = null;
  let landed: LandZapOutResult | null = null;

  try {
    generated = await generateZapOutTx({
      positionId: input.positionId,
      owner: signer.publicKey,
      bps: input.bps ?? 10000,
      slippageBps: input.slippageBps ?? 500,
      output: input.output ?? 'allBaseToken',
    });

    const closeCount = generated.closeTxsWithJito?.length ?? 0;
    const all = [
      ...generated.closeTxsWithJito,
      ...(generated.swapTxsWithJito ?? []),
    ];
    const signed = await signer.signAll(all);
    const signedClose = signed.slice(0, closeCount);
    const signedSwap = signed.slice(closeCount);

    landed = await landZapOutTx({
      lastValidBlockHeight: generated.lastValidBlock,
      closeTxsWithJito: signedClose,
      swapTxsWithJito: signedSwap,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Zap-close failed';
    log.error(`[executeZapCloseOpen] ${message}`);
    try {
      await options.onExecutionRecord?.({
        action: 'CLOSE',
        status: 'failed',
        owner: signer.publicKey,
        poolAddress: input.poolAddress,
        sourcePositionAddress: input.sourcePositionAddress,
        errorMessage: message,
      });
    } catch (hookErr) {
      log.warn(
        `[executeZapCloseOpen] execution-record hook failed: ${
          hookErr instanceof Error ? hookErr.message : String(hookErr)
        }`,
      );
    }
    return { status: 'failed', error: message };
  }

  try {
    await options.onExecutionRecord?.({
      action: 'CLOSE',
      status: 'confirmed',
      transactionSignature: landed.signature,
      owner: signer.publicKey,
      poolAddress: input.poolAddress,
      sourcePositionAddress: input.sourcePositionAddress,
    });
  } catch (hookErr) {
    log.warn(
      `[executeZapCloseOpen] execution-record hook failed: ${
        hookErr instanceof Error ? hookErr.message : String(hookErr)
      }`,
    );
  }

  return {
    status: 'confirmed',
    transactionSignature: landed.signature,
  };
}
