import type { BrainRole, Classification, RecommendationPacket } from '@nemesis/bridge-contracts';
import { validateRecommendationPacket } from '@nemesis/bridge-contracts';

export interface EntryRecommendationInput {
  role: BrainRole;
  id: string;
  modelVersion: string;
  ticker: string;
  alphaScore: number;
  classification: Classification;
  nemesisProbability: number;
  confidenceBandLow: number;
  confidenceBandHigh: number;
  netEdge: number;
  rawEdge: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  doNotChaseLevel: number;
  targetExit: number;
  settlementClarityScore: number;
  holdClass: RecommendationPacket['hold_class'];
  noTradeBlocked: boolean;
  now?: number;
  ttlMs?: number;
}

export function createEntryRecommendationPacket(input: EntryRecommendationInput): RecommendationPacket | null {
  if (input.noTradeBlocked || input.netEdge <= 0 || input.classification === 'ignore' || input.classification === 'blocked') {
    return null;
  }

  const now = input.now ?? Date.now();
  const packet: RecommendationPacket = {
    id: input.id,
    brain_role: input.role,
    model_version: input.modelVersion,
    ticker: input.ticker,
    classification: input.classification,
    alpha_score: input.alphaScore,
    nemesis_probability: input.nemesisProbability,
    confidence_band_low: input.confidenceBandLow,
    confidence_band_high: input.confidenceBandHigh,
    net_ev: input.netEdge,
    raw_edge: input.rawEdge,
    entry_zone_low: input.entryZoneLow,
    entry_zone_high: input.entryZoneHigh,
    do_not_chase_level: input.doNotChaseLevel,
    target_exit: input.targetExit,
    settlement_clarity_score: input.settlementClarityScore,
    hold_class: input.holdClass,
    created_at: now,
    expires_at: now + (input.ttlMs ?? 30_000),
  };

  const validation = validateRecommendationPacket(packet, { now });
  return validation.ok ? validation.value : null;
}
