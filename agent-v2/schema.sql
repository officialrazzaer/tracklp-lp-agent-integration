-- Agent V2 — table definitions read/written by this layer.
--
-- Trimmed down from TrackLP's two production migrations
-- (20260430_autonomous_agent_v2.sql + 20260501_agent_v2_llm_ranker.sql)
-- to just the columns the LLM ranker touches. The full table has more
-- fields used by the gate logic and lifecycle telemetry — those stay
-- internal to TrackLP.
--
-- Both tables are service-role-only. RLS is enabled with no public
-- policies, so PostgREST refuses anon and authenticated reads.

------------------------------------------------------------
-- 1. agent_entry_decisions
--    Written by the V1 gate stage. Read + updated by the LLM
--    ranker. Read + updated by the executor.
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_entry_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  pool_address TEXT NOT NULL,
  token_pair TEXT,

  -- 'enter'           — all gates passed
  -- 'skip'            — one or more gates failed (skip_reason explains)
  -- 'circuit_breaker' — data sources unhealthy; entries paused
  decision TEXT NOT NULL CHECK (decision IN ('enter','skip','circuit_breaker')),
  skip_reason TEXT,

  consensus_score NUMERIC,
  consensus_threshold NUMERIC,

  -- [{ wallet_address, quality_score, originality_score, contribution }]
  leaders_in_pool JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- { gate_name: { value, threshold, passed, source_ok } }
  -- source_ok=false means the data source returned null/timeout —
  -- we fail-CLOSED.
  gates JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- { source: 'mirror'|'vol_fallback', bin_width, bin_offset, shape }
  proposed_strategy JSONB,
  proposed_size_sol NUMERIC,

  -- Set by the executor once the position has actually been opened.
  -- Dedupe key — even if multiple ticks try to execute the same row,
  -- only one can fill it.
  entered_position_id TEXT,

  -- LLM ranker outputs (NULL until the ranker runs; NULL is fine)
  llm_thesis TEXT,
  llm_rank INT,
  llm_confidence NUMERIC,

  open_positions_count INT,
  free_balance_sol NUMERIC,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_entry_decisions_pool_evaluated
  ON agent_entry_decisions (pool_address, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_entry_decisions_decision_evaluated
  ON agent_entry_decisions (decision, evaluated_at DESC);

-- Covering index for the executor's ordering query:
-- pending entries ordered by (llm_rank, consensus_score).
CREATE INDEX IF NOT EXISTS idx_agent_entry_decisions_executor
  ON agent_entry_decisions (decision, entered_position_id, llm_rank, consensus_score DESC, evaluated_at DESC)
  WHERE decision = 'enter' AND entered_position_id IS NULL;

ALTER TABLE agent_entry_decisions ENABLE ROW LEVEL SECURITY;

------------------------------------------------------------
-- 2. agent_llm_calls
--    One row per LLM invocation. Cost / latency / parse-failure
--    accounting. Used to spot model regressions over time.
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_llm_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID REFERENCES agent_entry_decisions(id) ON DELETE SET NULL,
  model TEXT NOT NULL,
  prompt_truncated TEXT,
  response_truncated TEXT,
  duration_ms INT,
  status TEXT NOT NULL CHECK (status IN ('ok','timeout','error','parse_fail','fallback_used')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_llm_calls_created_at
  ON agent_llm_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_llm_calls_decision_id
  ON agent_llm_calls (decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_llm_calls_status
  ON agent_llm_calls (status, created_at DESC);

ALTER TABLE agent_llm_calls ENABLE ROW LEVEL SECURITY;
