import type { RecommendationPacket } from '@nemesis/bridge-contracts';
import {
  computeNetEdge,
  kalshiFeePerContract,
  type KalshiMarket,
  type ThesisCard,
  type ThesisStatus,
} from '@nemesis/core';

function clamp(value: number, min = 0.01, max = 0.99): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function statusForClassification(classification: RecommendationPacket['classification']): ThesisStatus {
  if (classification === 'institutional-prime' || classification === 'elite' || classification === 'strong') {
    return 'tradeable';
  }
  if (classification === 'watch-for-entry') return 'qualified';
  if (classification === 'paper-research') return 'watch-only';
  if (classification === 'blocked') return 'blocked';
  return 'observe';
}

function entryMid(packet: RecommendationPacket): number {
  return clamp((packet.entry_zone_low + packet.entry_zone_high) / 2);
}

export function recommendationToThesis(
  packet: RecommendationPacket,
  market?: KalshiMarket,
  now = Date.now(),
): ThesisCard {
  const yesEntry = entryMid(packet);
  const side: 'yes' | 'no' = packet.nemesis_probability >= yesEntry ? 'yes' : 'no';
  const marketPrice = side === 'yes' ? yesEntry : 1 - yesEntry;
  const impliedPrice = side === 'yes'
    ? clamp(packet.nemesis_probability)
    : clamp(1 - packet.nemesis_probability);
  const spread = Math.max(0.01, Math.abs(packet.entry_zone_high - packet.entry_zone_low));
  const computed = computeNetEdge(impliedPrice, marketPrice, spread, 0);
  const grossEdge = Number.isFinite(packet.raw_edge) ? Math.max(0, packet.raw_edge) : computed.grossEdge;
  const netEdge = Number.isFinite(packet.net_ev) ? Math.max(0, packet.net_ev) : computed.netEdge;
  const predictability = Math.round(packet.alpha_score);
  const clarity = Math.round(packet.settlement_clarity_score * 100);

  return {
    id: `gea-${packet.id}`,
    ticker: packet.ticker,
    title: market?.title ?? packet.ticker,
    category: market?.category ?? 'global-event-alpha',
    playbook: 'global-pulse',
    status: statusForClassification(packet.classification),
    side,
    marketPrice,
    impliedPrice,
    grossEdge,
    netEdge,
    spread,
    depthUsd: market?.open_interest ?? market?.volume_24h ?? market?.volume ?? 250,
    predictability,
    feeEstimate: kalshiFeePerContract(marketPrice),
    signalReason: `GEA ${packet.classification} ${side.toUpperCase()} entry ${Math.round(marketPrice * 100)}¢`,
    externalSummary: `Global Event Alpha model ${packet.model_version} · p=${(packet.nemesis_probability * 100).toFixed(1)}% · clarity ${clarity}%`,
    createdAt: packet.created_at,
    updatedAt: now,
    freshnessMs: Math.max(0, now - packet.created_at),
    edgeHistory: [netEdge],
    drivers: [
      { label: 'GEA alpha score', impact: packet.alpha_score / 100, detail: `${packet.alpha_score.toFixed(0)} / 100` },
      { label: 'Model probability', impact: packet.nemesis_probability - yesEntry, detail: `${(packet.nemesis_probability * 100).toFixed(1)}% vs entry ${(yesEntry * 100).toFixed(1)}%` },
      { label: 'Settlement clarity', impact: packet.settlement_clarity_score, detail: `${clarity}%` },
    ],
    invalidations: packet.block_reason ? [packet.block_reason] : [],
    sourceMove: 'news-driven',
  };
}

export function upsertRecommendationThesis(
  cards: ThesisCard[],
  packet: RecommendationPacket,
  market?: KalshiMarket,
  now = Date.now(),
): ThesisCard[] {
  const card = recommendationToThesis(packet, market, now);
  const others = cards.filter((existing) => existing.id !== card.id);
  return [card, ...others];
}

export function recommendationToMarket(
  packet: RecommendationPacket,
  existing?: KalshiMarket,
): KalshiMarket {
  const yesMid = entryMid(packet);
  const yes = Math.round(yesMid * 100);
  const spread = Math.max(1, Math.round(Math.abs(packet.entry_zone_high - packet.entry_zone_low) * 100));
  return {
    ...existing,
    ticker: packet.ticker,
    title: existing?.title ?? packet.ticker,
    status: existing?.status ?? 'open',
    yes_bid: existing?.yes_bid ?? Math.max(1, yes - Math.ceil(spread / 2)),
    yes_ask: existing?.yes_ask ?? Math.min(99, yes + Math.ceil(spread / 2)),
    no_bid: existing?.no_bid ?? Math.max(1, 100 - yes - Math.ceil(spread / 2)),
    no_ask: existing?.no_ask ?? Math.min(99, 100 - yes + Math.ceil(spread / 2)),
    volume: existing?.volume ?? 0,
    volume_24h: existing?.volume_24h ?? 0,
    category: existing?.category ?? 'global-event-alpha',
  };
}

export function upsertRecommendationMarket(
  markets: KalshiMarket[],
  packet: RecommendationPacket,
  existing?: KalshiMarket,
): KalshiMarket[] {
  const market = recommendationToMarket(packet, existing);
  const others = markets.filter((item) => item.ticker !== market.ticker);
  return [market, ...others];
}
