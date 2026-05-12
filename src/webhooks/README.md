# Helius webhook scaffolding

What you need to receive Meteora DLMM events in real time, filter them
fast, classify the operation, and extract token amounts without
hitting the Token-2022 decimal trap.

## What's in here

| Export | Purpose |
|---|---|
| `isDlmmTransaction(tx)` | Cheap filter: does this tx (or any inner CPI) touch the DLMM program? Call BEFORE any DB write or external API call. |
| `classifyDlmmInstruction(ix, desc?)` | Returns `'POSITION_OPEN' \| 'DEPOSIT' \| 'WITHDRAW' \| 'POSITION_CLOSE' \| 'CLAIM_FEE' \| null` for a single DLMM instruction. |
| `extractTokenAmounts(tx, walletAddress)` | Signed token deltas for the wallet, using `accountData.tokenBalanceChanges` (reliable decimals) with `tokenTransfers` as a fallback. |
| Types | `HeliusEnhancedTransaction`, `HeliusInstruction`, `HeliusAccountData`, `HeliusTokenBalanceChange`, `HeliusTokenTransfer`, `ExtractedTokenAmounts`, `DlmmAlertType` |
| `DLMM_PROGRAM_ID` | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |

## Why `extractTokenAmounts` is the high-value bit

Helius's `tokenTransfers[].tokenAmount` is unreliable for Token-2022 /
pump.fun tokens. It sometimes returns the raw u64 with no decimals
field, which causes downstream USD math to be inflated by orders of
magnitude. Other webhook handlers in the wild have the same bug.

The fix is to read `accountData[].tokenBalanceChanges` instead — that
struct ALWAYS carries an explicit `decimals` field, for every token
standard, every program. We fall back to `tokenTransfers` only when
`accountData` is empty (which is rare in practice).

The function also supplements native SOL from `nativeBalanceChange`
when the wrapped-SOL line is missing from `tokenBalanceChanges` (DLMM
mixed-deposit case, where SOL flows through a wSOL ATA that doesn't
appear on the wallet's own account).

## End-to-end example (Next.js route)

```ts
// app/api/webhooks/helius/route.ts
import { NextResponse } from 'next/server';
import {
  isDlmmTransaction,
  classifyDlmmInstruction,
  extractTokenAmounts,
  DLMM_PROGRAM_ID,
  type HeliusEnhancedTransaction,
} from '@tracklp/lp-agent-integration';

export async function POST(req: Request) {
  const payload = (await req.json()) as HeliusEnhancedTransaction[];

  for (const tx of payload) {
    if (!isDlmmTransaction(tx)) continue;

    // Find every DLMM instruction (top-level + inner CPI for wrapper
    // programs like Meteora Zap).
    const dlmmIxs = tx.instructions.flatMap((ix) => [
      ...(ix.programId === DLMM_PROGRAM_ID ? [ix] : []),
      ...(ix.innerInstructions ?? []).filter((inner) => inner.programId === DLMM_PROGRAM_ID),
    ]);

    for (const ix of dlmmIxs) {
      const alertType = classifyDlmmInstruction(ix, tx.description);
      if (!alertType) continue;

      const amounts = extractTokenAmounts(tx, tx.feePayer);

      await db.alerts.insert({
        signature: tx.signature,
        alertType,
        walletAddress: tx.feePayer,
        amounts: amounts.byMint,
        blockTime: new Date(tx.timestamp * 1000),
      });
    }
  }

  return NextResponse.json({ ok: true });
}
```

That's the 80% useful core. TrackLP's production parser is ~700 LOC
and adds:

- Pool + position address recovery from instruction account positions
  (DLMM's account layout shifts per instruction, and `closePosition`
  doesn't include the position in its accounts so we walk the
  surrounding instructions).
- Anchor discriminator decode as a third classifier fallback.
- Multi-instruction transaction handling — if a `closePosition`
  appears in the same tx, we suppress the redundant `WITHDRAW` and
  `CLAIM_FEE` that DLMM emits as part of the close.

We kept those out of this extraction because they're heuristic-heavy
and the value-per-line of code is low. If you hit the edge cases,
the patterns are documented in the comments of our private parser
and you can derive them from on-chain explorer traces.

## Configuring the Helius webhook

```ts
// Once per environment, not on every request.
await fetch('https://api.helius.xyz/v0/webhooks?api-key=YOUR_KEY', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    webhookURL: 'https://your-domain.com/api/webhooks/helius',
    transactionTypes: ['ANY'],  // see note below
    accountAddresses: trackedWalletAddresses,
    webhookType: 'enhanced',
    authHeader: process.env.HELIUS_WEBHOOK_SECRET, // recommended
  }),
});
```

**`transactionTypes: ['ANY']`, not `['UNKNOWN']`.** On 2026-04-07 Helius
silently stopped delivering DLMM v2 transactions under the `UNKNOWN`
filter at ~03:10 UTC. TrackLP's copy trading was dead for ~24 hours
before we caught the regression. `ANY` delivers everything, and
`isDlmmTransaction` discards non-DLMM noise in microseconds so the
credit cost is bounded.
