/**
 * Agent V2 LLM ranker — Phase A.
 *
 * Pulls gate-passed agent_entry_decisions rows that haven't been ranked
 * yet and writes them to a JSON file the Claude session reads.
 *
 * Filter:
 *   decision = 'enter'
 *   AND llm_thesis IS NULL
 *   AND entered_position_id IS NULL
 *   AND evaluated_at > now() - 5 min   (drop stale)
 *
 * Output path defaults to /tmp/agent-v2-rank-input.json. Override
 * with --out <path>. On no eligible decisions, writes an empty array
 * so rank.sh can short-circuit Phase B cleanly.
 *
 * Run:
 *   npx tsx --env-file=.env agent-v2/rankPrepare.ts [--out path]
 */
import { writeFile } from 'node:fs/promises';
import { pool } from './db';

const DEFAULT_OUT = '/tmp/agent-v2-rank-input.json';
const WINDOW_MIN = 5;

interface PreparedCandidate {
  decisionId: string;
  poolAddress: string;
  tokenPair: string | null;
  consensusScore: number | null;
  proposedStrategy: unknown;
  leaders: unknown;
  gates: unknown;
  evaluatedAt: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : DEFAULT_OUT;

  const sinceIso = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString();

  const { rows } = await pool.query(
    `SELECT id,
            pool_address,
            token_pair,
            consensus_score,
            proposed_strategy,
            leaders_in_pool,
            gates,
            evaluated_at
       FROM agent_entry_decisions
      WHERE decision = 'enter'
        AND llm_thesis IS NULL
        AND entered_position_id IS NULL
        AND evaluated_at >= $1
      ORDER BY consensus_score DESC NULLS LAST
      LIMIT 20`,
    [sinceIso],
  );

  const candidates: PreparedCandidate[] = rows.map((row) => ({
    decisionId: row.id,
    poolAddress: row.pool_address,
    tokenPair: row.token_pair,
    consensusScore: row.consensus_score === null ? null : Number(row.consensus_score),
    proposedStrategy: row.proposed_strategy,
    leaders: row.leaders_in_pool,
    gates: row.gates,
    evaluatedAt: row.evaluated_at instanceof Date
      ? row.evaluated_at.toISOString()
      : String(row.evaluated_at),
  }));

  await writeFile(outPath, JSON.stringify(candidates, null, 2));
  console.log(
    `[agent-v2-rank-prepare] wrote ${candidates.length} candidates to ${outPath}`,
  );
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[agent-v2-rank-prepare] fatal: ${msg}`);
  await pool.end().catch(() => {});
  process.exit(1);
});
