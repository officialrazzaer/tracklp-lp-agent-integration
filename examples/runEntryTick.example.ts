/**
 * Example: runEntryTick — the V1 gate stage.
 *
 * This is the piece that's a stub in agent-v2/entryTick.ts. It walks
 * through a minimal but real implementation:
 *
 *   1. Discover candidate pools via LP Agent /pools/discover.
 *   2. For each pool, fetch the top LPers via /pools/{pool}/top-lpers.
 *   3. Run rug gates against the risky-side token. Skip on fail.
 *   4. Score the leaders (left as a TODO — drop in your own scoring).
 *   5. INSERT a row to agent_entry_decisions with decision='enter'
 *      or 'skip'. The LLM ranker + executor pick it up from there.
 *
 * Run:
 *   cp agent-v2/.env.example .env
 *   psql "$DATABASE_URL" -f agent-v2/schema.sql
 *   npx tsx --env-file=.env examples/runEntryTick.example.ts
 *
 * Required env: LP_AGENT_API_KEY, HELIUS_RPC_URL, DATABASE_URL.
 */
import { Pool } from 'pg';
import {
  LPAgentClient,
  runRugGates,
  type LPAgentPool,
  type LPAgentTopLPer,
} from '../src';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_POOLS_PER_TICK = 5;
const MIN_CONSENSUS = 1.0;

interface ScoredLeader {
  wallet: string;
  qualityScore: number;
  originalityScore: number;
}

interface CandidateRow {
  poolAddress: string;
  tokenPair: string;
  decision: 'enter' | 'skip';
  skipReason: string | null;
  consensusScore: number | null;
  leadersInPool: ScoredLeader[];
  gates: Record<string, unknown>;
  proposedStrategy: Record<string, unknown> | null;
  proposedSizeSol: number | null;
}

const lp = new LPAgentClient({
  // apiKey defaults to LP_AGENT_API_KEY env var
  minRequestIntervalMs: 6_000,
  logger: { warn: console.warn, error: console.error },
});

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * TODO: replace with your wallet scoring.
 *
 * A reasonable place to start:
 *   const overview = await lp.getWalletOverview(lper.owner);
 *   const qualityScore = overview.winRate >= 0.6 && overview.totalPnl > 0
 *     ? Math.min(100, overview.winRate * 100 + Math.log10(overview.totalPnl))
 *     : 0;
 *   const originalityScore = 1.0;
 *
 * That's a placeholder. Real scoring is the bulk of the work.
 */
async function scoreLeader(lper: LPAgentTopLPer): Promise<ScoredLeader | null> {
  void lper;
  return null; // TODO: replace
}

function computeConsensus(leaders: ScoredLeader[]): number {
  // Sum of (quality × originality), normalized however you like.
  // TrackLP weights by position size + recency; this is the floor.
  return leaders.reduce(
    (acc, l) => acc + (l.qualityScore / 100) * l.originalityScore,
    0,
  );
}

function deriveStrategyFromLeaders(_leaders: ScoredLeader[]): {
  shape: 'spot' | 'curve' | 'bid_ask';
  binWidth: number;
  binOffset: number;
  source: 'mirror' | 'vol_fallback';
} {
  // TODO: derive bin range from leaders' open positions.
  // TrackLP fetches the leader's active position via /lp-positions/opening
  // and mirrors their (lowerBinId, upperBinId, strategy).
  return {
    shape: 'bid_ask',
    binWidth: 35,
    binOffset: 0,
    source: 'vol_fallback',
  };
}

