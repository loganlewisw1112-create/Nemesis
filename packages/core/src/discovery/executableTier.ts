import { kalshiFeePerContract, walkBookFill } from '../fees/kalshiFee.js';
import type { KalshiOrderbook, ThesisCard } from '../types.js';
import type { DiscoveryPreset, ExecutableTier, SideDepthResult } from './types.js';

export interface TierThreshold {
  tier: ExecutableTier;
  minFillableUsd: number;
  maxSlippagePp: number;
}

const BASE_THRESHOLDS: TierThreshold[] = [
  { tier: 'whale', minFillableUsd: 500, maxSlippagePp: 0.05 },
  { tier: 'solid', minFillableUsd: 250, maxSlippagePp: 0.03 },
  { tier: 'scout', minFillableUsd: 100, maxSlippagePp: 0.02 },
];
const MIN_FILLABLE_USD: Record<ExecutableTier, number> = {
  scout: 100,
  solid: 250,
  whale: 500,
};

const TIER_ORDER: Record<ExecutableTier, number> = { whale: 0, solid: 1, scout: 2 };

export function getTierThresholds(preset: DiscoveryPreset = 'balanced'): TierThreshold[] {
  const slipAdj = preset === 'conservative' ? -0.01 : preset === 'aggressive' ? 0.01 : 0;
  return BASE_THRESHOLDS.map((t) => ({
    ...t,
    maxSlippagePp: Math.max(0.005, t.maxSlippagePp + slipAdj),
  }));
}

export function usdToContracts(targetUsd: number, price: number): number {
  const fee = kalshiFeePerContract(price);
  const costPer = price + fee;
  if (costPer <= 0) return 0;
  return Math.max(1, Math.floor(targetUsd / costPer));
}

/** Build ascending ask ladder for taker buys (mirrors complementary bids). */
export function buildAskLevels(book: KalshiOrderbook, side: 'yes' | 'no'): { price: number; quantity: number }[] {
  if (side === 'yes') {
    if (book.no.length > 0) {
      return book.no
        .map((l) => ({ price: 1 - l.price, quantity: l.quantity }))
        .sort((a, b) => a.price - b.price);
    }
    if (book.yesAsk !== undefined) {
      const qty = book.yes[0]?.quantity ?? 200;
      return [{ price: book.yesAsk, quantity: qty }];
    }
    return [...book.yes].sort((a, b) => a.price - b.price);
  }
  if (book.yes.length > 0) {
    return book.yes
      .map((l) => ({ price: 1 - l.price, quantity: l.quantity }))
      .sort((a, b) => a.price - b.price);
  }
  if (book.noAsk !== undefined) {
    const qty = book.no[0]?.quantity ?? 200;
    return [{ price: book.noAsk, quantity: qty }];
  }
  return [...book.no].sort((a, b) => a.price - b.price);
}

export function verifySideDepth(
  book: KalshiOrderbook,
  side: 'yes' | 'no',
  marketPrice: number,
  thresholds: TierThreshold[] = getTierThresholds(),
): SideDepthResult {
  const levels = buildAskLevels(book, side);
  let best: SideDepthResult = {
    executableTier: null,
    fillableUsd: 0,
    slippagePp: 0,
    depthLevels: levels.length,
  };

  for (const th of thresholds) {
    const contracts = usdToContracts(th.minFillableUsd, marketPrice);
    const walk = walkBookFill(levels, contracts);
    if (!walk || walk.filled < contracts) continue;
    if (walk.slippage > th.maxSlippagePp) continue;
    const fillableUsd = walk.avgPrice * walk.filled + kalshiFeePerContract(walk.avgPrice) * walk.filled;
    best = {
      executableTier: th.tier,
      fillableUsd,
      slippagePp: walk.slippage,
      depthLevels: levels.length,
    };
    break;
  }
  return best;
}

export function minNetEdgeForTier(tier: ExecutableTier | undefined, demoMode: boolean): number {
  if (!tier) return demoMode ? 0.015 : 0.02;
  if (tier === 'whale') return 0.02;
  if (tier === 'solid') return 0.015;
  return demoMode ? 0.008 : 0.012;
}

/**
 * Fail-closed pre-filter for automated certification. A tier label alone is
 * insufficient: require the measured fill amount and at least one executable
 * level produced by verifySideDepth(). The strict execution gate still fetches
 * and validates a fresh book before any fill.
 */
export function hasRealExecutableDepth(
  card: Pick<ThesisCard, 'executableTier' | 'fillableUsd' | 'slippagePp' | 'depthLevels'>,
): boolean {
  const tier = card.executableTier;
  if (!tier) return false;
  if (!Number.isFinite(card.fillableUsd) || (card.fillableUsd ?? 0) < MIN_FILLABLE_USD[tier] * 0.99) return false;
  if (!Number.isFinite(card.slippagePp) || (card.slippagePp ?? -1) < 0) return false;
  return Number.isFinite(card.depthLevels) && (card.depthLevels ?? 0) > 0;
}

export function tierRank(tier: ExecutableTier | undefined): number {
  if (!tier) return 99;
  return TIER_ORDER[tier];
}

export function rankThesesWithTiers(cards: ThesisCard[]): ThesisCard[] {
  return [...cards].sort((a, b) => {
    const td = tierRank(a.executableTier) - tierRank(b.executableTier);
    if (td !== 0) return td;
    const fillDiff = (b.fillableUsd ?? 0) - (a.fillableUsd ?? 0);
    if (fillDiff !== 0) return fillDiff;
    return b.netEdge - a.netEdge;
  });
}

export function countTierCards(cards: ThesisCard[]): { scout: number; solid: number; whale: number; belowScout: number } {
  let scout = 0;
  let solid = 0;
  let whale = 0;
  for (const c of cards) {
    if (c.executableTier === 'whale') whale += 1;
    else if (c.executableTier === 'solid') solid += 1;
    else if (c.executableTier === 'scout') scout += 1;
  }
  return { scout, solid, whale, belowScout: 0 };
}
