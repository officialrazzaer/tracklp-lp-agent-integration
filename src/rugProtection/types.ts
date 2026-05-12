/**
 * Public-surface types for the rug-protection gates.
 *
 * Every gate returns the same shape so the orchestrator can record
 * outcomes uniformly. The critical field is `sourceOk` — `false` means
 * the underlying data source failed (RPC error, timeout, unexpected
 * response shape) and the gate MUST be treated as failed even if
 * `passed` is `true`. This is the fail-CLOSED contract.
 */

export interface GateResult {
  /** Stable identifier for the gate (e.g. 'holderCount', 'mintAuthority'). */
  name: string;
  /** Observed value. `null` when the data source failed. */
  value: number | string | null;
  /** Required value / threshold the gate was checking against. */
  threshold: number | string;
  /** Final pass/fail. Only `true` when sourceOk AND value satisfies threshold. */
  passed: boolean;
  /** False if the data source returned an error or unexpected shape. */
  sourceOk: boolean;
  /** Human-readable explanation when `passed` is false. */
  reason: string | null;
}

export interface RugGateInput {
  /** Pool token X mint. */
  tokenXMint: string;
  /** Pool token Y mint. */
  tokenYMint: string;
  /**
   * The "safe" side of the pool — the token the agent is depositing
   * (usually SOL or USDC). Used to identify the "risky" mint to gate.
   */
  quoteMint: string;
  /** Pool address. Reserved for future gates that want to exclude pool LP from concentration math. */
  poolAddress: string;
}

export interface RugGateOutcome {
  /** True iff every gate that ran passed (sourceOk AND threshold met). */
  passed: boolean;
  /** Name of the first gate that failed. Null when `passed` is true. */
  failedGate: string | null;
  /** Every gate that ran, in order. Useful for telemetry. */
  results: GateResult[];
}
