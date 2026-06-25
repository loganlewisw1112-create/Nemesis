/** Kalshi taker fee: ceil(rate * P * (1-P)) per contract, default rate 0.07 */
export function kalshiFeePerContract(price: number, rate = 0.07): number {
  const p = Math.max(0, Math.min(1, price));
  const raw = rate * p * (1 - p);
  return Math.ceil(raw * 100) / 100;
}

export function kalshiFeeForOrder(price: number, contracts: number, rate = 0.07): number {
  return kalshiFeePerContract(price, rate) * contracts;
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
