/**
 * LP Agent Zap-in / Zap-out helpers.
 *
 * Server-only wrappers around the four Zap endpoints. The module is
 * signer-agnostic — the returned base64 transactions can be signed by
 * any wallet capable of signing a VersionedTransaction:
 *
 *   • A browser wallet via signAllTransactions() — non-custodial UX
 *   • A server-held Keypair via tx.sign([kp]) — custodial / agentic UX
 *   • An HSM, MPC service, or remote signer behind a network call
 *
 * Pick the signer to match your product. The LP Agent endpoints don't
 * care which model you use; they require signed base64 transactions
 * with Jito tips already included on the landing call.
 *
 * Flows:
 *   Zap-in:   generateZapInTx → <your signer> → landZapInTx
 *   Zap-out:  getZapOutQuotes (preview) → generateZapOutTx → <your signer>
 *             → landZapOutTx  (NOTE: different endpoint than Zap-in landing)
 *
 * For the orchestrated server-signed pattern TrackLP ships in production,
 * see src/lpAgent/executor.ts.
 *
 * Never import this module from client components — the LP Agent API key
 * must never reach the browser.
 *
 * API docs: https://docs.lpagent.io/api-reference/
 */

import {
  GenerateZapInArgs,
  GenerateZapInResult,
  LandZapInArgs,
  LandZapInResult,
  GetZapOutQuotesArgs,
  GenerateZapOutArgs,
  GenerateZapOutResult,
  LandZapOutArgs,
  LandZapOutResult,
} from './types';

const BASE_URL = 'https://api.lpagent.io/open-api/v1';
const LOG_PREFIX = '[LP Agent Zap]';

function apiKey(): string {
  const k = process.env.LP_AGENT_API_KEY;
  if (!k) throw new Error(`${LOG_PREFIX} LP_AGENT_API_KEY not configured`);
  return k;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey(),
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${LOG_PREFIX} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    status?: string;
    data?: unknown;
    message?: string;
  };

  // LP Agent returns errors in two shapes:
  //   top-level    → {"status":"error","message":"..."}        (e.g. add-tx)
  //   nested in data → {"data":{"status":"error","message":...}} (e.g. decrease-tx)
  // Treat both as failures so callers never receive an error object disguised
  // as the success payload (which silently produces undefined fields and
  // confusing downstream errors).
  if (json.status && json.status !== 'success') {
    const msg =
      typeof json.message === 'string' && json.message
        ? `: ${json.message}`
        : '';
    throw new Error(`${LOG_PREFIX} ${path} returned status=${json.status}${msg}`);
  }
  if (
    json.data !== null &&
    typeof json.data === 'object' &&
    'status' in (json.data as Record<string, unknown>) &&
    (json.data as Record<string, unknown>).status !== 'success' &&
    (json.data as Record<string, unknown>).status !== undefined
  ) {
    const d = json.data as { status?: string; message?: string };
    const msg =
      typeof d.message === 'string' && d.message ? `: ${d.message}` : '';
    throw new Error(`${LOG_PREFIX} ${path} returned data.status=${d.status}${msg}`);
  }

  return json.data as T;
}

export async function generateZapInTx(args: GenerateZapInArgs): Promise<GenerateZapInResult> {
  // NOTE: LP Agent's API spells the field "stratergy" (their typo). Honor it.
  //
  // NOTE: The docs imply `inputSOL` alone is sufficient, but the live API
  // rejects with HTTP 500 "Amount X or Amount Y or Percent X is required"
  // when called with `inputSOL` and no `percentX`. Always supply `percentX`
  // (binary 0/1 works for SOL-only deposits — see executor.ts for the
  // standard mapping).
  const body = {
    stratergy: args.strategy,
    owner: args.owner,
    inputSOL: args.inputSOL,
    amountX: args.amountX,
    amountY: args.amountY,
    percentX: args.percentX,
    fromBinId: args.fromBinId,
    toBinId: args.toBinId,
    slippage_bps: args.slippageBps ?? 500,
    provider: args.provider ?? 'JUPITER_ULTRA',
    mode: 'zap-in',
  };
  return post<GenerateZapInResult>(`/pools/${args.poolAddress}/add-tx`, body);
}

export async function landZapInTx(args: LandZapInArgs): Promise<LandZapInResult> {
  return post<LandZapInResult>('/pools/landing-add-tx', {
    lastValidBlockHeight: args.lastValidBlockHeight,
    addLiquidityTxsWithJito: args.addLiquidityTxsWithJito,
    swapTxsWithJito: args.swapTxsWithJito ?? [],
    meta: args.meta ?? {},
  });
}

export async function getZapOutQuotes(args: GetZapOutQuotesArgs): Promise<unknown> {
  return post<unknown>('/position/decrease-quotes', {
    id: args.positionId,
    bps: args.bps,
  });
}

export async function generateZapOutTx(args: GenerateZapOutArgs): Promise<GenerateZapOutResult> {
  return post<GenerateZapOutResult>('/position/decrease-tx', {
    position_id: args.positionId,
    owner: args.owner,
    bps: args.bps,
    slippage_bps: args.slippageBps,
    output: args.output,
    provider: args.provider ?? 'JUPITER_ULTRA',
    type: args.type ?? 'meteora',
    fromBinId: args.fromBinId,
    toBinId: args.toBinId,
  });
}

/**
 * Land a Zap-out bundle.
 *
 * Different endpoint and body shape from Zap-in landing:
 *   • Endpoint: /position/landing-decrease-tx  (not /pools/landing-add-tx)
 *   • Field:    closeTxsWithJito               (not addLiquidityTxsWithJito)
 */
export async function landZapOutTx(args: LandZapOutArgs): Promise<LandZapOutResult> {
  return post<LandZapOutResult>('/position/landing-decrease-tx', {
    lastValidBlockHeight: args.lastValidBlockHeight,
    closeTxsWithJito: args.closeTxsWithJito,
    swapTxsWithJito: args.swapTxsWithJito ?? [],
  });
}
