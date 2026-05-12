/**
 * Example: Helius enhanced webhook handler.
 *
 * This is the shape we run in production at tracklp.com. Plug it into
 * a Next.js Route Handler, Express route, Bun.serve handler — anywhere
 * that accepts a POST with a JSON body.
 *
 * The order matters:
 *   1. Fast filter (isDlmmTransaction) — short-circuit non-DLMM noise
 *      before any external call.
 *   2. Walk top-level + inner DLMM instructions (wrapper programs like
 *      Meteora Zap call DLMM via CPI).
 *   3. Classify each instruction.
 *   4. Extract amounts via accountData.tokenBalanceChanges (Token-2022
 *      safe).
 *   5. Persist / emit.
 *
 * Don't price-lookup or DB-write inside the request handler if you can
 * help it — TrackLP enqueues to Inngest and returns 200 in ~5ms.
 */
import {
  DLMM_PROGRAM_ID,
  classifyDlmmInstruction,
  extractTokenAmounts,
  isDlmmTransaction,
  type HeliusEnhancedTransaction,
  type HeliusInstruction,
} from '../src';

export interface DlmmEventOut {
  signature: string;
  alertType: string;
  walletAddress: string;
  amounts: Record<string, number>;
  blockTime: Date;
}

export interface HandlerDeps {
  onEvent: (event: DlmmEventOut) => Promise<void>;
}

function collectDlmmInstructions(tx: HeliusEnhancedTransaction): HeliusInstruction[] {
  const out: HeliusInstruction[] = [];
  for (const ix of tx.instructions) {
    if (ix.programId === DLMM_PROGRAM_ID) out.push(ix);
    for (const inner of ix.innerInstructions ?? []) {
      if (inner.programId === DLMM_PROGRAM_ID) out.push(inner);
    }
  }
  return out;
}

export async function handleHeliusPayload(
  payload: HeliusEnhancedTransaction[],
  deps: HandlerDeps,
): Promise<{ processed: number; skipped: number }> {
  let processed = 0;
  let skipped = 0;

  for (const tx of payload) {
    if (!isDlmmTransaction(tx)) {
      skipped++;
      continue;
    }

    const ixs = collectDlmmInstructions(tx);
    for (const ix of ixs) {
      const alertType = classifyDlmmInstruction(ix, tx.description);
      if (!alertType) continue;

      const amounts = extractTokenAmounts(tx, tx.feePayer);

      await deps.onEvent({
        signature: tx.signature,
        alertType,
        walletAddress: tx.feePayer,
        amounts: amounts.byMint,
        blockTime: new Date(tx.timestamp * 1000),
      });
      processed++;
    }
  }

  return { processed, skipped };
}

// ---- Usage in a Next.js App Router route ---------------------------------
//
// app/api/webhooks/helius/route.ts:
//
//   import { NextResponse } from 'next/server';
//   import { handleHeliusPayload } from '@/examples/webhookHandler.example';
//
//   export async function POST(req: Request) {
//     const auth = req.headers.get('authorization');
//     if (auth !== process.env.HELIUS_WEBHOOK_SECRET) {
//       return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
//     }
//
//     const payload = (await req.json()) as HeliusEnhancedTransaction[];
//     const result = await handleHeliusPayload(payload, {
//       onEvent: async (event) => {
//         await queue.enqueue('dlmm-event', event);
//       },
//     });
//
//     return NextResponse.json(result);
//   }
//
// ---- Wallet-targeted variant ---------------------------------------------
//
// If you only care about specific wallets (the copy-trading case), filter
// the events before enqueueing. Walking tx.feePayer alone is fine for the
// common case; for full coverage including CPI-driven txs, walk every
// account in every (inner) instruction and check membership in your
// tracked-wallet set.
