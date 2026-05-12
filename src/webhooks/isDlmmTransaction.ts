/**
 * Fast filter: is this Helius transaction touching the DLMM program?
 *
 * TrackLP's webhook is configured with `transactionTypes: ['ANY']`
 * (as of 2026-04-07 — `'UNKNOWN'` silently stopped delivering DLMM v2
 * txs that day, killing copy trading for ~24h before we noticed). The
 * `ANY` filter means we receive non-DLMM noise too, so we short-circuit
 * here BEFORE doing any expensive enrichment (Meteora API, Jupiter
 * pricing, DB writes).
 *
 * The check walks top-level instructions AND inner instructions because
 * wrapper programs like Meteora Zap call DLMM via CPI.
 */
import { DLMM_PROGRAM_ID, type HeliusEnhancedTransaction } from './types';

export function isDlmmTransaction(tx: HeliusEnhancedTransaction): boolean {
  if (!tx.instructions || tx.instructions.length === 0) return false;
  return tx.instructions.some(
    (ix) =>
      ix.programId === DLMM_PROGRAM_ID ||
      (ix.innerInstructions ?? []).some(
        (inner) => inner.programId === DLMM_PROGRAM_ID,
      ),
  );
}
