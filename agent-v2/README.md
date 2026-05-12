# Agent V2 — LLM ranker (runnable reference)

This is the LLM-driven layer that sits on top of TrackLP's V1 rule-based
gates. The gates decide _whether_ a candidate is eligible; the LLM
decides _which order_ to fire eligible candidates in when capital is
scarce; the executor opens the top one(s).

The shape generalizes well — a deterministic gate stage, an out-of-band
LLM ranker, and an idempotent executor, all communicating through one
Postgres table — so we extracted it for the hackathon.

## How it fits together

```
                 (every 1 min)
runEntryTick ────────────────────────► writes agent_entry_decisions rows
   (your gate logic)                   (decision='enter', llm_* NULL)
                                                │
                 (every 1 min, host cron)       │
rank.sh ───────────────────────────────────────►│
   │ Phase A: rankPrepare.ts                    │
   │   pulls llm_thesis IS NULL rows  ──────────┤
   │   into /tmp/agent-v2-rank-input.json       │
   │                                            │
   │ Phase B: tmux send-keys to a shared        │
   │   Claude session — reads input,            │
   │   writes /tmp/agent-v2-rank-output.json    │
   │                                            │
   │ Phase C: rankApply.ts                      │
   │   parses output, UPDATEs agent_entry_      │
   │   decisions.llm_rank/thesis/confidence  ──►│
                                                │
                 (every 1 min, ~30s after       │
                 the tick)                      │
runEntryExecute ───────────────────────────────►│
   reads decisions ORDER BY (llm_rank ASC NULLS │
   LAST, consensus_score DESC), opens the top   │
   N positions, sets entered_position_id.       │
```

The three stages run on their own schedules and share one Postgres
table. **If the LLM is slow, mis-fires, or down, nothing breaks** — the
executor falls back to consensus order and life goes on. That's the
safety property we wanted.

## What's runnable vs. what's a stub

| File | State |
|---|---|
| `rankPrepare.ts` | ✅ **Runnable.** Vanilla `pg`. Reads pending rows, writes JSON. |
| `rankApply.ts` | ✅ **Runnable.** Vanilla `pg`. Parses JSON, updates rows, writes audit. |
| `rank.sh` | ✅ **Runnable** once you have a Claude tmux session up. Now repo-relative paths, configurable env. |
| `entryExecute.ts` | ✅ **Runnable.** SELECT + dispatch loop + idempotent UPDATE all implemented; you wire the `open` callback. |
| `entryTick.ts` | **Interface stub.** The gate logic is yours to write — the contract is documented in the file. |
| `schema.sql` | ✅ Apply against your Postgres. |

## Setup

1. **Apply the schema** to your Postgres:

   ```bash
   psql "$DATABASE_URL" -f agent-v2/schema.sql
   ```

   Works against Supabase, RDS, neon, self-hosted — vanilla SQL.

2. **Configure env** at the repo root:

   ```bash
   cp agent-v2/.env.example .env
   # edit .env, set DATABASE_URL
   ```

3. **Install** (from repo root — `pg` and `tsx` are devDependencies):

   ```bash
   npm install
   ```

4. **Sanity-check the typecheck**:

   ```bash
   npm run agent-v2:typecheck
   ```

5. **Run the ranker scripts directly** (Phase A and C are independently runnable):

   ```bash
   npm run agent-v2:rank:prepare -- --out /tmp/input.json
   npm run agent-v2:rank:apply -- --input /tmp/input.json --output /tmp/output.json
   ```

   With nothing in `agent_entry_decisions` yet, prepare writes an empty
   array and exits cleanly. That confirms the DB connection.

## Wiring the four stages

### 1. `runEntryTick` (your gate logic — you implement)

```ts
import { runEntryTick } from './agent-v2/entryTick';
// schedule this however you want — node-cron, Vercel cron, Inngest...
await runEntryTick({ skipExecute: true });
```

The stub throws. Replace with your gate logic, which should INSERT
rows into `agent_entry_decisions`. The contract is documented at the
top of `entryTick.ts`.

### 2. `rank.sh` (host cron, ~1× per minute)

```cron
* * * * * cd /path/to/repo && ./agent-v2/rank.sh >> /var/log/agent-v2-rank.log 2>&1
```

You need a long-lived tmux session named `agent` with Claude running
in it:

```bash
tmux new -s agent
# inside the session:
claude --model opus
```

The script `flock`s `/tmp/agent-claude.lock` so multiple ranker
invocations (or any other cron sharing that Claude session) can't
race. Override `TMUX_SESSION`, `TIMEOUT_S`, `RUN_AS_USER` etc. with
env vars.

### 3. `runEntryExecute` (open positions in LLM-rank order)

```ts
import { runEntryExecute } from './agent-v2/entryExecute';
import { executeZapCopyOpen, serverKeypairSigner } from '@tracklp/lp-agent-integration';

await runEntryExecute({
  maxOpens: 1,
  open: async (decision) => {
    const signer = await serverKeypairSigner(await loadKeypair(decision));
    const strat = decision.proposedStrategy as { bin_width: number; bin_offset: number; shape: 'spot' | 'curve' | 'bid_ask' };
    const leaders = decision.leadersInPool as Array<{ wallet_address: string; source_position_address: string; from_bin_id: number; to_bin_id: number }>;
    const leader = leaders[0];

    const result = await executeZapCopyOpen(
      {
        poolAddress: decision.poolAddress,
        sourcePositionAddress: leader.source_position_address,
        copyAmountSol: decision.proposedSizeSol ?? 0.1,
        fromBinId: leader.from_bin_id,
        toBinId: leader.to_bin_id,
        strategy: strat.shape === 'bid_ask' ? 'BidAsk' : strat.shape === 'curve' ? 'Curve' : 'Spot',
        percentX: 1, // your value depends on the pool's token ordering
      },
      signer,
    );

    return { enteredPositionId: result.positionAddress };
  },
});
```

Run this on its own 1-minute cron, scheduled to fire 30s after the
gate tick so the ranker has a window to attach `llm_rank`.

## Sanitization notes

Compared to what TrackLP runs in production:

- `agent-v2/db.ts` uses vanilla `pg` against `DATABASE_URL`. TrackLP
  uses `supabase-js` internally because we use other Supabase features;
  the queries are identical, the client choice doesn't matter.
- The shared lock file path, tmux session name, and timeout are now
  env-overridable defaults. TrackLP hard-codes them in our VPS config.
- `entryTick.ts` is a stub — the V1 gate logic (consensus scoring,
  rug gates, size match, portfolio caps) stays in TrackLP.

## What we'd do differently next time

- Front the Claude session with a proper queue (Redis Streams or
  similar) instead of tmux send-keys. The tmux design is a holdover
  from when we wanted to watch the LLM think in real time.
- Record the LLM's _decision_ (the ordering) separately from its
  _thesis_ (the prose), so we can A/B the model purely on ordering
  quality without prose contaminating the metric.
- Lift the 15s timeout. It's the right number for ~8 candidates; at
  20+ we sometimes truncate. Falling back to consensus is fine but
  loses signal.
