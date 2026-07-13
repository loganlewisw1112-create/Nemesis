import { describe, expect, it } from 'vitest';
import type { RecommendationPacket } from '@nemesis/bridge-contracts';
import { isEntryEligible } from '@nemesis/execution';
import {
  recommendationToThesis,
  upsertRecommendationThesis,
} from './bridgeRecommendations.js';

function packet(overrides: Partial<RecommendationPacket> = {}): RecommendationPacket {
  return {
    id: 'gea-rec-1',
    brain_role: 'primary',
    model_version: 'alpha-v1',
    ticker: 'KXGEA-26',
    classification: 'elite',
    alpha_score: 91,
    nemesis_probability: 0.64,
    confidence_band_low: 0.58,
    confidence_band_high: 0.69,
    net_ev: 0.08,
    raw_edge: 0.12,
    entry_zone_low: 0.42,
    entry_zone_high: 0.48,
    do_not_chase_level: 0.54,
    target_exit: 0.68,
    settlement_clarity_score: 0.82,
    hold_class: 'intraday',
    expires_at: 1_772_000_060_000,
    created_at: 1_772_000_000_000,
    ...overrides,
  };
}

describe('NEMESIS bridge recommendation mapping', () => {
  it('turns a valid GEA entry recommendation into a visible thesis card', () => {
    const card = recommendationToThesis(packet(), undefined, 1_772_000_001_000);

    expect(card).toMatchObject({
      id: 'gea-gea-rec-1',
      ticker: 'KXGEA-26',
      title: 'KXGEA-26',
      playbook: 'global-pulse',
      status: 'tradeable',
      side: 'yes',
      impliedPrice: 0.64,
      netEdge: 0.08,
      predictability: 91,
      sourceMove: 'news-driven',
    });
    expect(card.marketPrice).toBeCloseTo(0.45);
    expect(card.signalReason).toContain('GEA elite');
    expect(card.externalSummary).toContain('model alpha-v1');
    expect(isEntryEligible(card)).toBe(false);
  });

  it('upserts refreshed GEA tickets instead of duplicating them', () => {
    const first = upsertRecommendationThesis([], packet({ net_ev: 0.06 }), undefined, 1);
    const second = upsertRecommendationThesis(first, packet({ net_ev: 0.09 }), undefined, 2);

    expect(second).toHaveLength(1);
    expect(second[0].netEdge).toBe(0.09);
    expect(second[0].updatedAt).toBe(2);
  });
});
