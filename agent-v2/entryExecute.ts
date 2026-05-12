/**
 * Agent V2 — entry execute.
 *
 * This stage reads gate-passed candidate rows from agent_entry_decisions
 * and opens the top N in LLM-rank order (with consensus fallback for
 * un-ranked rows).
 *
 * Unlike the gate stage (entryTick.ts), the SELECT + dispatch loop +
 * idempotent UPDATE is fully implemented here — only the actual
 * "open a position on-chain" part is yours to wire, via the `open`
 * callback. The recommended wiring is to call `executeZapCopyOpen`
 * from this repo's `src/lpAgent/executor.ts`.
 *
 * Idempotency: `entered_position_id` is the dedupe key. Even if you
 * run this stage twice concurrently, a row can only get one open —
 * the UPDATE is conditional on entered_position_id IS NULL.
 */
import { pool } from './db';

export interface PendingDecision {
  id: string;
  poolAddress: string;
  tokenPair: string | null;
  consensusScore: number | null;
  llmRank: number | null;
  llmThesis: string | null;
  llmConfidence: number | null;
  leadersInPool: unknown;
  proposedStrategy: unknown;
  proposedSizeSol: number | null;
}

export interface OpenResult {
  enteredPositionId: string;
}

export interface RunEntryExecuteOpts {
  /**
   * Maximum number of opens to fire in a single tick. Defaults to 1
   * — TrackLP keeps this conservative because the agent's capital is
   * small. Bump if you want to ramp more aggressively.
   */
  maxOpens?: number;

  /**
   * Open a single decision on-chain. The expected wiring:
   *
   *   import { executeZapCopyOpen, serverKeypairSigner } from '@tracklp/lp-agent-integration';
   *
   *   open: async (d) => {
   *     const signer = await serverKeypairSigner(await loadKeypair(d));
   *     const result = await executeZapCopyOpen({
   *       poolAddress: d.poolAddress,
   *       sourcePositionAddress: pickLeaderPosition(d.leadersInPool),
   *       copyAmountSol: d.proposedSizeSol ?? 0.1,
   *       fromBinId, toBinId, strategy, percentX,
   *     }, signer);
   *     return { enteredPositionId: result.positionAddress };
   *   }
   *
   * Throw to mark this decision as failed-open (we leave the row's
   * entered_position_id NULL so it can be retried).
   */
  open: (decision: PendingDecision) => Promise<OpenResult>;
}

export interface RunEntryExecuteResult {
  opened: number;
  skipped: number;
  failed: number;
  reasons: string[];
}

export async function runEntryExecute(
  opts: RunEntryExecuteOpts,
): Promise<RunEntryExecuteResult> {
  const maxOpens = opts.maxOpens ?? 1;

  // Read pending decisions in LLM-rank order, with consensus as the
  // tiebreaker for un-ranked rows. NULLS LAST so ranked rows win.
  const { rows } = await pool.query(
    `SELECT id,
            pool_address,
            token_pair,
            consensus_score,
            llm_rank,
            llm_thesis,
            llm_confidence,
            leaders_in_pool,
            proposed_strategy,
            proposed_size_sol
       FROM agent_entry_decisions
      WHERE decision = 'enter'
        AND entered_position_id IS NULL
      ORDER BY llm_rank ASC NULLS LAST,
               consensus_score DESC NULLS LAST,
               evaluated_at DESC
      LIMIT $1`,
    [maxOpens * 4], // pull 4× and dispatch up to maxOpens; rest may already be claimed by a concurrent tick
  );

  const reasons: string[] = [];
  let opened = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (opened >= maxOpens) {
      skipped++;
      continue;
    }

    const decision: PendingDecision = {
      id: row.id,
      poolAddress: row.pool_address,
      tokenPair: row.token_pair,
      consensusScore: row.consensus_score === null ? null : Number(row.consensus_score),
      llmRank: row.llm_rank,
      llmThesis: row.llm_thesis,
      llmConfidence: row.llm_confidence === null ? null : Number(row.llm_confidence),
      leadersInPool: row.leaders_in_pool,
      proposedStrategy: row.proposed_strategy,
      proposedSizeSol: row.proposed_size_sol === null ? null : Number(row.proposed_size_sol),
    };

    let result: OpenResult;
    try {
      result = await opts.open(decision);
    } catch (error) {
      failed++;
      reasons.push(
        `open ${row.id} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    // Conditional UPDATE — if another tick claimed this row first, we
    // just skip silently. The decision row is the dedupe authority.
    const update = await pool.query(
      `UPDATE agent_entry_decisions
          SET entered_position_id = $1
        WHERE id = $2
          AND decision = 'enter'
          AND entered_position_id IS NULL`,
      [result.enteredPositionId, row.id],
    );

    if ((update.rowCount ?? 0) === 0) {
      skipped++;
      reasons.push(`row ${row.id} already claimed by a concurrent tick`);
      continue;
    }

    opened++;
  }

  return { opened, skipped, failed, reasons };
}
