import {
  DLMM_PROGRAM_ID,
  isDlmmTransaction,
} from '../../src/webhooks';
import type { HeliusEnhancedTransaction } from '../../src/webhooks';

function tx(instructions: HeliusEnhancedTransaction['instructions']): HeliusEnhancedTransaction {
  return {
    signature: 'SIG',
    timestamp: 1,
    slot: 1,
    fee: 5000,
    feePayer: 'FEE_PAYER',
    instructions,
  };
}

describe('isDlmmTransaction', () => {
  it('returns true for a top-level DLMM instruction', () => {
    expect(
      isDlmmTransaction(
        tx([{ programId: DLMM_PROGRAM_ID, accounts: [], data: '' }]),
      ),
    ).toBe(true);
  });

  it('returns true when DLMM is called via inner CPI (wrapper programs)', () => {
    expect(
      isDlmmTransaction(
        tx([
          {
            programId: 'WrapperProgram111111111111111111111111111111',
            accounts: [],
            data: '',
            innerInstructions: [
              { programId: DLMM_PROGRAM_ID, accounts: [], data: '' },
            ],
          },
        ]),
      ),
    ).toBe(true);
  });

  it('returns false for unrelated transactions', () => {
    expect(
      isDlmmTransaction(
        tx([
          {
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            accounts: [],
            data: '',
          },
        ]),
      ),
    ).toBe(false);
  });

  it('returns false for an empty instruction list', () => {
    expect(isDlmmTransaction(tx([]))).toBe(false);
  });
});
