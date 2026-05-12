/**
 * Rug-protection orchestrator.
 *
 * Runs the gates in a cheap-to-expensive order and short-circuits on
 * the first failure. Every gate result is recorded in `outcome.results`
 * for telemetry — even ones that didn't run get omitted from the
 * record, which makes it easy to spot at-a-glance which gates were
 * tripped over time.
 *
 * THE FAIL-CLOSED RULE: if a data source returned an error
 * (`sourceOk: false`), the gate is treated as failed regardless of
 * `passed`. Asymmetric risk — a missed legitimate trade is cheap, an
 * entered rug is unrecoverable.
 *
 * Currently shipped:
 *   1. holderCount      (Helius DAS getTokenAccounts)
 *   2. mintAuthority    (Solana RPC getAccountInfo, mint disabled?)
 *   3. freezeAuthority  (same RPC call, freeze disabled?)
 *
 * TrackLP also runs top-10 concentration and bundler-pattern gates
 * against the Jupiter data API, but that wrapper isn't in this repo.
 * You can plug your own gates in by composing your function around
 * `runRugGates`.
 */
import { getHolderCount } from './holderCount';
import { getMintAuthorityStatus } from './mintAuthority';
import type {
  GateResult,
  RugGateInput,
  RugGateOutcome,
} from './types';
import type { Logger } from '../lpAgent/types';
import { noopLogger } from '../lpAgent/types';

const MIN_HOLDERS = 200;
const NON_RUG_TOKEN_SENTINEL = 999_999;

export interface RunRugGatesOptions {
  heliusRpcUrl?: string;
  /**
   * Override the minimum holder count required to pass the holder
   * gate. Defaults to 200 — TrackLP's value calibrated against pump.fun
   * launches that hit ~500 holders within an hour of legitimate trading.
   */
  minHolders?: number;
  logger?: Logger;
}

function getRiskyMint(input: RugGateInput): string {
  return input.tokenXMint === input.quoteMint
    ? input.tokenYMint
    : input.tokenXMint;
}

async function gateHolderCount(
  tokenMint: string,
  opts: { heliusRpcUrl?: string; logger: Logger; minHolders: number },
): Promise<GateResult> {
  const value = await getHolderCount(tokenMint, {
    heliusRpcUrl: opts.heliusRpcUrl,
    logger: opts.logger,
  });

  if (value === null) {
    return {
      name: 'holderCount',
      value: null,
      threshold: opts.minHolders,
      passed: false,
      sourceOk: false,
      reason: 'Helius getTokenAccounts returned null (fail-CLOSED)',
    };
  }
  if (value >= NON_RUG_TOKEN_SENTINEL) {
    return {
      name: 'holderCount',
      value,
      threshold: opts.minHolders,
      passed: true,
      sourceOk: true,
      reason: null,
    };
  }
  const passed = value >= opts.minHolders;
  return {
    name: 'holderCount',
    value,
    threshold: opts.minHolders,
    passed,
    sourceOk: true,
    reason: passed ? null : `${value} holders < ${opts.minHolders} required`,
  };
}

async function gateAuthorities(
  tokenMint: string,
  opts: { heliusRpcUrl?: string; logger: Logger },
): Promise<{ mint: GateResult; freeze: GateResult }> {
  const status = await getMintAuthorityStatus(tokenMint, {
    rpcUrl: opts.heliusRpcUrl,
    logger: opts.logger,
  });

  if (!status.sourceOk) {
    const closed: GateResult = {
      name: '',
      value: null,
      threshold: 'disabled',
      passed: false,
      sourceOk: false,
      reason: 'getAccountInfo failed (fail-CLOSED)',
    };
    return {
      mint: { ...closed, name: 'mintAuthority' },
      freeze: { ...closed, name: 'freezeAuthority' },
    };
  }

  return {
    mint: {
      name: 'mintAuthority',
      value: status.mintDisabled ? 'disabled' : 'enabled',
      threshold: 'disabled',
      passed: status.mintDisabled,
      sourceOk: true,
      reason: status.mintDisabled
        ? null
        : 'mint authority still set — deployer can mint infinite supply',
    },
    freeze: {
      name: 'freezeAuthority',
      value: status.freezeDisabled ? 'disabled' : 'enabled',
      threshold: 'disabled',
      passed: status.freezeDisabled,
      sourceOk: true,
      reason: status.freezeDisabled
        ? null
        : 'freeze authority still set — deployer can freeze user balances',
    },
  };
}

/**
 * Run the gates against a candidate pool's risky-side token. Returns
 * after the first failure (cheaper checks first).
 */
export async function runRugGates(
  input: RugGateInput,
  options: RunRugGatesOptions = {},
): Promise<RugGateOutcome> {
  const logger = options.logger ?? noopLogger;
  const minHolders = options.minHolders ?? MIN_HOLDERS;
  const heliusRpcUrl = options.heliusRpcUrl;

  const riskyMint = getRiskyMint(input);
  const results: GateResult[] = [];

  const holderResult = await gateHolderCount(riskyMint, {
    heliusRpcUrl,
    logger,
    minHolders,
  });
  results.push(holderResult);
  if (!holderResult.passed) {
    return { passed: false, failedGate: holderResult.name, results };
  }

  const auth = await gateAuthorities(riskyMint, { heliusRpcUrl, logger });
  results.push(auth.mint);
  if (!auth.mint.passed) {
    return { passed: false, failedGate: auth.mint.name, results };
  }
  results.push(auth.freeze);
  if (!auth.freeze.passed) {
    return { passed: false, failedGate: auth.freeze.name, results };
  }

  return { passed: true, failedGate: null, results };
}
