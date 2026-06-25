import type { ThesisCard } from '@nemesis/core';

export interface AllocationInput {
  card: ThesisCard;
  maxPositionUsd: number;
  kellyCap?: number;
  midSessionIncreaseBlocked?: boolean;
}

export function allocateSize(input: AllocationInput): number {
  const { card, maxPositionUsd, kellyCap = 0.25 } = input;
  if (input.midSessionIncreaseBlocked) return Math.min(maxPositionUsd * 0.5, maxPositionUsd);
  const edgeFactor = Math.max(0, Math.min(1, card.netEdge * 10));
  const predFactor = card.predictability / 100;
  const raw = maxPositionUsd * kellyCap * edgeFactor * predFactor;
  return Math.max(1, Math.round(raw * 100) / 100);
}

export interface ExposureCheck {
  ticker: string;
  eventTicker?: string;
  category: string;
}

export function checkConcentration(
  existing: ExposureCheck[],
  candidate: ExposureCheck,
  maxPerEvent = 2,
  maxPerCategory = 4,
): { blocked: boolean; reason?: string } {
  const sameEvent = existing.filter((e) => e.eventTicker && e.eventTicker === candidate.eventTicker).length;
  if (candidate.eventTicker && sameEvent >= maxPerEvent) {
    return { blocked: true, reason: 'event concentration limit' };
  }
  const sameCat = existing.filter((e) => e.category === candidate.category).length;
  if (sameCat >= maxPerCategory) {
    return { blocked: true, reason: 'category concentration limit' };
  }
  return { blocked: false };
}
