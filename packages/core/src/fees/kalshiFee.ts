function ceilToCent(value: number): number {
  if (value <= 0) return 0;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(value)) * 8;
  return Math.ceil((value - epsilon) * 100) / 100;
}

/**
 * Conservative one-contract taker-fee estimate used by pre-fill edge screening.
 * Executed order accounting must use kalshiFeeForOrder so rounding happens once.
 */
export function kalshiFeePerContract(price: number, rate = 0.07): number {
  const p = Math.max(0, Math.min(1, price));
  const raw = rate * p * (1 - p);
  return ceilToCent(raw);
}

export function kalshiFeeForOrder(price: number, contracts: number, rate = 0.07): number {
  const p = Math.max(0, Math.min(1, price));
  const quantity = Math.max(0, contracts);
  return ceilToCent(rate * quantity * p * (1 - p));
}

/** Qualification currently models whole-contract fills on one-cent price grids only. */
export function isSupportedQualificationFeeOrder(price: number, contracts: number): boolean {
  return Number.isFinite(price)
    && Number.isFinite(contracts)
    && price > 0
    && price < 1
    && Number.isInteger(contracts)
    && Math.abs(price * 100 - Math.round(price * 100)) < 1e-8;
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
  feeRate = 0.07,
): EdgeBreakdown {
  const grossEdge = impliedPrice - marketPrice;
  const spreadCost = spread / 2;
  const feeCost = kalshiFeePerContract(marketPrice, feeRate);
  const netEdge = grossEdge - spreadCost - feeCost - slippageBuffer;
  return { grossEdge, spreadCost, feeCost, slippageBuffer, netEdge };
}

export function walkBookFill(
  levels: { price: number; quantity: number }[],
  targetContracts: number,
): { avgPrice: number; filled: number; slippage: number } | null {
  if (levels.length === 0 || targetContracts <= 0) return null;
  let remaining = targetContracts;
  let totalCost = 0;
  let filled = 0;
  const best = levels[0]?.price ?? 0;
  for (const level of levels) {
    const take = Math.min(remaining, level.quantity);
    totalCost += take * level.price;
    filled += take;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (filled === 0) return null;
  const avgPrice = totalCost / filled;
  return { avgPrice, filled, slippage: avgPrice - best };
}
