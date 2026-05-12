/**
 * Rug-protection gates. Fail-CLOSED on data-source error.
 *
 * Import either the orchestrator (`runRugGates`) or the individual
 * checks (`getHolderCount`, `getMintAuthorityStatus`).
 *
 * See `src/rugProtection/README.md` for the why.
 */
export { runRugGates, type RunRugGatesOptions } from './gates';
export {
  getHolderCount,
  KNOWN_TOKEN_HOLDER_SENTINEL,
  type GetHolderCountOptions,
} from './holderCount';
export {
  getMintAuthorityStatus,
  type MintAuthorityStatus,
  type GetMintAuthorityOptions,
} from './mintAuthority';
export type {
  GateResult,
  RugGateInput,
  RugGateOutcome,
} from './types';
