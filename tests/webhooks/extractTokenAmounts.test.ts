import { extractTokenAmounts } from '../../src/webhooks';
import type { HeliusEnhancedTransaction } from '../../src/webhooks';

const WALLET = 'BrkmZsy2VVfL8wgmKp1q8tH3ZyaJsm5fEvHrL6mD7vVA';
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';
const PUMP_TOKEN = 'TokenPum6dDjMhPmDsCNiKCTcaQRG3WqJaPzKjkLBcMv';

function makeTx(overrides: Partial<HeliusEnhancedTransaction> = {}): HeliusEnhancedTransaction {
  return {
    signature: 'SIG',
    timestamp: 1700000000,
    slot: 100,
    fee: 5000,
    feePayer: WALLET,
    instructions: [],
    ...overrides,
  };
}

describe('extractTokenAmounts', () => {
  it('uses accountData.tokenBalanceChanges with explicit decimals', () => {
    // 5 tokens with 9 decimals — naive tokenTransfers would return 5_000_000_000
    // and the upstream USD math would explode by 10^9. Correct value is 5.
    const tx = makeTx({
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: 0,
          tokenBalanceChanges: [
            {
              mint: PUMP_TOKEN,
              rawTokenAmount: { tokenAmount: '-5000000000', decimals: 9 },
              tokenAccount: 'ATA',
              userAccount: WALLET,
            },
          ],
        },
      ],
    });

    const out = extractTokenAmounts(tx, WALLET);
    expect(out.byMint[PUMP_TOKEN]).toBeCloseTo(-5, 6);
  });

  it('supplements native SOL when wSOL line is missing', () => {
    const tx = makeTx({
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: -500_000_000, // -0.5 SOL in lamports
          tokenBalanceChanges: [
            {
              mint: PUMP_TOKEN,
              rawTokenAmount: { tokenAmount: '1000000000', decimals: 9 },
              tokenAccount: 'ATA',
              userAccount: WALLET,
            },
          ],
        },
      ],
    });

    const out = extractTokenAmounts(tx, WALLET);
    expect(out.byMint[PUMP_TOKEN]).toBeCloseTo(1, 6);
    expect(out.byMint[WRAPPED_SOL]).toBeCloseTo(-0.5, 6);
  });

  it('does NOT double-count SOL when wSOL is present in tokenBalanceChanges', () => {
    const tx = makeTx({
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: -100_000_000, // -0.1 SOL — should be ignored, already in balance changes
          tokenBalanceChanges: [
            {
              mint: WRAPPED_SOL,
              rawTokenAmount: { tokenAmount: '-2000000000', decimals: 9 },
              tokenAccount: 'WSOL_ATA',
              userAccount: WALLET,
            },
          ],
        },
      ],
    });

    const out = extractTokenAmounts(tx, WALLET);
    expect(out.byMint[WRAPPED_SOL]).toBeCloseTo(-2, 6); // not -2.1
  });

  it('ignores trivial nativeBalanceChange (rent + tx fee)', () => {
    const tx = makeTx({
      accountData: [
        {
          account: WALLET,
          nativeBalanceChange: -5_000, // 0.000005 SOL — just fee
          tokenBalanceChanges: [
            {
              mint: PUMP_TOKEN,
              rawTokenAmount: { tokenAmount: '500000000', decimals: 9 },
              tokenAccount: 'ATA',
              userAccount: WALLET,
            },
          ],
        },
      ],
    });

    const out = extractTokenAmounts(tx, WALLET);
    expect(out.byMint[WRAPPED_SOL]).toBeUndefined();
    expect(out.byMint[PUMP_TOKEN]).toBeCloseTo(0.5, 6);
  });

  it('falls back to tokenTransfers when accountData is empty', () => {
    const tx = makeTx({
      tokenTransfers: [
        {
          fromUserAccount: WALLET,
          toUserAccount: 'POOL',
          fromTokenAccount: 'ATA',
          toTokenAccount: 'POOL_ATA',
          tokenAmount: 3,
          mint: PUMP_TOKEN,
          tokenStandard: 'Fungible',
        },
      ],
    });

    const out = extractTokenAmounts(tx, WALLET);
    expect(out.byMint[PUMP_TOKEN]).toBeCloseTo(-3, 6);
  });

  it('returns empty result when there is no signal', () => {
    const tx = makeTx();
    const out = extractTokenAmounts(tx, WALLET);
    expect(out.transfers).toEqual([]);
    expect(out.byMint).toEqual({});
  });
});
