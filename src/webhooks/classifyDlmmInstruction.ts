/**
 * Classify a DLMM instruction into a high-level alert type.
 *
 * Three signals in priority order:
 *
 *   1. Helius `parsed.type` (most reliable when present)
 *   2. Transaction `description` (helpful for newer instructions)
 *   3. (TrackLP also decodes the base58 discriminator — kept out of
 *      this reference because correct Anchor IDL decoding adds enough
 *      surface area to be its own module.)
 *
 * Returns `null` if none of the heuristics fire. Callers should treat
 * `null` as "unknown DLMM op" and either skip or store as raw.
 */
import type { DlmmAlertType, HeliusInstruction } from './types';

/** Direct name → type mapping. Lowercased keys to make matching case-insensitive. */
const NAME_MAP: Record<string, DlmmAlertType> = {
  initializeposition: 'POSITION_OPEN',
  initializepositionpda: 'POSITION_OPEN',
  initializepositionbyoperator: 'POSITION_OPEN',

  addliquidity: 'DEPOSIT',
  addliquiditybyweight: 'DEPOSIT',
  addliquiditybystrategy: 'DEPOSIT',
  addliquiditybystrategyoneside: 'DEPOSIT',
  addliquidityoneside: 'DEPOSIT',
  addliquidityonesideprecise: 'DEPOSIT',

  removeliquidity: 'WITHDRAW',
  removeallliquidity: 'WITHDRAW',
  removeliquiditybyrange: 'WITHDRAW',

  closeposition: 'POSITION_CLOSE',
  closepositionbyoperator: 'POSITION_CLOSE',

  claimfee: 'CLAIM_FEE',
  claimreward: 'CLAIM_FEE',
};

/** Regex patterns for cases where the instruction name has extra suffix/prefix. */
const NAME_PATTERNS: Array<{ pattern: RegExp; type: DlmmAlertType }> = [
  { pattern: /initialize.*position/i, type: 'POSITION_OPEN' },
  { pattern: /add.*liquidity/i, type: 'DEPOSIT' },
  { pattern: /remove.*liquidity/i, type: 'WITHDRAW' },
  { pattern: /close.*position/i, type: 'POSITION_CLOSE' },
  { pattern: /claim.*(fee|reward)/i, type: 'CLAIM_FEE' },
];

export function classifyDlmmInstruction(
  instruction: HeliusInstruction,
  txDescription?: string,
): DlmmAlertType | null {
  // 1. Parsed.type direct hit
  const parsedType = instruction.parsed?.type;
  if (parsedType) {
    const direct = NAME_MAP[parsedType.toLowerCase()];
    if (direct) return direct;
    for (const { pattern, type } of NAME_PATTERNS) {
      if (pattern.test(parsedType)) return type;
    }
  }

  // 2. Description
  if (txDescription) {
    const desc = txDescription.toLowerCase();
    if (desc.includes('opened') || desc.includes('initialize') || desc.includes('created position')) {
      return 'POSITION_OPEN';
    }
    if (desc.includes('closed') || desc.includes('close position')) {
      return 'POSITION_CLOSE';
    }
    if (desc.includes('added liquidity') || desc.includes('deposit')) {
      return 'DEPOSIT';
    }
    if (desc.includes('removed liquidity') || desc.includes('withdraw')) {
      return 'WITHDRAW';
    }
    if (desc.includes('claimed') || desc.includes('claim fee') || desc.includes('claim reward')) {
      return 'CLAIM_FEE';
    }
  }

  return null;
}
