import {
  DEFAULT_ENTRY_QUALIFICATION,
  isKnownKalshiFeePolicy,
  isSupportedQualificationFeeOrder,
  type EntryQualificationSettings,
  type KalshiFeePolicy,
  type ThesisCard,
} from '@nemesis/core';
import type { DryRunOrder } from './dryRun.js';
import { MAX_PROVEN_QUIET_BOOK_AGE_MS } from './entryConfirmation.js';
import { calculateEntryEconomics, type EntryEconomicsEvidence } from './tradeEconomics.js';

export type CampaignScreeningReasonCode =
  | 'automatic_source_required'
  | 'source_already_used'
  | 'source_stale'
  | 'missing_exchange_provenance'
  | 'book_stale'
  | 'fee_policy_unknown'
  | 'incomplete_fill'
  | 'unsupported_fixed_point_order'
  | 'non_positive_executable_edge'
  | 'fair_price_not_above_entry'
  | 'ticker_cooldown_active'
  | 'target_reward_below_minimum'
  | 'reward_risk_below_minimum'
  | 'stress_profit_below_minimum'
  | 'entry_risk_above_limit'
  | 'max_safe_contracts_unknown'
  | 'quantity_above_max_safe_contracts';

export interface CampaignInitialSampleEvidence {
  at: number;
  observedAt: number;
  netEdge: number;
  spread: number;
  bookTimestamp: number;
  bookSequence: number;
  exchangeTimestamp: number;
  exchangeSequence: number;
  fillPrice: number;
  filled: number;
  fees: number;
  feePolicyKnown: boolean;
}

interface CampaignScreeningDecisionBase {
  schemaVersion: 2;
  economicIdentity: string;
  originalCardId: string;
  ticker: string;
  side: 'yes' | 'no';
  completedAt: number;
  economics: EntryEconomicsEvidence;
  entryRiskUsd: number;
  maxSafeContracts?: number;
}

export interface CampaignScreeningEligible extends CampaignScreeningDecisionBase {
  status: 'eligible';
  reasonCode: 'qualified';
  reason: 'all campaign enrollment gates passed';
  initialSample: CampaignInitialSampleEvidence;
}

export interface CampaignScreenedOut extends CampaignScreeningDecisionBase {
  status: 'screened_out';
  reasonCode: CampaignScreeningReasonCode;
  reason: string;
}

export type CampaignScreeningDecisionV2 = CampaignScreeningEligible | CampaignScreenedOut;

