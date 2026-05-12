/**
 * Executor tests — verifies the orchestration helpers (generate → sign
 * → land) wire LP Agent and the supplied Signer correctly, fire the
 * audit hook on both success and failure paths, and isolate hook
 * failures from the trade result.
 */

import {
  executeZapCopyOpen,
  executeZapCloseOpen,
  type Signer,
  type ExecutionRecord,
} from '../../src/lpAgent/executor';

const ORIGINAL_KEY = process.env.LP_AGENT_API_KEY;

function mockFetchSequence(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const spy = jest.spyOn(global, 'fetch');
  for (const r of responses) {
    spy.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as unknown as Response);
  }
  return spy;
}

const TEST_OWNER = 'OwNerPub1ic38ByteAddressBase58XXXXXXXXXXXXXX';
const TEST_POSITION = 'P0sIt10nAddressBase58XXXXXXXXXXXXXXXXXXXXXXX';
const TEST_POOL = 'P00lAddressBase58XXXXXXXXXXXXXXXXXXXXXXXXXXX';
const TEST_ENCRYPTED_ID = 'eyJlbmNyeXB0ZWRJZCJ9';

function makeSpyingSigner(opts: { fail?: boolean } = {}): {
  signer: Signer;
  signedInputs: string[][];
} {
  const signedInputs: string[][] = [];
  return {
    signedInputs,
    signer: {
      publicKey: TEST_OWNER,
      async signAll(txs) {
        signedInputs.push(txs);
        if (opts.fail) throw new Error('signer rejected');
        // Append a signed marker so we can assert order preservation.
        return txs.map((t, i) => `${t}|signed:${i}`);
      },
    },
  };
}

beforeEach(() => {
  process.env.LP_AGENT_API_KEY = 'test-api-key';
  jest.restoreAllMocks();
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.LP_AGENT_API_KEY;
  else process.env.LP_AGENT_API_KEY = ORIGINAL_KEY;
});

