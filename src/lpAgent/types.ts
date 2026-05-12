/**
 * LP Agent API types — public surface only.
 *
 * API docs: https://docs.lpagent.io/api-reference/introduction
 * Base URL: https://api.lpagent.io/open-api/v1
 * Auth: x-api-key header.
 *
 * Internal scoring / intelligence types (RevenueConsistency,
 * WalletIntelligenceRecord, etc.) live in TrackLP and are intentionally
 * not extracted to this case-study repo.
 */

// --- Read-side response shapes ---

export interface LPAgentTokenInfo {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly mcap: number;
  readonly fdv: number;
  readonly organicScore: number;
  readonly holderCount: number;
  readonly topHolderPct: number;
  readonly freezeAuthority: boolean;
}

export interface LPAgentPool {
  readonly poolAddress: string;
  readonly tokenX: LPAgentTokenInfo;
  readonly tokenY: LPAgentTokenInfo;
  readonly tvl: number;
  readonly feeTvlRatio: number;
  readonly vol24h: number;
  readonly fees24h: number;
  readonly vol1h: number;
  readonly fees1h: number;
  readonly binStep: number;
  readonly ageHours: number;
  readonly organicScore: number;
  readonly baseFee: number;
  readonly maxFee: number;
  readonly activeBin: number;
  readonly priceChange24h: number;
}

export interface LPAgentTopLPer {
  readonly owner: string;
  readonly totalInflow: number;
  readonly totalInflowNative: number;
  readonly totalOutflow: number;
  readonly totalOutflowNative: number;
  readonly totalFee: number;
  readonly totalFeeNative: number;
  readonly totalPnl: number;
  readonly totalPnlNative: number;
  readonly totalReward: number;
  readonly roi: number;
  readonly apr: number;
  readonly avgInflow: number;
  readonly avgInflowNative: number;
  readonly totalLp: number;
  readonly winLp: number;
  readonly winRate: number;
  readonly avgAgeHour: number;
  readonly feePercent: number;
  readonly feePercentNative: number;
  readonly firstActivity: string;
  readonly lastActivity: string;
}

export interface LPAgentWalletOverview {
  readonly totalInflow: number;
  readonly totalOutflow: number;
  readonly totalFee: number;
  readonly totalPnl: number;
  readonly totalReward: number;
  readonly winRate: number;
  readonly avgAgeHour: number;
  readonly totalLp: number;
  readonly winLp: number;
  readonly closedLp: number;
  readonly openLp: number;
  readonly apr: number;
  readonly roi: number;
  readonly expectedValue: number;
  readonly firstActivity: string;
  readonly lastActivity: string;
}

export interface LPAgentRevenuePoint {
  readonly date: string;
  readonly pnl: number;
  readonly pnlNative: number;
  readonly cumulativePnl: number;
  readonly cumulativePnlNative: number;
  readonly totalInvested: number;
  readonly maxInvested: number;
  readonly pnlPercent: number;
}

export interface LPAgentPosition {
  readonly positionAddress: string;
  readonly poolAddress: string;
  readonly tokenXSymbol: string;
  readonly tokenYSymbol: string;
  readonly status: 'Open' | 'Close';
  readonly strategyType: string;
  readonly inputValue: number;
  readonly outputValue: number;
  readonly inputToken0?: number;
  readonly inputToken1?: number;
  readonly pnlValue: number;
  readonly pnlValueNative?: number;
  readonly pnlPercent: number;
  readonly collectedFee: number;
  readonly impermanentLoss: number;
  readonly ageHour: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/**
 * Encrypted-id-bearing row from /lp-positions/opening.
 * The Zap-out endpoints require LP Agent's encrypted `id`; the standard
 * mapPosition() drops it because most callers don't need it.
 */
export interface LPAgentOpeningRow {
  readonly id: string;
  readonly positionAddress: string;
  readonly poolAddress: string;
  readonly tokenXSymbol: string;
  readonly tokenYSymbol: string;
  readonly inputValue: number;
  readonly pnlValue: number;
  readonly pnlPercent: number;
  readonly ageHour: number;
}

// --- Filters ---

export interface PoolDiscoverFilters {
  readonly sortBy?:
    | 'fee_tvl_ratio'
    | 'volatility'
    | 'mcap'
    | 'created_at'
    | 'vol_24h'
    | 'tvl';
  readonly sortOrder?: 'asc' | 'desc';
  readonly minOrganicScore?: number;
  readonly maxOrganicScore?: number;
  readonly minBinStep?: number;
  readonly maxBinStep?: number;
  readonly minMarketCap?: number;
  readonly maxMarketCap?: number;
  readonly min24hVol?: number;
  readonly min24hFees?: number;
  readonly minLiquidity?: number;
  readonly maxLiquidity?: number;
  readonly minAgeHr?: number;
  readonly maxAgeHr?: number;
  readonly feeTVLInterval?: '5m' | '1h' | '6h' | '24h';
  readonly page?: number;
  readonly pageSize?: number;
}

// --- Zap-side types (mirrors src/lpAgent/zap.ts) ---

export type ZapStrategy = 'Spot' | 'Curve' | 'BidAsk';
export type ZapProvider = 'OKX' | 'JUPITER_ULTRA';

export interface GenerateZapInArgs {
  poolAddress: string;
  owner: string;
  inputSOL?: number;
  amountX?: number;
  amountY?: number;
  percentX?: number;
  fromBinId?: number;
  toBinId?: number;
  strategy: ZapStrategy;
  slippageBps?: number;
  provider?: ZapProvider;
}

export interface GenerateZapInResult {
  lastValidBlockHeight: number;
  swapTxsWithJito: string[];
  addLiquidityTxsWithJito: string[];
  meta: Record<string, unknown>;
}

export interface LandZapInArgs {
  lastValidBlockHeight: number;
  addLiquidityTxsWithJito: string[];
  swapTxsWithJito?: string[];
  meta?: Record<string, unknown>;
}

export interface LandZapInResult {
  /** Today always 'JITO'; widened in case LP Agent adds an RPC fallback. */
  method: string;
  signature: string;
}

export interface GetZapOutQuotesArgs {
  positionId: string;
  bps: number;
}

export interface GenerateZapOutArgs {
  positionId: string;
  owner: string;
  bps: number;
  slippageBps: number;
  output?: 'allToken0' | 'allToken1' | 'both' | 'allBaseToken';
  provider?: ZapProvider;
  type?: 'meteora' | 'meteora_damm_v2';
  fromBinId?: number;
  toBinId?: number;
}

export interface GenerateZapOutResult {
  lastValidBlock: number;
  closeTxs: string[];
  swapTxs: string[];
  closeTxsWithJito: string[];
  swapTxsWithJito: string[];
  signature?: string;
}

/**
 * Zap-out landing uses /position/landing-decrease-tx — NOT /pools/landing-add-tx.
 * Different endpoint, different body shape. Verified against LP Agent's docs:
 * https://docs.lpagent.io/api-reference/position/zap-out-—-submit-and-land-zap-out-transactions
 */
export interface LandZapOutArgs {
  lastValidBlockHeight: number;
  /** Required: signed close-position txs in base64 with Jito tips. */
  closeTxsWithJito: string[];
  /** Optional: signed swap txs in base64 with Jito tips. */
  swapTxsWithJito?: string[];
}

export interface LandZapOutResult {
  method: string;
  signature: string;
}

// --- Logger ---

export interface Logger {
  warn: (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
}

export const noopLogger: Logger = {
  warn: () => {
    /* swallow */
  },
  error: () => {
    /* swallow */
  },
};
