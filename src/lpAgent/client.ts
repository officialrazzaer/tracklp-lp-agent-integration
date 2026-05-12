/**
 * LP Agent API client — read-side endpoints.
 *
 * Wraps the six LP Agent endpoints TrackLP uses in production:
 *   - GET /pools/discover
 *   - GET /pools/{pool}/top-lpers
 *   - GET /lp-positions/historical
 *   - GET /lp-positions/opening
 *   - GET /lp-positions/overview
 *   - GET /lp-positions/revenue/{owner}
 *
 * Plus a self-paced rate limiter, 429 retry with backoff, request timeout,
 * and an injectable logger so consumers don't get noisy console output by
 * default.
 *
 * Zap-side endpoints live in `./zap.ts` because they're POSTs, not GETs,
 * and need different ergonomics (no rate limiter, errors thrown raw).
 *
 * API docs: https://docs.lpagent.io/api-reference/introduction
 */

import {
  Logger,
  noopLogger,
  LPAgentPool,
  LPAgentTopLPer,
  LPAgentPosition,
  LPAgentWalletOverview,
  LPAgentRevenuePoint,
  LPAgentOpeningRow,
  PoolDiscoverFilters,
} from './types';

const BASE_URL = 'https://api.lpagent.io/open-api/v1';

export interface LPAgentClientOptions {
  /** Defaults to process.env.LP_AGENT_API_KEY. Required. */
  apiKey?: string;
  /**
   * Minimum spacing between requests, in ms. Free-tier 5 RPM = 12s.
   * Premium 10 RPM works at ~6s. We default to 20s for free tier
   * (gives margin if multiple processes share the key).
   */
  minRequestIntervalMs?: number;
  /** Backoff schedule for 429 retries. Defaults to [25s, 45s]. */
  rateLimitRetryDelaysMs?: number[];
  /** Request timeout in ms. Defaults to 30s. */
  requestTimeoutMs?: number;
  /** Optional logger. Defaults to a no-op so the lib stays quiet. */
  logger?: Logger;
}

export class LPAgentClient {
  private readonly apiKey: string;
  private readonly minIntervalMs: number;
  private readonly retryDelays: number[];
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private lastRequestAt = 0;

  constructor(opts: LPAgentClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.LP_AGENT_API_KEY;
    if (!apiKey) {
      throw new Error('[LP Agent] apiKey is required (or set LP_AGENT_API_KEY)');
    }
    this.apiKey = apiKey;
    this.minIntervalMs = opts.minRequestIntervalMs ?? 20_000;
    this.retryDelays = opts.rateLimitRetryDelaysMs ?? [25_000, 45_000];
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.log = opts.logger ?? noopLogger;
  }

  // --- Rate Limiter ---

  private async waitForRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  // --- Core Request ---

