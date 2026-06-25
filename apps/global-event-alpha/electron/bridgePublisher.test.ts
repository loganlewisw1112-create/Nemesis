import { describe, expect, it } from 'vitest';
import { validateRecommendationPacket } from '@nemesis/bridge-contracts';
import { createEntryRecommendationPacket } from './bridgePublisher.js';

describe('GEA bridge publisher', () => {
  it('publishes a valid primary entry recommendation when the intelligence state is tradeable', () => {
    const packet = createEntryRecommendationPacket({
      role: 'primary',
      id: 'KXGEA-26:alpha-v1',
      modelVersion: 'alpha-v1',
      ticker: 'KXGEA-26',
      alphaScore: 88,
      classification: 'elite',
      nemesisProbability: 0.63,
      confidenceBandLow: 0.57,
      confidenceBandHigh: 0.68,
      netEdge: 0.075,
      rawEdge: 0.11,
      entryZoneLow: 0.42,
      entryZoneHigh: 0.47,
      doNotChaseLevel: 0.53,
      targetExit: 0.66,
      settlementClarityScore: 0.8,
      holdClass: 'intraday',
      noTradeBlocked: false,
      now: 1_772_000_000_000,
    });

    expect(packet).toMatchObject({
      id: 'KXGEA-26:alpha-v1',
      brain_role: 'primary',
      ticker: 'KXGEA-26',
      classification: 'elite',
      net_ev: 0.075,
      raw_edge: 0.11,
      created_at: 1_772_000_000_000,
      expires_at: 1_772_000_030_000,
    });
    expect(validateRecommendationPacket(packet, { now: 1_772_000_000_000 }).ok).toBe(true);
  });

  it('does not publish an entry packet for blocked no-trade decisions', () => {
    expect(createEntryRecommendationPacket({
      role: 'primary',
      id: 'blocked',
      modelVersion: 'alpha-v1',
      ticker: 'KXBLOCKED-26',
      alphaScore: 88,
      classification: 'elite',
      nemesisProbability: 0.63,
      confidenceBandLow: 0.57,
      confidenceBandHigh: 0.68,
      netEdge: 0.075,
      rawEdge: 0.11,
      entryZoneLow: 0.42,
      entryZoneHigh: 0.47,
      doNotChaseLevel: 0.53,
      targetExit: 0.66,
      settlementClarityScore: 0.8,
      holdClass: 'intraday',
      noTradeBlocked: true,
      now: 1_772_000_000_000,
    })).toBeNull();
  });
});
