/**
 * Wallet-relative token deltas from a Helius Enhanced Transaction.
 *
 * **Why this exists.** Helius's `tokenTransfers[].tokenAmount` field
 * is unreliable for Token-2022 / pump.fun tokens — it sometimes
 * returns the RAW (undivided) amount with no decimals field, which
 * inflates downstream USD math by orders of magnitude.
 *
 * The fix: prefer `accountData[].tokenBalanceChanges`, which always
 * includes an explicit `decimals` field. Only fall back to
 * `tokenTransfers` when accountData is empty.
 *
 * Also handles native SOL: DLMM mixed deposits transfer SOL via wrapped
 * SOL accounts which may not appear in tokenBalanceChanges for the
 * wallet itself. We supplement from the wallet's `nativeBalanceChange`
 * when the wrapped-SOL line is missing and the change is meaningful
 * (≥ 0.01 SOL, to ignore rent + fees).
 */
import type {
  ExtractedTokenAmounts,
  HeliusAccountData,
  HeliusEnhancedTransaction,
  HeliusTokenTransfer,
} from './types';

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const MIN_NATIVE_SOL_DELTA = 0.01;

/**
 * Returns net token movement for `walletAddress` across this
 * transaction. Amounts are signed: negative = wallet sent, positive =
 * wallet received.
 *
 * Returns an empty result if there's no signal — caller decides whether
 * that's a parse failure or a normal pass-through.
 */
export function extractTokenAmounts(
  tx: HeliusEnhancedTransaction,
  walletAddress: string,
): ExtractedTokenAmounts {
  const fromBalanceChanges = extractFromBalanceChanges(
    tx.accountData ?? [],
    walletAddress,
  );
  if (fromBalanceChanges && Object.keys(fromBalanceChanges.byMint).length > 0) {
    return fromBalanceChanges;
  }
  // accountData was empty — fall back to the unreliable source.
  return extractFromTokenTransfers(tx.tokenTransfers ?? [], walletAddress);
}

function extractFromBalanceChanges(
  accountData: HeliusAccountData[],
  walletAddress: string,
): ExtractedTokenAmounts | null {
  if (accountData.length === 0) return null;

  const byMint = new Map<string, number>();

  for (const account of accountData) {
    if (!account.tokenBalanceChanges) continue;
    for (const change of account.tokenBalanceChanges) {
      if (change.userAccount !== walletAddress) continue;
      try {
        const raw = BigInt(change.rawTokenAmount.tokenAmount);
        const decimals = change.rawTokenAmount.decimals;
        // Convert to human-readable via Number — fine for DLMM-sized amounts
        // (raw u64 / 10^decimals stays well inside safe-integer range for SPL
        // tokens with typical decimals 6-9). For exotic-precision tokens,
        // swap in Decimal.js externally.
        const human = Number(raw) / Math.pow(10, decimals);
        byMint.set(change.mint, (byMint.get(change.mint) ?? 0) + human);
      } catch {
        continue;
      }
    }
  }

  // Supplement: native SOL change on the wallet's own account (DLMM
  // mixed-deposit case).
  const walletAccount = accountData.find((a) => a.account === walletAddress);
  if (walletAccount && walletAccount.nativeBalanceChange !== 0) {
    const solChange = walletAccount.nativeBalanceChange / 1e9;
    const existing = byMint.get(WRAPPED_SOL_MINT);
    if (existing === undefined && Math.abs(solChange) >= MIN_NATIVE_SOL_DELTA) {
      byMint.set(WRAPPED_SOL_MINT, solChange);
    }
  }

  if (byMint.size === 0) return null;
  return materialize(byMint);
}

function extractFromTokenTransfers(
  transfers: HeliusTokenTransfer[],
  walletAddress: string,
): ExtractedTokenAmounts {
  const wallet = transfers.filter(
    (t) =>
      t.fromUserAccount === walletAddress ||
      t.toUserAccount === walletAddress,
  );
  if (wallet.length === 0) return { byMint: {}, transfers: [] };

  const byMint = new Map<string, number>();
  for (const t of wallet) {
    const current = byMint.get(t.mint) ?? 0;
    const signed = t.toUserAccount === walletAddress ? t.tokenAmount : -t.tokenAmount;
    byMint.set(t.mint, current + signed);
  }

  return materialize(byMint);
}

function materialize(byMint: Map<string, number>): ExtractedTokenAmounts {
  const transfers = [...byMint.entries()].map(([mint, amount]) => ({ mint, amount }));
  const out: Record<string, number> = {};
  for (const [mint, amount] of byMint) out[mint] = amount;
  return { byMint: out, transfers };
}