async function evaluatePool(pool: LPAgentPool): Promise<CandidateRow> {
  const tokenPair = `${pool.tokenX.symbol}/${pool.tokenY.symbol}`;

  // 1. Top LPers
  const topLpers = await lp.getTopLPers(pool.poolAddress, 1, 20);
  const scored = (
    await Promise.all(topLpers.map((l) => scoreLeader(l)))
  ).filter((s): s is ScoredLeader => s !== null);

  // 2. Rug gates on the risky-side token
  const rug = await runRugGates(
    {
      tokenXMint: pool.tokenX.address,
      tokenYMint: pool.tokenY.address,
      quoteMint: SOL_MINT,
      poolAddress: pool.poolAddress,
    },
    {
      heliusRpcUrl: process.env.HELIUS_RPC_URL,
      logger: { warn: console.warn, error: console.error },
    },
  );

  const gatesPayload: Record<string, unknown> = {};
  for (const r of rug.results) {
    gatesPayload[r.name] = {
      value: r.value,
      threshold: r.threshold,
      passed: r.passed,
      sourceOk: r.sourceOk,
    };
  }

  if (!rug.passed) {
    return {
      poolAddress: pool.poolAddress,
      tokenPair,
      decision: 'skip',
      skipReason: `rug_gate:${rug.failedGate}`,
      consensusScore: null,
      leadersInPool: scored,
      gates: gatesPayload,
      proposedStrategy: null,
      proposedSizeSol: null,
    };
  }

  // 3. Consensus
  const consensus = computeConsensus(scored);
  if (consensus < MIN_CONSENSUS) {
    return {
      poolAddress: pool.poolAddress,
      tokenPair,
      decision: 'skip',
      skipReason: `low_consensus:${consensus.toFixed(2)}`,
      consensusScore: consensus,
      leadersInPool: scored,
      gates: gatesPayload,
      proposedStrategy: null,
      proposedSizeSol: null,
    };
  }

  // 4. Strategy + size
  const strategy = deriveStrategyFromLeaders(scored);
  const sizeSol = 0.1; // TODO: your sizing logic

  return {
    poolAddress: pool.poolAddress,
    tokenPair,
    decision: 'enter',
    skipReason: null,
    consensusScore: consensus,
    leadersInPool: scored,
    gates: gatesPayload,
    proposedStrategy: strategy,
    proposedSizeSol: sizeSol,
  };
}

async function persist(row: CandidateRow): Promise<void> {
  await pgPool.query(
    `INSERT INTO agent_entry_decisions
       (pool_address, token_pair, decision, skip_reason, consensus_score,
        leaders_in_pool, gates, proposed_strategy, proposed_size_sol)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.poolAddress,
      row.tokenPair,
      row.decision,
      row.skipReason,
      row.consensusScore,
      JSON.stringify(row.leadersInPool),
      JSON.stringify(row.gates),
      row.proposedStrategy ? JSON.stringify(row.proposedStrategy) : null,
      row.proposedSizeSol,
    ],
  );
}

async function main(): Promise<void> {
  console.log('[runEntryTick] discovering pools…');
  const pools = await lp.discoverPools({
    sortBy: 'fee_tvl_ratio',
    sortOrder: 'desc',
    minOrganicScore: 50,
    pageSize: MAX_POOLS_PER_TICK,
  });
  console.log(`[runEntryTick] evaluating ${pools.length} pool(s)`);

  let entered = 0;
  let skipped = 0;
  for (const pool of pools) {
    try {
      const row = await evaluatePool(pool);
      await persist(row);
      if (row.decision === 'enter') {
        entered++;
        console.log(
          `[runEntryTick] ENTER ${row.tokenPair}  consensus=${row.consensusScore?.toFixed(2)}`,
        );
      } else {
        skipped++;
        console.log(
          `[runEntryTick] SKIP  ${row.tokenPair}  reason=${row.skipReason}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[runEntryTick] error on ${pool.poolAddress}: ${msg}`);
    }
  }

  console.log(
    `[runEntryTick] done. evaluated=${pools.length} entered=${entered} skipped=${skipped}`,
  );
  await pgPool.end();
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[runEntryTick] fatal: ${msg}`);
  await pgPool.end().catch(() => {});
  process.exit(1);
});