describe('executeZapCopyOpen', () => {
  it('threads owner + percentX into generateZapInTx, signs, and lands', async () => {
    const fetchSpy = mockFetchSequence([
      {
        body: {
          status: 'success',
          data: {
            lastValidBlockHeight: 100,
            swapTxsWithJito: ['swap-1'],
            addLiquidityTxsWithJito: ['add-1', 'add-2'],
            meta: { provider: 'JUPITER_ULTRA' },
          },
        },
      },
      {
        body: {
          status: 'success',
          data: { method: 'JITO', signature: 'sig-confirm' },
        },
      },
    ]);
    const { signer, signedInputs } = makeSpyingSigner();

    const result = await executeZapCopyOpen(
      {
        poolAddress: TEST_POOL,
        sourcePositionAddress: TEST_POSITION,
        copyAmountSol: 0.5,
        fromBinId: 100,
        toBinId: 134,
        strategy: 'Spot',
        percentX: 1,
        slippageBps: 500,
      },
      signer,
    );

    expect(result).toEqual({
      status: 'confirmed',
      transactionSignature: 'sig-confirm',
    });

    // First fetch was the generate call.
    const generateCall = fetchSpy.mock.calls[0];
    expect(String(generateCall[0])).toContain(`/pools/${TEST_POOL}/add-tx`);
    const generateBody = JSON.parse(String((generateCall[1] as RequestInit).body));
    expect(generateBody).toEqual(
      expect.objectContaining({
        owner: TEST_OWNER,
        inputSOL: 0.5,
        percentX: 1,
        fromBinId: 100,
        toBinId: 134,
        stratergy: 'Spot', // honors LP Agent's typo
        mode: 'zap-in',
      }),
    );

    // Signer saw swap+add concatenated in order.
    expect(signedInputs).toHaveLength(1);
    expect(signedInputs[0]).toEqual(['swap-1', 'add-1', 'add-2']);

    // Landing call split the signed array back into swap vs add.
    const landCall = fetchSpy.mock.calls[1];
    expect(String(landCall[0])).toContain('/pools/landing-add-tx');
    const landBody = JSON.parse(String((landCall[1] as RequestInit).body));
    expect(landBody.swapTxsWithJito).toEqual(['swap-1|signed:0']);
    expect(landBody.addLiquidityTxsWithJito).toEqual([
      'add-1|signed:1',
      'add-2|signed:2',
    ]);
  });

  it('fires onExecutionRecord with confirmed status on success', async () => {
    mockFetchSequence([
      {
        body: {
          status: 'success',
          data: {
            lastValidBlockHeight: 100,
            swapTxsWithJito: [],
            addLiquidityTxsWithJito: ['a'],
            meta: {},
          },
        },
      },
      {
        body: { status: 'success', data: { method: 'JITO', signature: 'sig-ok' } },
      },
    ]);
    const { signer } = makeSpyingSigner();
    const records: ExecutionRecord[] = [];

    await executeZapCopyOpen(
      {
        poolAddress: TEST_POOL,
        sourcePositionAddress: TEST_POSITION,
        copyAmountSol: 0.3,
        fromBinId: 0,
        toBinId: 50,
        strategy: 'Spot',
        percentX: 0,
      },
      signer,
      { onExecutionRecord: async (r) => void records.push(r) },
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      action: 'OPEN',
      status: 'confirmed',
      transactionSignature: 'sig-ok',
      owner: TEST_OWNER,
      poolAddress: TEST_POOL,
      sourcePositionAddress: TEST_POSITION,
      copyAmountSol: 0.3,
    });
  });

  it('returns failed + records failed when generate throws', async () => {
    mockFetchSequence([
      {
        ok: false,
        status: 500,
        body: { status: 'error', message: 'Amount X or Amount Y or Percent X is required' },
      },
    ]);
    const { signer } = makeSpyingSigner();
    const records: ExecutionRecord[] = [];

    const result = await executeZapCopyOpen(
      {
        poolAddress: TEST_POOL,
        sourcePositionAddress: TEST_POSITION,
        copyAmountSol: 0.5,
        fromBinId: 0,
        toBinId: 50,
        strategy: 'Spot',
        percentX: 1,
      },
      signer,
      { onExecutionRecord: async (r) => void records.push(r) },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/500/);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('failed');
    expect(records[0].action).toBe('OPEN');
    expect(records[0].errorMessage).toMatch(/500/);
  });

  it('returns failed when the signer throws', async () => {
    mockFetchSequence([
      {
        body: {
          status: 'success',
          data: {
            lastValidBlockHeight: 100,
            swapTxsWithJito: [],
            addLiquidityTxsWithJito: ['a'],
            meta: {},
          },
        },
      },
    ]);
    const { signer } = makeSpyingSigner({ fail: true });

    const result = await executeZapCopyOpen(
      {
        poolAddress: TEST_POOL,
        sourcePositionAddress: TEST_POSITION,
        copyAmountSol: 0.5,
        fromBinId: 0,
        toBinId: 50,
        strategy: 'Spot',
        percentX: 1,
      },
      signer,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('signer rejected');
  });

  it('hook failure does not affect confirmed result', async () => {
    mockFetchSequence([
      {
        body: {
          status: 'success',
          data: {
            lastValidBlockHeight: 100,
            swapTxsWithJito: [],
            addLiquidityTxsWithJito: ['a'],
            meta: {},
          },
        },
      },
      {
        body: { status: 'success', data: { method: 'JITO', signature: 'sig-x' } },
      },
    ]);
    const { signer } = makeSpyingSigner();
    const warnings: string[] = [];

    const result = await executeZapCopyOpen(
      {
        poolAddress: TEST_POOL,
        sourcePositionAddress: TEST_POSITION,
        copyAmountSol: 0.5,
        fromBinId: 0,
        toBinId: 50,
        strategy: 'Spot',
        percentX: 1,
      },
      signer,
      {
        onExecutionRecord: async () => {
          throw new Error('audit DB down');
        },
        logger: {
          warn: (m) => warnings.push(String(m)),
          error: () => {
            /* ignore */
          },
        },
      },
    );

    expect(result.status).toBe('confirmed');
    expect(result.transactionSignature).toBe('sig-x');
    expect(warnings.some((w) => /hook failed/.test(w))).toBe(true);
  });
});

