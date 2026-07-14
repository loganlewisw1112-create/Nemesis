import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOVERY_SETTINGS, DEFAULT_GUARDRAILS } from '@nemesis/core';
import { buildStrategyConfigHash } from './qualificationConfig.js';

const discovery = { ...DEFAULT_DISCOVERY_SETTINGS };

describe('buildStrategyConfigHash', () => {
  it('invalidates entry, exit, risk, discovery, and throughput changes', () => {
    const base = buildStrategyConfigHash(DEFAULT_GUARDRAILS, discovery);
    expect(buildStrategyConfigHash({ ...DEFAULT_GUARDRAILS, dailyLossCapUsd: 149 }, discovery)).not.toBe(base);
    expect(buildStrategyConfigHash({
      ...DEFAULT_GUARDRAILS,
      autoClose: { ...DEFAULT_GUARDRAILS.autoClose!, enabled: !DEFAULT_GUARDRAILS.autoClose!.enabled },
    }, discovery)).not.toBe(base);
    expect(buildStrategyConfigHash({
      ...DEFAULT_GUARDRAILS,
      opportunityThroughput: {
        ...DEFAULT_GUARDRAILS.opportunityThroughput!,
        maxConcurrentBookFetches: DEFAULT_GUARDRAILS.opportunityThroughput!.maxConcurrentBookFetches + 1,
      },
    }, discovery)).not.toBe(base);
    expect(buildStrategyConfigHash(DEFAULT_GUARDRAILS, { ...discovery, depthChecksPerCycle: 151 })).not.toBe(base);
  });

  it('does not invalidate the strategy when only live control state changes', () => {
    const base = buildStrategyConfigHash(DEFAULT_GUARDRAILS, discovery);
    expect(buildStrategyConfigHash({
      ...DEFAULT_GUARDRAILS,
      liveEnabled: true,
      liveStage: 'manual-live',
      killSwitchActive: true,
    }, discovery)).toBe(base);
  });
});
