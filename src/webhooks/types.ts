/**
 * Helius Enhanced Webhook payload types.
 *
 * These are the fields we actually use. Helius sends more — see
 * https://docs.helius.dev/webhooks-and-websockets/webhooks for the full
 * shape.
 */

export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

/** What kind of DLMM operation a parsed instruction represents. */
export type DlmmAlertType =
  | 'POSITION_OPEN'
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'POSITION_CLOSE'
  | 'CLAIM_FEE';

export interface HeliusInstruction {
  programId: string;
  accounts: string[];
  /** base58-encoded instruction data. */
  data: string;
  innerInstructions?: HeliusInstruction[];
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
}

export interface HeliusTokenBalanceChange {
  mint: string;
  rawTokenAmount: {
    /** Raw u64 as a string. The delta — negative when wallet sent. */
    tokenAmount: string;
    /** Token decimals — ALWAYS present and reliable. */
    decimals: number;
  };
  tokenAccount: string;
  userAccount: string;
}

export interface HeliusAccountData {
  account: string;
  /** Lamports delta (1 SOL = 1e9 lamports). */
  nativeBalanceChange: number;
  tokenBalanceChanges: HeliusTokenBalanceChange[];
}

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  /**
   * ⚠️ Unreliable for Token-2022 / pump.fun tokens — Helius sometimes
   * returns the RAW (undivided) amount and no decimals field. Prefer
   * `accountData.tokenBalanceChanges` whenever it's populated.
   */
  tokenAmount: number;
  mint: string;
  tokenStandard: string;
}

export interface HeliusEnhancedTransaction {
  signature: string;
  /** Unix seconds. */
  timestamp: number;
  slot: number;
  fee: number;
  feePayer: string;
  instructions: HeliusInstruction[];
  accountData?: HeliusAccountData[];
  tokenTransfers?: HeliusTokenTransfer[];
  type?: string;
  source?: string;
  description?: string;
}

/** Output of `extractTokenAmounts` — wallet-relative token deltas. */
export interface ExtractedTokenAmounts {
  /** Mint → signed human-readable amount (negative = sent, positive = received). */
  byMint: Record<string, number>;
  /** Same data flattened in mint order. Order is insertion order. */
  transfers: Array<{ mint: string; amount: number }>;
}
