# TrackLP × LP Agent — System Architecture

The TrackLP product is built on top of LP Agent's read API and Zap API.
This diagram shows the full surface; the modules in this repo are the
integration layer extracted as a public case study.

```mermaid
flowchart LR
  helius[Helius Webhooks]
  tracker[Tracked LP wallets<br/>on Solana]
  user[User<br/>Telegram / Web]
  tracklp[tracklp.com<br/>Next.js server]
  wallet[Custodial Copy Wallet<br/>encrypted at rest]
  lpagent[LP Agent API]
  solana[Solana<br/>+ Jito bundling]
  telegram[Telegram Bot]
  scoring[Wallet Intelligence<br/>not extracted]
  agents[Autonomous V1 / V2 agents<br/>not extracted]

  tracker -- on-chain events --> helius
  helius -- live wallet alerts --> tracklp
  tracklp -- "discoverPools / topLPers / overview / revenue / opening / historical" --> lpagent
  tracklp -- alert message + ⚡ Zap button --> telegram
  telegram -- callback query --> tracklp
  user -- "tap ⚡ Zap (Telegram or dashboard)" --> tracklp
  tracklp -- decrypt + sign --> wallet
  wallet -- VersionedTransaction-ready keypair --> tracklp
  tracklp -- "Zap generate + signed land (this repo)" --> lpagent
  lpagent --> solana
  solana -- Jito-confirmed signature --> lpagent
  lpagent -- signature --> tracklp
  tracklp -- success + Solscan link --> user
  tracklp --> scoring
  scoring --> agents

  classDef public fill:#1f6feb,color:#fff,stroke:#0d419d
  classDef private fill:#3a3a3a,color:#fff,stroke:#666
  classDef wallet fill:#7c3aed,color:#fff,stroke:#5b21b6
  class tracklp,lpagent,solana,helius,telegram,user,scoring,agents,tracker private
  class wallet wallet
```

## What's in this repo (`@tracklp/lp-agent-integration`)

- **`src/lpAgent/client.ts`** — typed REST client for the six LP Agent
  read endpoints, with rate limiter, 429 retry, request timeout,
  injectable logger.
- **`src/lpAgent/zap.ts`** — five Zap helpers (`generateZapInTx`,
  `landZapInTx`, `getZapOutQuotes`, `generateZapOutTx`, `landZapOutTx`).
- **`src/lpAgent/executor.ts`** — `Signer` interface +
  `executeZapCopyOpen` / `executeZapCloseOpen` orchestration that
  bundles generate → sign → land with an optional audit hook. Includes
  `serverKeypairSigner()` for the canonical server-held-keypair case.
- **`src/lpAgent/types.ts`** — public-surface types only.

## What's not in this repo (lives at tracklp.com)

- Wallet Intelligence scoring (seven components, gated, calibrated
  over months of live trading).
- Pool originality clustering (unique vs. copy-LP detection).
- Autonomous V1 (rule-based) gate logic. V2 (LLM-driven ranker) is
  in `agent-v2/` as a runnable reference.
- Encrypted custodial keypair management — per-user AES-GCM at rest with
  userId-bound KDF and audit-logged decrypt. The pattern is documented;
  the implementation is application-specific.
- Content engine, dashboard UX.
