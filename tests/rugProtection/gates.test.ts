import { runRugGates } from '../../src/rugProtection';

const SOL = 'So11111111111111111111111111111111111111112';
// Module-level cache in holderCount.ts is keyed by mint — use a unique
// mint per test so cached results don't leak between cases.
let mintCounter = 0;
function nextMint(): string {
  mintCounter++;
  return `Risky${String(mintCounter).padStart(40, 'a')}`;
}

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return jest.spyOn(global, 'fetch').mockImplementation(impl as never);
}

function mintAccountBase64(opts: { mintDisabled: boolean; freezeDisabled: boolean }): string {
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(opts.mintDisabled ? 0 : 1, 0);
  buf.writeUInt32LE(opts.freezeDisabled ? 0 : 1, 46);
  return buf.toString('base64');
}

describe('runRugGates', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    process.env.HELIUS_RPC_URL = 'https://example.helius.test/?api-key=test';
  });

  it('fails CLOSED when holder-count RPC returns an error', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: { code: -32600, message: 'Too many accounts requested' } }),
        { status: 200 },
      ),
    );

    const outcome = await runRugGates({
      tokenXMint: SOL,
      tokenYMint: nextMint(),
      quoteMint: SOL,
      poolAddress: 'POOL',
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failedGate).toBe('holderCount');
    expect(outcome.results[0].sourceOk).toBe(false);
    expect(outcome.results[0].value).toBeNull();
  });

  it('fails when holder count is below threshold', async () => {
    // 5 accounts with amount > 0 — the post-mortem case
    const fewHolders = Array.from({ length: 5 }, () => ({ amount: '1000' }));
    mockFetch(async () =>
      new Response(
        JSON.stringify({ result: { token_accounts: fewHolders } }),
        { status: 200 },
      ),
    );

    const outcome = await runRugGates({
      tokenXMint: SOL,
      tokenYMint: nextMint(),
      quoteMint: SOL,
      poolAddress: 'POOL',
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failedGate).toBe('holderCount');
    expect(outcome.results[0].sourceOk).toBe(true);
    expect(outcome.results[0].value).toBe(5);
  });

  it('fails when mint authority is still set', async () => {
    let call = 0;
    mockFetch(async (_url, init) => {
      call++;
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.method === 'getTokenAccounts') {
        // 300 holders — passes holder count
        const accounts = Array.from({ length: 300 }, () => ({ amount: '1000' }));
        return new Response(
          JSON.stringify({ result: { token_accounts: accounts } }),
          { status: 200 },
        );
      }
      if (body.method === 'getAccountInfo') {
        // mint authority STILL SET
        return new Response(
          JSON.stringify({
            result: {
              value: {
                data: [mintAccountBase64({ mintDisabled: false, freezeDisabled: true }), 'base64'],
              },
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected method ${body.method}`);
    });

    const outcome = await runRugGates({
      tokenXMint: SOL,
      tokenYMint: nextMint(),
      quoteMint: SOL,
      poolAddress: 'POOL',
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failedGate).toBe('mintAuthority');
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it('fails when freeze authority is still set', async () => {
    mockFetch(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.method === 'getTokenAccounts') {
        const accounts = Array.from({ length: 300 }, () => ({ amount: '1000' }));
        return new Response(
          JSON.stringify({ result: { token_accounts: accounts } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          result: {
            value: {
              data: [mintAccountBase64({ mintDisabled: true, freezeDisabled: false }), 'base64'],
            },
          },
        }),
        { status: 200 },
      );
    });

    const outcome = await runRugGates({
      tokenXMint: SOL,
      tokenYMint: nextMint(),
      quoteMint: SOL,
      poolAddress: 'POOL',
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failedGate).toBe('freezeAuthority');
  });

  it('passes when all gates clear', async () => {
    mockFetch(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      if (body.method === 'getTokenAccounts') {
        const accounts = Array.from({ length: 1000 }, () => ({ amount: '1000' }));
        return new Response(
          JSON.stringify({ result: { token_accounts: accounts } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          result: {
            value: {
              data: [mintAccountBase64({ mintDisabled: true, freezeDisabled: true }), 'base64'],
            },
          },
        }),
        { status: 200 },
      );
    });

    const outcome = await runRugGates({
      tokenXMint: SOL,
      tokenYMint: nextMint(),
      quoteMint: SOL,
      poolAddress: 'POOL',
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.failedGate).toBeNull();
    expect(outcome.results.map((r) => r.name)).toEqual([
      'holderCount',
      'mintAuthority',
      'freezeAuthority',
    ]);
  });

  it('uses the sentinel for SOL without an RPC call', async () => {
    // The risky mint is SOL itself (degenerate case) — should short-circuit
    const fetchSpy = mockFetch(async () =>
      new Response(JSON.stringify({}), { status: 500 }),
    );

    const outcome = await runRugGates({
      tokenXMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      tokenYMint: SOL,
      quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      poolAddress: 'POOL',
    });

    expect(outcome.results[0].value).toBe(999999);
    // No RPC call should have been made for the holder count (sentinel)
    // but the mint-authority check still calls — so fetch is called at
    // least once for the authority but not for the holder count.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
