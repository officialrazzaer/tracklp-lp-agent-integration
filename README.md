# TrackLP × LP Agent Integration

> The LP Agent client, Zap integration, rug gates, webhook ingestion,
> and LLM ranker that powers [tracklp.com](https://tracklp.com).
> Packaged so other teams building on LP Agent can read, copy, and
> adapt it.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![tracklp.com](https://img.shields.io/badge/live-tracklp.com-1f6feb.svg)](https://tracklp.com)
[![LP Agent](https://img.shields.io/badge/built%20on-LP%20Agent-7c3aed.svg)](https://lpagent.io)

---

## What's in here

Five composable pieces. Each one stands alone; together they're a
working skeleton for a copy-trading agent on LP Agent.

| Piece | What | Status |
|---|---|---|
| **`src/lpAgent/`** | Typed client for 6 read endpoints + 5 Zap endpoints, with rate limiter, 429 retry, request timeout, injectable logger. Plus a pluggable `Signer` executor that does generate → sign → land in one call. | Library — `npm install` and import. |
| **`src/rugProtection/`** | Fail-CLOSED rug gates: Helius DAS `getTokenAccounts` holder count, on-chain mint and freeze authority parsers. Documents the Helius `getProgramAccounts` rejection that quietly fail-OPENs naive holder-count implementations. | Library — `npm install` and import. |
| **`src/webhooks/`** | Helius enhanced-webhook scaffolding: fast DLMM filter, instruction classifier, and a Token-2022-safe amount extractor that uses `accountData.tokenBalanceChanges` with explicit decimals. | Library — `npm install` and import. |
| **`agent-v2/`** | Runnable reference for an LLM-driven entry ranker. Sits on top of your gate logic, asks Claude to order gate-passed candidates, hands off to an executor. Postgres schema, two stage functions, host-cron orchestrator. | Runnable reference — point your `DATABASE_URL` at any Postgres. |
| **`examples/`** | End-to-end wiring. `runEntryTick.example.ts` walks pool discovery → top LPers → rug gates → `INSERT` to `agent_entry_decisions`, with a slot for your own wallet scoring. `webhookHandler.example.ts` is a Helius webhook route. | Templates — copy and adapt. |

## Quick start

```bash
git clone https://github.com/officialrazzaer/tracklp-lp-agent-integration
cd tracklp-lp-agent-integration
npm install
cp agent-v2/.env.example .env
# Edit .env: LP_AGENT_API_KEY, HELIUS_RPC_URL, DATABASE_URL
npm test
npm run build
```

What you can do with this code, ordered by effort:

| Goal | Time to first result |
|---|---|
| Call LP Agent read endpoints | minutes |
| Add a Zap-in / Zap-out button to a dApp | ~30 minutes |
| Run rug gates against any token mint | minutes |
| Receive + parse Helius webhooks for a tracked wallet | ~1 hour (point Helius at your endpoint, apply `examples/webhookHandler.example.ts`) |
| Run the LLM ranker against your own gate output | ~half a day (apply `agent-v2/schema.sql`, wire your own `runEntryTick` from `examples/`) |
| A full copy-trading agent | days–weeks — you bring your own wallet scoring (see "Not extracted" below) |

## How TrackLP uses LP Agent

### Layer 1 — Discovery

`/pools/discover` powers the "Hot Pools" tab on
[tracklp.com/discover](https://tracklp.com/discover). An hourly cron
pulls the top 100 pools sorted by `fee_tvl_ratio`. Each row links into
a "Pool Intelligence" view that calls `/pools/{pool}/top-lpers` to see
who's actually making money there.

### Layer 2 — Wallet Intelligence

`/lp-positions/overview` and `/lp-positions/revenue/{owner}` feed our
scorer. This repo gives you the typed wrappers around the underlying
API calls — you bring the scoring logic.

### Layer 3 — Real-Time Alerts

When a tracked wallet opens or closes a position, Helius webhooks fire
into TrackLP. The handler short-circuits non-DLMM transactions fast
(`isDlmmTransaction`), extracts amounts safely (`extractTokenAmounts`),
writes a `position_alert`, and emits a job to Inngest. Inngest fans
out to Telegram with a chart, formatted position info, and inline
action buttons (`📋 Copy` and `⚡ Zap`).

The webhook ingestion layer is in `src/webhooks/` and ready to drop
into your own route handler.

### Layer 4 — Execution

The user taps `⚡ Zap`. The server:

1. Looks up the user's custodial copy wallet (encrypted keypair).
2. Calls `generateZapInTx` against LP Agent.
3. Signs in-process.
4. Posts the signed bytes to `landZapInTx` (Jito-bundled).
5. Records the execution.

Same shape on close — `executeZapCloseOpen` against
`/position/decrease-tx` and `/position/landing-decrease-tx`.

The executor in `src/lpAgent/executor.ts` ships with a pluggable
`Signer` — server-keypair and browser Phantom both work.

### Layer 5 — Autonomous Agents

TrackLP runs two agents on the same LP Agent data:

- **V1 — rule-based gates.** Deterministic checks: leader-quality
  consensus, rug gates, size match, portfolio caps. Writes a row to
  `agent_entry_decisions` per evaluation. The example in
  `examples/runEntryTick.example.ts` shows the shape so you can wire
  your own gates.

- **V2 — LLM-driven ranker** (in `agent-v2/`). Sits on top of V1.
  Reads gate-passed candidates and asks Claude to rank them. Writes
  `llm_rank` + `llm_thesis` + `llm_confidence` back. The executor
  opens in `(llm_rank ASC NULLS LAST, consensus_score DESC)` order.

  The LLM is _advisory, not load-bearing_. If it times out, parses
  badly, or never runs, the executor still trades — it just trades
  in pure consensus order. The full layout, including the Postgres
  schema, is in [`agent-v2/README.md`](agent-v2/README.md).

## Executor walkthrough

```ts
import {
  executeZapCopyOpen,
  serverKeypairSigner,
} from '@tracklp/lp-agent-integration';
import { Keypair } from '@solana/web3.js';

const keypair = await yourCustodialStore.loadKeypair(userId);
const signer = await serverKeypairSigner(keypair);

const result = await executeZapCopyOpen(
  {
    poolAddress: leader.poolAddress,
    sourcePositionAddress: leader.positionAddress,
    copyAmountSol: 0.5,
    fromBinId: leader.lowerBinId,
    toBinId: leader.upperBinId,
    strategy: leader.strategyType,
    percentX: 1,
  },
  signer,
  {
    onExecutionRecord: async (row) => {
      await db.executions.insert({ ...row, backend: 'lp-agent-zap' });
    },
  },
);

console.log(`Landed: https://solscan.io/tx/${result.transactionSignature}`);
```

For browser-side signing (Phantom), provide a `Signer` whose
`signAll()` defers to `wallet.signAllTransactions()` and the same
executor works.

## Endpoints used in production

| LP Agent endpoint | Method | What we use it for |
|---|---|---|
| `/pools/discover` | GET | Hourly hot-pools cron + `/discover` UI |
| `/pools/{pool}/top-lpers` | GET | Pool-level "who's making money" view |
| `/lp-positions/historical` | GET | Closed-position history feeds wallet scoring |
| `/lp-positions/opening` | GET | Live open positions for dashboard + Zap-out lookup |
| `/lp-positions/overview` | GET | Time-windowed PnL / ROI / win-rate |
| `/lp-positions/revenue/{owner}` | GET | Daily revenue series |
| `/pools/{pool}/add-tx` | POST | Zap-in transaction generation |
| `/pools/landing-add-tx` | POST | Zap-in Jito landing |
| `/position/decrease-quotes` | POST | Zap-out quote preview |
| `/position/decrease-tx` | POST | Zap-out transaction generation |
| `/position/landing-decrease-tx` | POST | Zap-out Jito landing |

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full diagram.

```
Tracked LP wallet on Solana
         │ Helius webhook
         ▼
Your service ──────────────────── LP Agent API
   │           │                       │
   │           ├── 6 read endpoints (this repo's client)
   │           ├── Zap-in / Zap-out  (this repo's zap module)
   │           ├── Webhook ingestion (this repo's webhooks)
   │           ├── Rug gates         (this repo's rugProtection)
   │           ├── LLM ranker        (this repo's agent-v2)
   │           └── Wallet scoring + gate logic (bring your own)
   │
   ├── Custodial copy wallet (or browser Phantom)
   │      │
   │      └── signs the LP-Agent-generated Zap txs
   │
   └── Your alert + UI surfaces
          → user taps "⚡ Zap"
          → server orchestrates: generate → sign → land
```

## npm scripts

| Script | Purpose |
|---|---|
| `npm run build` | Build the library to `dist/` |
| `npm test` | Run the test suite |
| `npm run agent-v2:typecheck` | Typecheck the agent-v2 reference |
| `npm run agent-v2:rank:prepare` | Phase A of the LLM ranker |
| `npm run agent-v2:rank:apply` | Phase C of the LLM ranker |
| `npm run examples:typecheck` | Typecheck the examples |
| `npm run examples:entry-tick` | Run the gate-stage example end-to-end |

## Defaults you may want to override

| Default | Reason |
|---|---|
| `minRequestIntervalMs: 20_000` | Free-tier 5 RPM with margin. Premium 10 RPM → set to ~6_000. Enterprise 20 RPM → ~3_000. |
| `rateLimitRetryDelaysMs: [25_000, 45_000]` | Two retries with escalating backoff. Adjust if your latency budget is tighter. |
| `requestTimeoutMs: 30_000` | LP Agent is usually fast (<2s), but `/lp-positions/historical` for high-activity wallets can take 10–20s. |
| `logger: noopLogger` | Library stays quiet by default. Pass your own logger for production observability. |

## Not extracted

A few pieces live at tracklp.com and aren't in this repo:

- Wallet intelligence scoring (the layer that decides _which_ LPers
  to follow). The examples show where to plug your own scorer in.
- Pool originality clustering (unique vs. copy-LP detection).
- The specific gate logic TrackLP uses on top of the rug module.
- Encrypted custodial keypair storage. The pattern is documented;
  the implementation is application-specific.
- Dashboard, content engine, Telegram bot.

## Live in production

- [tracklp.com](https://tracklp.com) — the full product
- [tracklp.com/discover](https://tracklp.com/discover) — pool / wallet
  intelligence backed by this client
- [tracklp.com/dashboard](https://tracklp.com/dashboard) — `⚡ Zap`
  buttons on positions

## License

MIT — copy freely.

## Acknowledgments

Built on [LP Agent](https://lpagent.io). Meteora team for DLMM.
Helius for the webhooks and DAS that make the alert and
rug-protection layers possible.
