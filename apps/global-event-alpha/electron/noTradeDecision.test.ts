import { describe, expect, it } from 'vitest';
import { noTradeDecisionSignature } from './noTradeDecision.js';

describe('no-trade decision identity', () => {
  it('does not flood evidence when only the next recheck time moves', () => {
    const first = {
      ticker: 'KXTEST',
      reasons: ['DATA_STALE'],
      what_would_need_to_change: 'fresh exchange data',
      recheck_at: 1_000,
    };
    const second = { ...first, recheck_at: 2_000 };

    expect(noTradeDecisionSignature(first)).toBe(noTradeDecisionSignature(second));
  });

  it('changes when the blocking rationale changes', () => {
    const base = {
      ticker: 'KXTEST',
      reasons: ['DATA_STALE'],
      what_would_need_to_change: 'fresh exchange data',
    };

    expect(noTradeDecisionSignature(base)).not.toBe(noTradeDecisionSignature({
      ...base,
      reasons: ['LIQUIDITY_TOO_THIN'],
    }));
  });
});
