# Examples

End-to-end wiring showing how the four pieces (`LPAgentClient`, rug
protection, webhook ingestion, agent-v2 ranker) compose. None of these
files are part of the published library — they're reference templates
you can copy into your own service and adapt.

| File | What it shows |
|---|---|
| `runEntryTick.example.ts` | A minimal gate stage that pulls candidates from LP Agent, runs rug gates, and INSERTs decisions to `agent_entry_decisions`. **Scoring is left as a TODO.** |
| `webhookHandler.example.ts` | A Next.js / Express-style Helius webhook handler that filters DLMM transactions, classifies them, and extracts token amounts safely. |

## Running the examples

```bash
cp agent-v2/.env.example .env  # if you haven't already
npm install
psql "$DATABASE_URL" -f agent-v2/schema.sql
npx tsx --env-file=.env examples/runEntryTick.example.ts
```

The `runEntryTick` example doesn't actually open positions — it just
writes candidate decision rows to your `agent_entry_decisions` table.
The agent-v2 ranker + your own executor pick them up from there.
