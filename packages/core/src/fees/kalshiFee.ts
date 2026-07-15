import type { KalshiFeePolicy, KalshiFeeRole, OrderbookLevel } from '../types.js';

export const KALSHI_FEE_SCHEDULE_VERSION = '2026-07-07';
export const KALSHI_TAKER_RATE = 0.07;
export const KALSHI_MAKER_RATE = 0.0175;

export const UNKNOWN_KALSHI_FEE_POLICY: KalshiFeePolicy = {
  known: false,
  role: 'taker',
  multiplier: Number.NaN,
  accountPrecision: 'unknown',
  scheduleVersion: KALSHI_FEE_SCHEDULE_VERSION,
  source: 'unresolved',
};

export interface BookFillLevel extends OrderbookLevel {
  cost: number;
}

export interface BookWalk {
  avgPrice: number;
  filled: number;
  slippage: number;
  complete: boolean;
  fills: BookFillLevel[];
}

export interface KalshiFeeBreakdown {
  tradeFeeUsd: number;
  balanceRoundingFeeUsd: number;
  totalFeeUsd: number;
  policy: KalshiFeePolicy;
}

function round(value: number, digits = 8): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function ceilToIncrement(value: number, increment: number): number {
  if (value <= 0) return 0;
  if (!Number.isFinite(value) || !Number.isFinite(increment) || increment <= 0) return Number.NaN;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  return round(Math.ceil((value - epsilon) / increment) * increment);
}

export function isKnownKalshiFeePolicy(policy: KalshiFeePolicy | undefined): policy is KalshiFeePolicy {
  return Boolean(
    policy?.known
    && (policy.role === 'maker' || policy.role === 'taker')
    && Number.isFinite(policy.multiplier)
    && policy.multiplier >= 0
    && policy.accountPrecision !== 'unknown',
  );
}

export function buildKalshiFeePolicy(input: {
  role?: KalshiFeeRole;
  multiplier?: number;
  accountPrecision?: KalshiFeePolicy['accountPrecision'];
  seriesTicker?: string;
  feeType?: string;
  source?: string;
  scheduleVersion?: string;
}): KalshiFeePolicy {
  const role = input.role ?? 'taker';
  const multiplier = input.multiplier;
  const accountPrecision = input.accountPrecision ?? 'unknown';
  const known = Number.isFinite(multiplier)
    && (multiplier ?? -1) >= 0
    && accountPrecision !== 'unknown';
  return {
    known,
    role,
    multiplier: multiplier ?? Number.NaN,
    accountPrecision,
    seriesTicker: input.seriesTicker,
    feeType: input.feeType,
    scheduleVersion: input.scheduleVersion ?? KALSHI_FEE_SCHEDULE_VERSION,
    source: input.source ?? 'series-api',
  };
}

function rateForRole(role: KalshiFeeRole): number {
  return role === 'maker' ? KALSHI_MAKER_RATE : KALSHI_TAKER_RATE;
}

function resolveLegacyPolicy(rateOrPolicy: number | KalshiFeePolicy | undefined): KalshiFeePolicy {
  if (typeof rateOrPolicy === 'object') return rateOrPolicy;
  return {
    known: true,
    role: 'taker',
    multiplier: (rateOrPolicy ?? KALSHI_TAKER_RATE) / KALSHI_TAKER_RATE,
    accountPrecision: 'direct',
    scheduleVersion: KALSHI_FEE_SCHEDULE_VERSION,
    source: 'legacy-explicit-rate',
  };
}

/** Official quadratic trading fee rounded upward to the nearest centicent ($0.0001). */
export function kalshiFeeForOrder(
  price: number,
  contracts: number,
  rateOrPolicy?: number | KalshiFeePolicy,
): number {
  const p = Math.max(0, Math.min(1, price));
  const quantity = Math.max(0, contracts);
  const policy = resolveLegacyPolicy(rateOrPolicy);
  if (!Number.isFinite(policy.multiplier) || policy.multiplier < 0) return Number.NaN;
  const raw = policy.multiplier * rateForRole(policy.role) * quantity * p * (1 - p);
  return ceilToIncrement(raw, 0.0001);
}

/** One-contract fee for screening. Executed accounting should use per-level order fees. */
export function kalshiFeePerContract(price: number, rateOrPolicy?: number | KalshiFeePolicy): number {
  return kalshiFeeForOrder(price, 1, rateOrPolicy);
}

export function kalshiFeeForFills(
  fills: Pick<BookFillLevel, 'price' | 'quantity'>[],
  policy: KalshiFeePolicy,
): KalshiFeeBreakdown | null {
  if (!isKnownKalshiFeePolicy(policy)) return null;
  const tradeFeeUsd = round(fills.reduce(
    (sum, fill) => sum + kalshiFeeForOrder(fill.price, fill.quantity, policy),
    0,
  ));
  const balanceRoundingFeeUsd = policy.accountPrecision === 'non_direct'
    ? round(ceilToIncrement(tradeFeeUsd, 0.01) - tradeFeeUsd)
    : 0;
  return {
    tradeFeeUsd,
    balanceRoundingFeeUsd,
    totalFeeUsd: round(tradeFeeUsd + balanceRoundingFeeUsd),
    policy,
  };
}

/** Fixed-point prices support four decimals and quantities support two decimals. */
export function isSupportedQualificationFeeOrder(price: number, contracts: number): boolean {
  return Number.isFinite(price)
    && Number.isFinite(contracts)
    && price > 0
    && price < 1
    && contracts > 0
    && Math.abs(price * 10_000 - Math.round(price * 10_000)) < 1e-8
    && Math.abs(contracts * 100 - Math.round(contracts * 100)) < 1e-8;
}

export interface EdgeBreakdown {
  grossEdge: number;
  spreadCost: number;
  feeCost: number;
  slippageBuffer: number;
  netEdge: number;
}

export function computeNetEdge(
  impliedPrice: number,
  marketPrice: number,
  spread: number,
  slippageBuffer = 0.01,
  feeRate = KALSHI_TAKER_RATE,
): EdgeBreakdown {
  const grossEdge = impliedPrice - marketPrice;
  const spreadCost = spread / 2;
  const feeCost = kalshiFeePerContract(marketPrice, feeRate);
  const netEdge = grossEdge - spreadCost - feeCost - slippageBuffer;
  return { grossEdge, spreadCost, feeCost, slippageBuffer, netEdge };
}

export function walkBookFill(levels: OrderbookLevel[], targetContracts: number): BookWalk | null {
  if (levels.length === 0 || targetContracts <= 0) return null;
  let remaining = targetContracts;
  let totalCost = 0;
  let filled = 0;
  const best = levels[0]?.price ?? 0;
  const fills: BookFillLevel[] = [];
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.quantity) || level.quantity <= 0) continue;
    const take = Math.min(remaining, level.quantity);
    if (take <= 0) continue;
    const cost = take * level.price;
    totalCost += cost;
    filled += take;
    remaining -= take;
    fills.push({ price: level.price, quantity: take, cost: round(cost) });
    if (remaining <= 1e-8) break;
  }
  if (filled === 0) return null;
  const avgPrice = totalCost / filled;
  return {
    avgPrice,
    filled: round(filled),
    slippage: avgPrice - best,
    complete: remaining <= 1e-8,
    fills,
  };
}