  private async request<T>(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<T> {
    await this.waitForRateLimit();

    const url = new URL(`${BASE_URL}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url.toString(), {
        headers: {
          'x-api-key': this.apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });

      // 404 = no data; downstream callers expect [] not a throw.
      if (response.status === 404) return [] as unknown as T;

      // 429 = rate limited. Escalating backoff, throws after the final retry
      // so callers can distinguish 'no data' from 'never got an answer'.
      if (response.status === 429) {
        for (let i = 0; i < this.retryDelays.length; i++) {
          const delay = this.retryDelays[i]!;
          this.log.warn(
            `[LP Agent] 429 on ${path} — retrying in ${delay / 1000}s (${i + 1}/${this.retryDelays.length})`,
          );
          await sleep(delay);
          this.lastRequestAt = Date.now();

          const retry = await fetch(url.toString(), {
            headers: {
              'x-api-key': this.apiKey,
              Accept: 'application/json',
            },
          });
          if (retry.ok) return (await retry.json()) as T;
          if (retry.status !== 429) {
            this.log.error(`[LP Agent] retry ${retry.status} on ${path}`);
            return [] as unknown as T;
          }
        }
        throw new Error(`[LP Agent] rate limit retries exhausted on ${path}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.log.error(`[LP Agent] ${response.status} on ${path}: ${body.slice(0, 200)}`);
        throw new Error(`[LP Agent] ${response.status} on ${path}`);
      }

      return (await response.json()) as T;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') {
        this.log.error(`[LP Agent] timeout (${this.timeoutMs}ms) on ${path}`);
        return [] as unknown as T;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Public API ---

  /** Discover pools with rich filtering. */
  async discoverPools(filters: PoolDiscoverFilters = {}): Promise<LPAgentPool[]> {
    const params: Record<string, string | number | undefined> = {
      sortBy: filters.sortBy,
      sortOrder: filters.sortOrder,
      min_organic_score: filters.minOrganicScore,
      max_organic_score: filters.maxOrganicScore,
      min_bin_step: filters.minBinStep,
      max_bin_step: filters.maxBinStep,
      min_market_cap: filters.minMarketCap,
      max_market_cap: filters.maxMarketCap,
      min_24h_vol: filters.min24hVol,
      min_24h_fees: filters.min24hFees,
      min_liquidity: filters.minLiquidity,
      max_liquidity: filters.maxLiquidity,
      min_age_hr: filters.minAgeHr,
      max_age_hr: filters.maxAgeHr,
      feeTVLInterval: filters.feeTVLInterval,
      page: filters.page,
      pageSize: filters.pageSize,
    };
    const response = await this.request<{ data?: unknown[] }>('/pools/discover', params);
    const items = Array.isArray(response) ? response : (response?.data ?? []);
    return items.map((i) => mapPool(i as Record<string, unknown>));
  }

  /** Top LPers for a pool (single page). */
  async getTopLPers(
    poolAddress: string,
    page = 1,
    pageSize = 20,
  ): Promise<LPAgentTopLPer[]> {
    const response = await this.request<{ data?: unknown[] }>(
      `/pools/${poolAddress}/top-lpers`,
      { page, pageSize },
    );
    const items = Array.isArray(response) ? response : (response?.data ?? []);
    return items.map((i) => mapTopLPer(i as Record<string, unknown>));
  }

  /** Top LPers across multiple pages (sequential). */
  async getTopLPersPaginated(
    poolAddress: string,
    maxPages = 3,
    pageSize = 20,
  ): Promise<LPAgentTopLPer[]> {
    const all: LPAgentTopLPer[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const lpers = await this.getTopLPers(poolAddress, page, pageSize);
      all.push(...lpers);
      if (lpers.length < pageSize) break;
    }
    return all;
  }

  /** Historical (closed) positions for a wallet — full LPAgentPosition shape. */
  async getWalletHistoricalPositions(
    owner: string,
    pageSize = 50,
  ): Promise<LPAgentPosition[]> {
    const response = await this.request<{
      data?: { data?: unknown[]; pagination?: unknown };
    }>('/lp-positions/historical', { owner, pageSize, page: 1 });
    const positions = response?.data?.data ?? [];
    return positions.map((i) => mapPosition(i as Record<string, unknown>));
  }

  /** Open positions for a wallet — full LPAgentPosition shape. */
  async getWalletActivePositions(owner: string): Promise<LPAgentPosition[]> {
    const response = await this.request<{ count?: number; data?: unknown[] }>(
      '/lp-positions/opening',
      { owner },
    );
    const positions = Array.isArray(response) ? response : (response?.data ?? []);
    return positions.map((i) => mapPosition(i as Record<string, unknown>));
  }

  /**
   * Open positions including LP Agent's encrypted `id` field — required by
   * the Zap-out endpoints. Use this when you intend to call zap.ts.
   */
  async getWalletOpening(owner: string): Promise<LPAgentOpeningRow[]> {
    const response = await this.request<{ count?: number; data?: unknown[] }>(
      '/lp-positions/opening',
      { owner },
    );
    const rows = Array.isArray(response) ? response : (response?.data ?? []);
    return (rows as Record<string, unknown>[])
      .map((raw): LPAgentOpeningRow | null => {
        const id = String(raw.id ?? '');
        if (!id) return null;
        const pnl = raw.pnl as Record<string, unknown> | undefined;
        const t0 = raw.token0Info as Record<string, unknown> | undefined;
        const t1 = raw.token1Info as Record<string, unknown> | undefined;
        return {
          id,
          positionAddress: String(raw.position ?? raw.tokenId ?? ''),
          poolAddress: String(raw.pool ?? ''),
          tokenXSymbol: String(t0?.token_symbol ?? raw.tokenName0 ?? ''),
          tokenYSymbol: String(t1?.token_symbol ?? raw.tokenName1 ?? ''),
          inputValue: Number(raw.inputValue ?? 0),
          pnlValue: pnl ? Number(pnl.value ?? 0) : Number(raw.pnl ?? 0),
          pnlPercent: pnl ? Number(pnl.percent ?? 0) : 0,
          ageHour: parseFloat(String(raw.ageHour ?? raw.age_hour ?? '0')),
        };
      })
      .filter((r): r is LPAgentOpeningRow => r !== null);
  }

  /**
   * Wallet overview (PnL / win rate / ROI) for a given range.
   * The /overview endpoint returns nested objects per range — extracts the
   * one you ask for.
   */
  async getWalletOverview(
    owner: string,
    range: 'ALL' | '7D' | '1M' | '3M' | '1Y' | 'YTD' = 'ALL',
  ): Promise<LPAgentWalletOverview | null> {
    try {
      const response = await this.request<{ data?: unknown[] }>(
        '/lp-positions/overview',
        { owner },
      );
      const items = response?.data;
      if (!items || !Array.isArray(items) || items.length === 0) return null;
      const raw = items[0] as Record<string, unknown>;
      return {
        totalInflow: Number(raw.total_inflow ?? 0),
        totalOutflow: Number(raw.total_outflow ?? 0),
        totalFee: extractRange(raw.total_fee, range),
        totalPnl: extractRange(raw.total_pnl, range),
        totalReward: Number(raw.total_reward ?? 0),
        winRate: extractRange(raw.win_rate, range) * 100,
        avgAgeHour: Number(raw.avg_age_hour ?? 0),
        totalLp: Number(raw.total_lp ?? 0),
        winLp: Number(raw.win_lp ?? 0),
        closedLp: extractRange(raw.closed_lp, range),
        openLp: Number(raw.opening_lp ?? raw.open_lp ?? 0),
        apr: Number(raw.apr ?? 0) * 100,
        roi: Number(raw.roi ?? 0) * 100,
        expectedValue: extractRange(raw.expected_value, range),
        firstActivity: String(raw.first_activity ?? ''),
        lastActivity: String(raw.last_activity ?? ''),
      };
    } catch (e) {
      this.log.error(`[LP Agent] getWalletOverview failed for ${owner}:`, e);
      return null;
    }
  }

  /** Daily revenue time-series for a wallet. */
  async getWalletRevenue(
    owner: string,
    range: '7D' | '1M' = '7D',
  ): Promise<LPAgentRevenuePoint[]> {
    try {
      const response = await this.request<{ data?: unknown[] }>(
        `/lp-positions/revenue/${owner}`,
        { range },
      );
      const items = Array.isArray(response) ? response : (response?.data ?? []);
      return items.map((raw) => {
        const r = raw as Record<string, unknown>;
        return {
          // API returns close_day (not date) and sum (not pnl).
          date: String(r.close_day ?? r.date ?? ''),
          pnl: Number(r.sum ?? r.pnl ?? 0),
          pnlNative: Number(r.sum_native ?? r.pnl_native ?? 0),
          cumulativePnl: Number(r.cumulative_pnl ?? 0),
          cumulativePnlNative: Number(r.cumulative_pnl_native ?? 0),
          totalInvested: Number(r.total_invested ?? 0),
          maxInvested: Number(r.max_invested ?? 0),
          pnlPercent: Number(r.pnl_percent ?? 0),
        };
      });
    } catch (e) {
      this.log.error(`[LP Agent] getWalletRevenue failed for ${owner}:`, e);
      return [];
    }
  }
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRange(field: unknown, range: string): number {
  if (typeof field === 'object' && field !== null) {
    return Number((field as Record<string, unknown>)[range] ?? 0);
  }
  return Number(field ?? 0);
}

function computeAgeHours(createdAt: unknown): number {
  if (!createdAt) return 0;
  const created = new Date(String(createdAt));
  if (isNaN(created.getTime())) return 0;
  return Math.max(0, (Date.now() - created.getTime()) / (1000 * 60 * 60));
}

function mapPool(raw: Record<string, unknown>): LPAgentPool {
  const tvl = Number(raw.tvl ?? 0);
  const fee = Number(raw.fee ?? 0);
  const vol24h = Number(raw.vol_24h ?? 0);
  const fees24h = fee > 0 && vol24h > 0 ? (fee * vol24h) / 100 : 0;
  const feeTvlRatio = tvl > 0 && fees24h > 0 ? (fees24h / tvl) * 100 : 0;
  return {
    poolAddress: String(raw.pool ?? ''),
    tokenX: {
      address: String(raw.token0 ?? ''),
      symbol: String(raw.token0_symbol ?? ''),
      name: String(raw.token0_name ?? ''),
      mcap: Number(raw.mcap ?? 0),
      fdv: 0,
      organicScore: Number(raw.organic_score ?? 0),
      holderCount: 0,
      topHolderPct: 0,
      freezeAuthority: false,
    },
    tokenY: {
      address: String(raw.token1 ?? ''),
      symbol: String(raw.token1_symbol ?? ''),
      name: String(raw.token1_name ?? ''),
      mcap: 0,
      fdv: 0,
      organicScore: 0,
      holderCount: 0,
      topHolderPct: 0,
      freezeAuthority: false,
    },
    tvl,
    feeTvlRatio,
    vol24h,
    fees24h,
    vol1h: Number(raw.vol_1h ?? 0),
    fees1h: 0,
    binStep: Number(raw.bin_step ?? 0),
    ageHours: computeAgeHours(raw.created_at),
    organicScore: Number(raw.organic_score ?? 0),
    baseFee: fee,
    maxFee: 0,
    activeBin: 0,
    priceChange24h: Number(raw.price_24h_change ?? 0),
  };
}

function mapTopLPer(raw: Record<string, unknown>): LPAgentTopLPer {
  // win_rate / roi / fee_percent come as decimals (0.459 = 45.9%); convert.
  return {
    owner: String(raw.owner ?? ''),
    totalInflow: Number(raw.total_inflow ?? 0),
    totalInflowNative: Number(raw.total_inflow_native ?? 0),
    totalOutflow: Number(raw.total_outflow ?? 0),
    totalOutflowNative: Number(raw.total_outflow_native ?? 0),
    totalFee: Number(raw.total_fee ?? 0),
    totalFeeNative: Number(raw.total_fee_native ?? 0),
    totalPnl: Number(raw.total_pnl ?? 0),
    totalPnlNative: Number(raw.total_pnl_native ?? 0),
    totalReward: Number(raw.total_reward ?? 0),
    roi: Number(raw.roi ?? 0) * 100,
    apr: Number(raw.apr ?? 0) * 100,
    avgInflow: Number(raw.avg_inflow ?? 0),
    avgInflowNative: Number(raw.avg_inflow_native ?? 0),
    totalLp: Number(raw.total_lp ?? 0),
    winLp: Number(raw.win_lp ?? 0),
    winRate: Number(raw.win_rate ?? 0) * 100,
    avgAgeHour: Number(raw.avg_age_hour ?? 0),
    feePercent: Number(raw.fee_percent ?? 0) * 100,
    feePercentNative: Number(raw.fee_percent_native ?? 0) * 100,
    firstActivity: String(raw.first_activity ?? ''),
    lastActivity: String(raw.last_activity ?? ''),
  };
}

function mapPosition(raw: Record<string, unknown>): LPAgentPosition {
  const pnl = raw.pnl as Record<string, unknown> | undefined;
  const t0 = raw.token0Info as Record<string, unknown> | undefined;
  const t1 = raw.token1Info as Record<string, unknown> | undefined;
  return {
    positionAddress: String(raw.position ?? raw.tokenId ?? ''),
    poolAddress: String(raw.pool ?? ''),
    tokenXSymbol: String(t0?.token_symbol ?? raw.tokenName0 ?? ''),
    tokenYSymbol: String(t1?.token_symbol ?? raw.tokenName1 ?? ''),
    status: String(raw.status ?? 'Close') as 'Open' | 'Close',
    strategyType: String(raw.strategyType ?? ''),
    inputValue: Number(raw.inputValue ?? 0),
    outputValue: Number(raw.outputValue ?? 0),
    inputToken0: Number(raw.inputToken0 ?? 0),
    inputToken1: Number(raw.inputToken1 ?? 0),
    pnlValue: pnl ? Number(pnl.value ?? 0) : Number(raw.pnl ?? 0),
    pnlValueNative: pnl && pnl.valueNative !== undefined ? Number(pnl.valueNative) : undefined,
    pnlPercent: pnl ? Number(pnl.percent ?? 0) : 0,
    collectedFee: Number(raw.collectedFee ?? raw.fee ?? 0),
    impermanentLoss: Number(raw.impermanentLoss ?? 0),
    ageHour: parseFloat(String(raw.ageHour ?? raw.age_hour ?? '0')),
    tickLower: Number(raw.tickLower ?? 0),
    tickUpper: Number(raw.tickUpper ?? 0),
    createdAt: String(raw.createdAt ?? raw.created_at ?? ''),
    closedAt: raw.closeAt ? String(raw.closeAt) : raw.close_At ? String(raw.close_At) : null,
  };
}
