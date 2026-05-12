# Zap-in Flow — Sequence Diagram

The Zap-in API is a three-step pattern: server builds the unsigned
transactions, the application signs them (server-side custodial or
browser non-custodial — your choice), then the server lands them via
Jito. The diagram below shows TrackLP's production custodial flow.

```mermaid
sequenceDiagram
  autonumber
  participant User as User<br/>(Telegram / Web)
  participant App as tracklp.com<br/>(Next.js server)
  participant Wallet as Custodial Copy Wallet<br/>(encrypted at rest)
  participant LP as LP Agent API
  participant Sol as Solana<br/>(via Jito)

  User->>App: Tap "⚡ Zap 0.5 SOL" on a leader's open position
  App->>App: Auth (cookie / Telegram chat link)<br/>+ rate limit + SOL-only guard<br/>+ on-chain bin range / strategy read
  App->>LP: POST /pools/{pool}/add-tx<br/>{ stratergy, owner, inputSOL, percentX, fromBinId, toBinId }
  LP->>App: { lastValidBlockHeight, swapTxsWithJito, addLiquidityTxsWithJito, meta }
  App->>Wallet: Decrypt keypair (audit-logged)
  Wallet->>App: VersionedTransaction-ready keypair
  App->>App: tx.sign([keypair]) for every base64 tx<br/>(decode → sign → re-encode)
  App->>LP: POST /pools/landing-add-tx<br/>{ signed swap + add txs, meta }
  LP->>Sol: Jito bundle → on-chain
  Sol-->>LP: Confirmed tx signature
  LP->>App: { method: 'JITO', signature }
  App->>App: Insert copy_trade_executions row<br/>{ execution_backend: 'lp-agent-zap', ... }
  App->>User: ⚡ Zap-Copy Successful + Solscan link
```

## Why three steps instead of one

LP Agent splits the build (`/pools/{pool}/add-tx`) and land
(`/pools/landing-add-tx`) phases so the signing entity can sit between
them. The signer can be:

- A **server-held keypair** (the diagram above) — TrackLP's custodial
  agent wallet pattern. Users delegate signing to a wallet TrackLP holds
  encrypted on their behalf.
- A **browser wallet** (Phantom / Backpack / wallet-adapter) — the user
  signs themselves. Same three steps, the signing happens in step 6 via
  `wallet.signAllTransactions()` instead of `tx.sign([keypair])`.

Both flows route through the same `executeZapCopyOpen` orchestration —
the only thing that changes is which `Signer` implementation you pass.

## Why Jito

Jito-bundled landing avoids the failure mode where the swap tx confirms
but the deposit tx times out (or vice versa). The bundle is atomic on
landing.

## The `percentX` gotcha

LP Agent's docs imply `inputSOL` alone tells the API how much SOL to
deposit. The live API rejects with HTTP 500 "Amount X or Amount Y or
Percent X is required" — `percentX` is required alongside `inputSOL`.
For SOL-only deposits it's binary: `1` if SOL is token X, `0` if SOL is
token Y. See the executor's input docs.

## The `stratergy` gotcha

LP Agent's API spells the strategy field `stratergy` (their typo). Honor
it. Sending `strategy` returns a 400 with a vague error. See
`src/lpAgent/zap.ts` — the wrapper takes `strategy` from the caller and
remaps to `stratergy` on the wire.
