/**
 * Public entry point for @tracklp/lp-agent-integration.
 *
 * Extracted LP Agent client, Zap helpers, rug-protection gates,
 * Helius webhook scaffolding, and supporting types from TrackLP.
 * Full product lives at https://tracklp.com.
 */

export { LPAgentClient, type LPAgentClientOptions } from './lpAgent/client';

export {
  generateZapInTx,
  landZapInTx,
  getZapOutQuotes,
  generateZapOutTx,
  landZapOutTx,
} from './lpAgent/zap';

export {
  executeZapCopyOpen,
  executeZapCloseOpen,
  serverKeypairSigner,
} from './lpAgent/executor';

export type {
  Signer,
  ExecutionRecord,
  ExecutionRecordHook,
  ExecuteZapCopyInput,
  ExecuteZapCloseInput,
  ZapCopyResult,
} from './lpAgent/executor';

export type {
  // Logging
  Logger,
  // Read-side
  LPAgentTokenInfo,
  LPAgentPool,
  LPAgentTopLPer,
  LPAgentWalletOverview,
  LPAgentRevenuePoint,
  LPAgentPosition,
  LPAgentOpeningRow,
  PoolDiscoverFilters,
  // Zap-side
  ZapStrategy,
  ZapProvider,
  GenerateZapInArgs,
  GenerateZapInResult,
  LandZapInArgs,
  LandZapInResult,
  GetZapOutQuotesArgs,
  GenerateZapOutArgs,
  GenerateZapOutResult,
  LandZapOutArgs,
  LandZapOutResult,
} from './lpAgent/types';

export { noopLogger } from './lpAgent/types';

// Webhooks (Helius)
export {
  isDlmmTransaction,
  extractTokenAmounts,
  classifyDlmmInstruction,
  DLMM_PROGRAM_ID,
  type DlmmAlertType,
  type HeliusEnhancedTransaction,
  type HeliusInstruction,
  type HeliusAccountData,
  type HeliusTokenBalanceChange,
  type HeliusTokenTransfer,
  type ExtractedTokenAmounts,
} from './webhooks';

// Rug protection
export {
  runRugGates,
  getHolderCount,
  getMintAuthorityStatus,
  KNOWN_TOKEN_HOLDER_SENTINEL,
  type GateResult,
  type RugGateInput,
  type RugGateOutcome,
  type RunRugGatesOptions,
  type GetHolderCountOptions,
  type GetMintAuthorityOptions,
  type MintAuthorityStatus,
} from './rugProtection';