export interface QualifyCampaignEnrollmentInput {
  card: ThesisCard;
  fill: DryRunOrder;
  bookTimestamp: number;
  bookSequence?: number;
  /** See EntryConfirmationObservation.bookContinuityProven. */
  bookContinuityProven?: boolean;
  feePolicy?: KalshiFeePolicy;
  observedAt?: number;
  sourceAlreadyUsed?: boolean;
  lastTickerExecutionAt?: number;
  /** Allocator result after every explicit quantity override has been applied. */
  maxSafeContracts?: number;
  /** Risk charged to the pilot gate. Defaults to corrected entry cost. */
  entryRiskUsd?: number;
  settings?: EntryQualificationSettings;
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Stable source/economic identity. Presentation text such as signalReason is intentionally excluded. */
export function campaignEconomicIdentity(card: ThesisCard): string {
  return [
    normalizeIdentityPart(card.ticker),
    card.side,
    normalizeIdentityPart(card.playbook),
    normalizeIdentityPart(card.sourceMove ?? 'unknown'),
    normalizeIdentityPart(card.id),
  ].join('|');
}

/**
 * Pure, fail-closed campaign enrollment decision. It never creates confirmation
 * state, campaign candidates, diagnostics, orders, or paper mutations.
 */
export function qualifyCampaignEnrollment(input: QualifyCampaignEnrollmentInput): CampaignScreeningDecisionV2 {
  const settings = input.settings ?? DEFAULT_ENTRY_QUALIFICATION;
  const completedAt = input.observedAt ?? Date.now();
  const economics = calculateEntryEconomics({
    entryPrice: input.fill.fillPrice,
    entryFeesUsd: input.fill.fees,
    contracts: input.fill.filled,
    sideFairPrice: input.card.impliedPrice,
    marketPrice: input.card.marketPrice,
    grossEdge: input.card.grossEdge,
    screeningNetEdge: input.card.netEdge,
    executableEntryNetEdge: input.fill.netEdge,
    spread: input.card.spread,
    fillSlippage: input.fill.slippage,
    feePolicy: input.feePolicy,
  });
  const entryRiskUsd = input.entryRiskUsd ?? economics.entryCostUsd;
  const base: CampaignScreeningDecisionBase = {
    schemaVersion: 2,
    economicIdentity: campaignEconomicIdentity(input.card),
    originalCardId: input.card.id,
    ticker: input.card.ticker,
    side: input.card.side,
    completedAt,
    economics,
    entryRiskUsd,
    maxSafeContracts: input.maxSafeContracts,
  };
  const screenedOut = (reasonCode: CampaignScreeningReasonCode, reason: string): CampaignScreenedOut => ({
    ...base,
    status: 'screened_out',
    reasonCode,
    reason,
  });

  if (input.card.sourceMove !== 'flow-driven') {
    return screenedOut('automatic_source_required', 'automatic entry requires a flow-driven source');
  }
  if (input.sourceAlreadyUsed) return screenedOut('source_already_used', 'source signal already used');
  const sourceAgeMs = completedAt - input.card.createdAt;
  if (sourceAgeMs < 0 || sourceAgeMs > settings.maxSourceAgeMs) {
    return screenedOut('source_stale', 'source signal is stale');
  }
  if (!Number.isFinite(input.bookTimestamp) || !Number.isInteger(input.bookSequence)) {
    return screenedOut('missing_exchange_provenance', 'exchange-origin book timestamp and sequence are required');
  }
  const bookAgeMs = completedAt - input.bookTimestamp;
  // Mirrors the entry-confirmation rule: a quiet book is only accepted past
  // maxBookAgeMs when the transport proves it missed nothing, and never past
  // MAX_PROVEN_QUIET_BOOK_AGE_MS. Kept in lockstep so enrollment and
  // confirmation cannot disagree about whether the same book is usable.
  const quietBookProven = input.bookContinuityProven === true
    && bookAgeMs <= MAX_PROVEN_QUIET_BOOK_AGE_MS;
  if (bookAgeMs < 0 || (bookAgeMs > settings.maxBookAgeMs && !quietBookProven)) {
    return screenedOut('book_stale', 'entry book is stale');
  }
  if (!isKnownKalshiFeePolicy(input.feePolicy) || !input.fill.feePolicyKnown) {
    return screenedOut('fee_policy_unknown', 'account or series fee policy is unknown');
  }
  if (input.fill.aborted || input.fill.filled <= 0 || input.fill.filled !== input.fill.contracts) {
    return screenedOut('incomplete_fill', input.fill.abortReason ?? 'a complete executable fill is required');
  }
  if (!isSupportedQualificationFeeOrder(input.fill.fillPrice, input.fill.filled)) {
    return screenedOut('unsupported_fixed_point_order', 'qualification requires a four-decimal price and two-decimal quantity');
  }
  if (!Number.isFinite(input.fill.netEdge) || input.fill.netEdge <= 0) {
    return screenedOut('non_positive_executable_edge', 'executable entry edge is not positive');
  }
  if (!Number.isFinite(input.card.impliedPrice) || economics.targetExitPrice <= input.fill.fillPrice) {
    return screenedOut('fair_price_not_above_entry', 'selected-side fair price does not exceed executable entry');
  }
  if (input.lastTickerExecutionAt != null && completedAt - input.lastTickerExecutionAt < settings.tickerCooldownMs) {
    return screenedOut('ticker_cooldown_active', 'ticker-side cooldown is active');
  }
  if (economics.targetRewardUsd < settings.minExpectedNetPnlUsd) {
    return screenedOut('target_reward_below_minimum', 'target net reward is below the minimum');
  }
  if (economics.rewardRiskRatio < settings.minRewardRiskRatio) {
    return screenedOut('reward_risk_below_minimum', 'target reward-to-risk ratio is below the minimum');
  }
  if (economics.stressedNetPnlUsd < settings.minStressedNetPnlUsd) {
    return screenedOut('stress_profit_below_minimum', 'one-cent stressed result is not profitable');
  }
  if (!Number.isFinite(entryRiskUsd) || entryRiskUsd > settings.pilotMaxEntryRiskUsd) {
    return screenedOut('entry_risk_above_limit', 'entry risk exceeds the $10 pilot limit');
  }
  if (!Number.isFinite(input.maxSafeContracts) || input.maxSafeContracts! < 0) {
    return screenedOut('max_safe_contracts_unknown', 'allocator maxSafeContracts was not proven');
  }
  if (input.fill.filled > input.maxSafeContracts! + 1e-9) {
    return screenedOut('quantity_above_max_safe_contracts', 'requested quantity exceeds allocator maxSafeContracts');
  }

  const sequence = input.bookSequence!;
  return {
    ...base,
    status: 'eligible',
    reasonCode: 'qualified',
    reason: 'all campaign enrollment gates passed',
    initialSample: {
      at: completedAt,
      observedAt: completedAt,
      netEdge: input.fill.netEdge,
      spread: input.card.spread,
      bookTimestamp: input.bookTimestamp,
      bookSequence: sequence,
      exchangeTimestamp: input.bookTimestamp,
      exchangeSequence: sequence,
      fillPrice: input.fill.fillPrice,
      filled: input.fill.filled,
      fees: input.fill.fees,
      feePolicyKnown: true,
    },
  };
}
