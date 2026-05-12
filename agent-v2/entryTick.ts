/**
 * Agent V2 — entry tick.
 *
 * This is the STAGE that runs your V1 deterministic gate logic and
 * writes candidate rows to `agent_entry_decisions`. It runs upstream
 * of the LLM ranker and the executor.
 *
 * In TrackLP it's wrapped in an Inngest function on a 1-minute cron;
 * in this reference it's a plain async function so you can wire it
 * to whatever scheduler you use (node-cron, Inngest, GitHub Actions,
 * a Vercel cron, etc.).
 *
 * The gate logic itself stays in TrackLP's private codebase — it's
 * tightly coupled to our wallet scoring + copier detection. What you
 * need to implement:
 *
 *   1. For each candidate pool you're watching, decide enter/skip.
 *   2. INSERT one row into agent_entry_decisions per evaluation
 *      (whether you entered, skipped, or hit a circuit breaker).
 *   3. Set decision='enter' and proposed_strategy / proposed_size_sol
 *      for rows you want the LLM + executor to actually open.
 *
 * The schema is in agent-v2/schema.sql — `decision`, `skip_reason`,
 * `consensus_score`, `leaders_in_pool`, `gates`, `proposed_strategy`,
 * `proposed_size_sol`. The LLM and executor only look at rows with
 * decision='enter' AND entered_position_id IS NULL.
 *
 * Two modes via env var AGENT_V2_DECOUPLED_ENTRIES:
 *
 *   unset / false: gates decide → opens fire in the same tick. Use
 *     this if you don't want an LLM in the loop.
 *
 *   true: decide-only. Gates write decisions but DO NOT open. The
 *     LLM ranker (rank.sh) attaches llm_thesis + llm_rank in the gap
 *     before runEntryExecute fires. This is the recommended mode.
 */

export interface RunEntryTickResult {
  evaluated: number;
  entered: number;
  skipped: number;
}

/**
 * Replace this stub with your gate logic. Should INSERT rows into
 * agent_entry_decisions. Return counts for observability.
 *
 * When `skipExecute` is true, write decision='enter' rows but DO NOT
 * call the executor — the LLM ranker and the entry-execute stage
 * handle that.
 */
export async function runEntryTick(opts: {
  skipExecute: boolean;
}): Promise<RunEntryTickResult> {
  // TODO: implement your gate logic.
  //
  // Sketch of what TrackLP does in this stage:
  //
  //   const candidates = await discoverCandidatePools();   // from LP Agent /pools/discover, recent webhook hits, etc.
  //   for (const pool of candidates) {
  //     const leaders     = await scoreLeadersInPool(pool);  // your wallet intel
  //     const consensus   = leaders.reduce(/* quality × originality */);
  //     const gates       = await checkRugGates(pool);        // holders, mint authority, etc.
  //     const passed      = consensus > THRESHOLD && Object.values(gates).every(g => g.passed);
  //     const strategy    = passed ? deriveStrategyFromLeaders(leaders) : null;
  //
  //     await pool.query(`
  //       INSERT INTO agent_entry_decisions
  //         (pool_address, token_pair, decision, skip_reason, consensus_score,
  //          leaders_in_pool, gates, proposed_strategy, proposed_size_sol)
  //       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  //     `, [...]);
  //
  //     if (!opts.skipExecute && passed) {
  //       // legacy path: open inline. Skip if you're running the LLM ranker.
  //     }
  //   }
  //
  // Return: { evaluated, entered, skipped }
  void opts;
  throw new Error(
    'runEntryTick: implement your gate logic. See the comment block for the contract.',
  );
}
