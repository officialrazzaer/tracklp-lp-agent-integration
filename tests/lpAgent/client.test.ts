/**
 * LPAgentClient tests — verify rate limiting, 429 retry, and the typed
 * mappers without hitting the network.
 */

import { LPAgentClient } from '../../src/lpAgent/client';

function mockResponse(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => init.text ?? JSON.stringify(body),
  } as unknown as Response;
}

const VALID_OWNER = '2wNsega8KJtJK5Cg6reLHjysFCjp55w7ECjkqZzpZmcU';

describe('LPAgentClient', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  function freshClient() {
    return new LPAgentClient({
      apiKey: 'test-key',
      // Disable rate-limit waiting in tests (set tiny intervals).
      minRequestIntervalMs: 0,
      rateLimitRetryDelaysMs: [10, 20],
    });
  }

  it('throws when no API key is provided', () => {
    const original = process.env.LP_AGENT_API_KEY;
    delete process.env.LP_AGENT_API_KEY;
    expect(() => new LPAgentClient()).toThrow(/apiKey is required/);
    if (original) process.env.LP_AGENT_API_KEY = original;
  });

  it('discoverPools maps snake_case API rows to camelCase typed pools', async () => {
    const client = freshClient();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse({
        data: [
          {
            pool: 'POOL_A',
            token0: 'MINT_X',
            token0_symbol: 'X',
            token1: 'MINT_Y',
            token1_symbol: 'Y',
            tvl: 1000,
            vol_24h: 500,
            fee: 0.2,
            bin_step: 20,
            organic_score: 75,
          },
        ],
      }),
    );
    const pools = await client.discoverPools({ minOrganicScore: 50 });
    expect(pools).toHaveLength(1);
    expect(pools[0]!.poolAddress).toBe('POOL_A');
    expect(pools[0]!.tokenX.symbol).toBe('X');
    expect(pools[0]!.binStep).toBe(20);
    expect(pools[0]!.fees24h).toBeGreaterThan(0);
    expect(pools[0]!.feeTvlRatio).toBeGreaterThan(0);
  });

  it('getTopLPers converts decimal win_rate / roi to percentages', async () => {
    const client = freshClient();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse({
        data: [
          {
            owner: 'WALLET_A',
            win_rate: 0.45,
            roi: 0.12,
            fee_percent: 0.05,
          },
        ],
      }),
    );
    const lpers = await client.getTopLPers('POOL', 1, 20);
    expect(lpers[0]!.winRate).toBeCloseTo(45);
    expect(lpers[0]!.roi).toBeCloseTo(12);
    expect(lpers[0]!.feePercent).toBeCloseTo(5);
  });

  it('getWalletOpening keeps the encrypted id needed for Zap-out', async () => {
    const client = freshClient();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      mockResponse({
        data: [
          {
            id: 'enc-id-1',
            position: 'POSITION_X',
            pool: 'POOL_X',
            token0Info: { token_symbol: 'X' },
            token1Info: { token_symbol: 'SOL' },
            inputValue: 100,
            pnl: { value: 5, percent: 5 },
          },
          {
            // Row missing id — must be filtered out.
            position: 'POSITION_Y',
            pool: 'POOL_Y',
          },
        ],
      }),
    );
    const rows = await client.getWalletOpening(VALID_OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('enc-id-1');
    expect(rows[0]!.tokenYSymbol).toBe('SOL');
  });

  it('retries on 429 then succeeds', async () => {
    const client = freshClient();
    const fetchSpy = jest.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValueOnce(mockResponse({}, { ok: false, status: 429 }));
    fetchSpy.mockResolvedValueOnce(mockResponse({ data: [] }));
    const overview = await client.getWalletOverview(VALID_OWNER);
    expect(overview).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns [] for 404 instead of throwing', async () => {
    const client = freshClient();
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(mockResponse({}, { ok: false, status: 404 }));
    const positions = await client.getWalletActivePositions(VALID_OWNER);
    expect(positions).toEqual([]);
  });

  it('uses the injected logger instead of console', async () => {
    const warn = jest.fn();
    const error = jest.fn();
    const client = new LPAgentClient({
      apiKey: 'k',
      minRequestIntervalMs: 0,
      rateLimitRetryDelaysMs: [10],
      logger: { warn, error },
    });
    const fetchSpy = jest.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValueOnce(mockResponse({}, { ok: false, status: 429 }));
    fetchSpy.mockResolvedValueOnce(mockResponse({ data: [] }));
    await client.getWalletActivePositions(VALID_OWNER);
    expect(warn).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
