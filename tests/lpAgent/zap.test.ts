/**
 * Zap module tests — verifies the Zap-in / Zap-out wrappers post the
 * right body / headers and surface errors cleanly.
 */

import {
  generateZapInTx,
  landZapInTx,
  getZapOutQuotes,
  generateZapOutTx,
} from '../../src/lpAgent/zap';

const ORIGINAL_KEY = process.env.LP_AGENT_API_KEY;

function mockFetchOnce(body: unknown, init: { ok?: boolean; status?: number; text?: string } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? 200;
  return jest.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    json: async () => body,
    text: async () => init.text ?? JSON.stringify(body),
  } as unknown as Response);
}

describe('LP Agent Zap module', () => {
  beforeEach(() => {
    process.env.LP_AGENT_API_KEY = 'test-api-key';
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.LP_AGENT_API_KEY;
    else process.env.LP_AGENT_API_KEY = ORIGINAL_KEY;
  });

  describe('error response handling', () => {
    const { generateZapInTx, generateZapOutTx } = require('../../src/lpAgent/zap');

    it('throws on HTTP 5xx', async () => {
      mockFetchOnce(
        { status: 'error', message: 'boom' },
        { ok: false, status: 500, text: '{"status":"error","message":"boom"}' },
      );
      await expect(
        generateZapInTx({
          poolAddress: 'POOL',
          owner: 'OWNER',
          inputSOL: 0.1,
          percentX: 1,
          strategy: 'Spot',
        }),
      ).rejects.toThrow(/500/);
    });

    it('throws on 2xx with top-level status:error', async () => {
      mockFetchOnce({
        status: 'error',
        message: 'Amount X or Amount Y or Percent X is required',
      });
      await expect(
        generateZapInTx({
          poolAddress: 'POOL',
          owner: 'OWNER',
          inputSOL: 0.1,
          percentX: 1,
          strategy: 'Spot',
        }),
      ).rejects.toThrow(/status=error.*Amount X/);
    });

    it('throws on 2xx with status nested in data (decrease-tx error shape)', async () => {
      mockFetchOnce({
        data: {
          status: 'error',
          message: 'Position account 9auvnMLr not found',
        },
      });
      await expect(
        generateZapOutTx({
          positionId: '9auvnMLr',
          owner: 'OWNER',
          bps: 10000,
          slippageBps: 500,
          output: 'allBaseToken',
        }),
      ).rejects.toThrow(/data\.status=error.*Position account/);
    });
  });

  it('generateZapInTx posts to /pools/{pool}/add-tx with the correct body', async () => {
    const fetchSpy = mockFetchOnce({
      status: 'success',
      data: {
        lastValidBlockHeight: 100,
        swapTxsWithJito: ['s'],
        addLiquidityTxsWithJito: ['a'],
        meta: {},
      },
    });

    const result = await generateZapInTx({
      poolAddress: 'POOL_X',
      owner: 'OWNER_X',
      inputSOL: 0.1,
      fromBinId: 100,
      toBinId: 134,
      strategy: 'Spot',
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/pools/POOL_X/add-tx');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-api-key');
    const body = JSON.parse((init as RequestInit).body as string);
    // LP Agent's docs spell strategy as "stratergy" — verify we honor that.
    expect(body.stratergy).toBe('Spot');
    expect(body.mode).toBe('zap-in');
    expect(body.slippage_bps).toBe(500);
    expect(body.provider).toBe('JUPITER_ULTRA');
    expect(result.lastValidBlockHeight).toBe(100);
  });

  it('generateZapInTx allows overriding slippage and provider', async () => {
    const fetchSpy = mockFetchOnce({
      status: 'success',
      data: {
        lastValidBlockHeight: 1,
        swapTxsWithJito: [],
        addLiquidityTxsWithJito: [],
        meta: {},
      },
    });

    await generateZapInTx({
      poolAddress: 'P',
      owner: 'O',
      inputSOL: 0.05,
      strategy: 'BidAsk',
      slippageBps: 200,
      provider: 'OKX',
    });

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.slippage_bps).toBe(200);
    expect(body.provider).toBe('OKX');
    expect(body.stratergy).toBe('BidAsk');
  });

  it('landZapInTx posts to /pools/landing-add-tx and returns the landing result', async () => {
    const fetchSpy = mockFetchOnce({
      status: 'success',
      data: { method: 'JITO', signature: 'sig123' },
    });

    const result = await landZapInTx({
      lastValidBlockHeight: 50,
      addLiquidityTxsWithJito: ['signed-add'],
      swapTxsWithJito: ['signed-swap'],
    });

    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/pools/landing-add-tx');
    expect(result.signature).toBe('sig123');
  });

  it('getZapOutQuotes posts to /position/decrease-quotes', async () => {
    const fetchSpy = mockFetchOnce({ status: 'success', data: { quote: 'shape' } });
    await getZapOutQuotes({ positionId: 'enc-pos-id', bps: 5000 });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/position/decrease-quotes');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.id).toBe('enc-pos-id');
    expect(body.bps).toBe(5000);
  });

  it('generateZapOutTx posts to /position/decrease-tx', async () => {
    const fetchSpy = mockFetchOnce({
      status: 'success',
      data: {
        lastValidBlock: 200,
        closeTxs: ['c'],
        swapTxs: ['s'],
        closeTxsWithJito: ['cj'],
        swapTxsWithJito: ['sj'],
      },
    });
    const result = await generateZapOutTx({
      positionId: 'enc',
      owner: 'O',
      bps: 10_000,
      slippageBps: 500,
      output: 'allToken1',
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.position_id).toBe('enc');
    expect(body.slippage_bps).toBe(500);
    expect(body.output).toBe('allToken1');
    expect(body.type).toBe('meteora');
    expect(result.closeTxsWithJito).toEqual(['cj']);
  });

  it('throws sanitized error on non-2xx response', async () => {
    mockFetchOnce({ error: 'rate limited' }, { ok: false, status: 429, text: 'rate limited' });
    await expect(
      generateZapInTx({ poolAddress: 'P', owner: 'O', inputSOL: 0.1, strategy: 'Spot' }),
    ).rejects.toThrow(/429/);
  });

  it('throws when LP Agent returns status != success', async () => {
    mockFetchOnce({ status: 'error', message: 'bad' });
    await expect(
      generateZapInTx({ poolAddress: 'P', owner: 'O', inputSOL: 0.1, strategy: 'Spot' }),
    ).rejects.toThrow(/status=error/);
  });

  it('throws when LP_AGENT_API_KEY is missing', async () => {
    delete process.env.LP_AGENT_API_KEY;
    await expect(
      generateZapInTx({ poolAddress: 'P', owner: 'O', inputSOL: 0.1, strategy: 'Spot' }),
    ).rejects.toThrow(/LP_AGENT_API_KEY/);
  });
});