describe('executeZapCloseOpen', () => {
  it('threads encrypted id + defaults into generateZapOutTx, signs close + swap, lands', async () => {
    const fetchSpy = mockFetchSequence([
      {
        body: {
          status: 'success',
          data: {
            lastValidBlock: 200,
            closeTxs: [],
            swapTxs: [],
            closeTxsWithJito: ['close-1', 'close-2'],
            swapTxsWithJito: ['swap-1'],
          },
        },
      },
      {
        body: {
          status: 'success',
          data: { method: 'JITO', signature: 'sig-close' },
        },
      },
    ]);
    const { signer, signedInputs } = makeSpyingSigner();

    const result = await executeZapCloseOpen(
      {
        poolAddress: TEST_POOL,
        sourcePositionAddress: TEST_POSITION,
        positionId: TEST_ENCRYPTED_ID,
      },
      signer,
    );

    expect(result).toEqual({
      status: 'confirmed',
      transactionSignature: 'sig-close',
    });

    const generateCall = fetchSpy.mock.calls[0];
    expect(String(generateCall[0])).toContain('/position/decrease-tx');
    const generateBody = JSON.parse(String((generateCall[1] as RequestInit).body));
    expect(generateBody).toEqual(
      expect.objectContaining({
        position_id: TEST_ENCRYPTED_ID,
        owner: TEST_OWNER,
        bps: 10000,
        slippage_bps: 500,
        output: 'allBaseToken',
      }),
    );

    // Signer saw close+swap concatenated in order.
    expect(signedInputs[0]).toEqual(['close-1', 'close-2', 'swap-1']);

    const landCall = fetchSpy.mock.calls[1];
    expect(String(landCall[0])).toContain('/position/landing-decrease-tx');
    const landBody = JSON.parse(String((landCall[1] as RequestInit).body));
    expect(landBody.closeTxsWithJito).toEqual([
      'close-1|signed:0',
      'close-2|signed:1',
    ]);
    expect(landBody.swapTxsWithJito).toEqual(['swap-1|signed:2']);
  });

  it('respects bps + output overrides', async () => {
    const fetchSpy = mockFetchSequence([
      {
        body: {
          status: 'success',
          data: {
            lastValidBlock: 200,
            closeTxs: [],
            swapTxs: [],
            closeTxsWithJito: ['c'],
            swapTxsWithJito: [],
          },
        },
      },
      {
        body: { status: 'success', data: { method: 'JITO', signature: 's' } },
      },
    ]);
    const { signer } = makeSpyingSigner();

    await executeZapCloseOpen(
      {
        poolAddress: TEST_POOL,
        sourcePositionAddress: TEST_POSITION,
        positionId: TEST_ENCRYPTED_ID,
        bps: 5000,
        output: 'both',
      },
      signer,
    );

    const generateBody = JSON.parse(
      String((fetchSpy.mock.calls[0][1] as RequestInit).body),
    );
    expect(generateBody.bps).toBe(5000);
    expect(generateBody.output).toBe('both');
  });

  it('returns failed when landing endpoint returns non-success', async () => {
    mockFetchSequence([
      {
        body: {
          status: 'success',
          data: {
            lastValidBlock: 200,
            closeTxs: [],
            swapTxs: [],
            closeTxsWithJito: ['c'],
            swapTxsWithJito: [],
          },
        },
      },
      { ok: false, status: 500, body: { status: 'error' } },
    ]);
    const { signer } = makeSpyingSigner();

    const result = await executeZapCloseOpen(
      {
        poolAddress: TEST_POOL,
        sourcePositionAddress: TEST_POSITION,
        positionId: TEST_ENCRYPTED_ID,
      },
      signer,
    );

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/500/);
  });
});
