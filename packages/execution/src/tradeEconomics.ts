import { kalshiFeeForFills, kalshiFeeForOrder, kalshiFeePerContract, type KalshiFeePolicy } from '@nemesis/core';

export const QUALIFICATION_FEE_MODEL = 'kalshi-fixed-point-level-fees-v3' as const;

export interface EntryEconomicsInput {
  entryPrice: number;
  entryFeesUsd: number;
  contracts: number;
  sideFairPrice: number;
  marketPrice: number;
  grossEdge: number;
  screeningNetEdge: number;
  executableEntryNetEdge: number;
  spread: number;
  fillSlippage: number;
  feeRate?: number;
  feePolicy?: KalshiFeePolicy;
  priceTick?: number;
}

export interface EntryEconomicsEvidence extends EntryEconomicsInput {
  feeModel: typeof QUALIFICATION_FEE_MODEL;
  targetExitPrice: number;
  targetExitFeesUsd: number;
  entryCostUsd: number;
  stopPrice: number;
  stopFeesUsd: number;
  stressedEntryPrice: number;
  stressedEntryFeesUsd: number;
  stressedExitPrice: number;
  stressedExitFeesUsd: number;
  targetRewardUsd: number;
  plannedLossUsd: number;
  rewardRiskRatio: number;
  stressedNetPnlUsd: number;
  breakEvenExitPrice: number | null;
}

export interface EntryEconomicsComparison {
  legacyTargetRewardUsd: number;
  correctedTargetRewardUsd: number;
  correctionUsd: number;
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function floorToTick(value: number, tick: number): number {
  return Math.floor((value + 1e-10) / tick) * tick;
}

function orderFee(price: number, contracts: number, input: Pick<EntryEconomicsInput, 'feePolicy' | 'feeRate'>): number {
  if (input.feePolicy) {
    return kalshiFeeForFills([{ price, quantity: contracts }], input.feePolicy)?.totalFeeUsd ?? Number.NaN;
  }
  return kalshiFeeForOrder(price, contracts, input.feeRate ?? 0.07);
}

/** Returns the lowest supported fixed-point exit tick whose net proceeds cover entry cost. */
export function solveBreakEvenExitPrice(
  entryCostUsd: number,
  contracts: number,
  feeRate = 0.07,
  priceTick = 0.0001,
): number | null {
  if (!Number.isFinite(entryCostUsd) || !Number.isFinite(contracts) || contracts <= 0) return null;
  const steps = Math.round(1 / priceTick);
  for (let step = 1; step <= steps; step += 1) {
    const price = step * priceTick;
    const netProceeds = price * contracts - kalshiFeeForOrder(price, contracts, feeRate);
    if (netProceeds + 1e-9 >= entryCostUsd) return price;
  }
  return null;
}

/**
 * Conditional target economics. The target is the selected side's model fair
 * price, rounded down to an executable cent. Actual entry price and fee are
 * authoritative; no screening spread, fee, or slippage estimate is subtracted again.
 */
export function calculateEntryEconomics(input: EntryEconomicsInput): EntryEconomicsEvidence {
  const contracts = input.contracts;
  const entryPrice = input.entryPrice;
  const priceTick = input.priceTick ?? 0.0001;
  const targetExitPrice = clamp(floorToTick(input.sideFairPrice, priceTick), priceTick, 1 - priceTick);
  const targetExitFeesUsd = orderFee(targetExitPrice, contracts, input);
  const entryCostUsd = entryPrice * contracts + input.entryFeesUsd;
  const targetRewardUsd = targetExitPrice * contracts - targetExitFeesUsd - entryCostUsd;
  const stopPrice = clamp(round(entryPrice - 0.01, 4), priceTick, 1 - priceTick);
  const stopFeesUsd = orderFee(stopPrice, contracts, input);
  const plannedLossUsd = Math.max(0.01, entryCostUsd - (stopPrice * contracts - stopFeesUsd));
  const stressedEntryPrice = clamp(round(entryPrice + 0.01, 4), priceTick, 1 - priceTick);
  const stressedEntryFeesUsd = orderFee(stressedEntryPrice, contracts, input);
  const stressedExitPrice = clamp(round(targetExitPrice - 0.01, 4), priceTick, 1 - priceTick);
  const stressedExitFeesUsd = orderFee(stressedExitPrice, contracts, input);
  const stressedNetPnlUsd = stressedExitPrice * contracts - stressedExitFeesUsd
    - (stressedEntryPrice * contracts + stressedEntryFeesUsd);
  const breakEvenExitPrice = input.feePolicy
    ? (() => {
        const steps = Math.round(1 / priceTick);
        for (let step = 1; step <= steps; step += 1) {
          const price = step * priceTick;
          if (price * contracts - orderFee(price, contracts, input) + 1e-9 >= entryCostUsd) return price;
        }
        return null;
      })()
    : solveBreakEvenExitPrice(entryCostUsd, contracts, input.feeRate ?? 0.07, priceTick);
  const rewardRiskRatio = targetRewardUsd / plannedLossUsd;

  return {
    ...input,
    feeModel: QUALIFICATION_FEE_MODEL,
    targetExitPrice: round(targetExitPrice),
    targetExitFeesUsd: round(targetExitFeesUsd),
    entryCostUsd: round(entryCostUsd),
    stopPrice: round(stopPrice),
    stopFeesUsd: round(stopFeesUsd),
    stressedEntryPrice: round(stressedEntryPrice),
    stressedEntryFeesUsd: round(stressedEntryFeesUsd),
    stressedExitPrice: round(stressedExitPrice),
    stressedExitFeesUsd: round(stressedExitFeesUsd),
    targetRewardUsd: round(targetRewardUsd),
    plannedLossUsd: round(plannedLossUsd),
    rewardRiskRatio: round(rewardRiskRatio),
    stressedNetPnlUsd: round(stressedNetPnlUsd),
    breakEvenExitPrice: breakEvenExitPrice == null ? null : round(breakEvenExitPrice),
  };
}

/** Offline comparison for schema-2 evidence; never used as a trading gate. */
export function compareLegacyEntryEconomics(input: EntryEconomicsInput): EntryEconomicsComparison {
  const feeRate = input.feeRate ?? 0.07;
  const legacyTargetExitPrice = clamp(
    input.entryPrice + Math.max(0, input.screeningNetEdge),
    0.01,
    0.99,
  );
  const legacyEntryFeesUsd = kalshiFeePerContract(input.entryPrice, feeRate) * input.contracts;
  const legacyExitFeesUsd = kalshiFeePerContract(legacyTargetExitPrice, feeRate) * input.contracts;
  const legacyTargetRewardUsd = legacyTargetExitPrice * input.contracts
    - legacyExitFeesUsd
    - (input.entryPrice * input.contracts + legacyEntryFeesUsd);
  const correctedTargetRewardUsd = calculateEntryEconomics(input).targetRewardUsd;
  return {
    legacyTargetRewardUsd: round(legacyTargetRewardUsd),
    correctedTargetRewardUsd,
    correctionUsd: round(correctedTargetRewardUsd - legacyTargetRewardUsd),
  };
}
