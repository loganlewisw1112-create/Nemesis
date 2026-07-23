import { describe, expect, it } from 'vitest';
import { buildKalshiFeePolicy, DEFAULT_ENTRY_QUALIFICATION, type ProfitCertificate, type ThesisCard } from '@nemesis/core';
import type { DryRunOrder } from './dryRun.js';
import { EntryConfirmationEngine, MAX_PROVEN_QUIET_BOOK_AGE_MS } from './entryConfirmation.js';

const startedAt = Date.UTC(2026, 6, 14, 12, 0, 0);
const feePolicy = buildKalshiFeePolicy({ multiplier: 1, accountPrecision: 'direct' });

function card(overrides: Partial<ThesisCard> = {}): ThesisCard {
  return {
    id: 'flow-1',
    ticker: 'KXTEST-26',
    title: 'Test flow market',
    category: 'test',
    playbook: 'flow-hunter',
    status: 'tradeable',
    side: 'yes',
    marketPrice: 0.4,
    impliedPrice: 0.55,
    grossEdge: 0.15,
    netEdge: 0.12,
    spread: 0.02,
    depthUsd: 500,
    predictability: 0.8,
    feeEstimate: 0.01,
    signalReason: 'persistent aggressive flow',
    externalSummary: '',
    createdAt: startedAt,
    updatedAt: startedAt,
    freshnessMs: 0,
    edgeHistory: [0.12],
    drivers: [],
    invalidations: [],
    sourceMove: 'flow-driven',
    ...overrides,
  };
}

function fill(overrides: Partial<DryRunOrder> = {}): DryRunOrder {
  return {
    ticker: 'KXTEST-26',
    side: 'yes',
    contracts: 25,
    expectedPrice: 0.4,
    fillPrice: 0.4,
    filled: 25,
    fillLevels: [{ price: 0.4, quantity: 25, cost: 10 }],
    slippage: 0,
    fees: 0.18,
    feePolicyKnown: true,
    netEdge: 0.09,
    aborted: false,
    ...overrides,
  };
}

function certificate(): ProfitCertificate {
  return {
    kind: 'open',
    ticker: 'KXTEST-26',
    side: 'yes',
    contracts: 25,
    entryPrice: 0.4,
    exitPrice: 0.4,
    entryFees: 0.18,
    exitFees: 0,
    netPnlUsd: 2.32,
    bookTimestamp: startedAt,
    expiresAt: startedAt + 60_000,
    reason: 'modeled edge',
    classification: 'research_only',
  };
}

function observe(engine: EntryConfirmationEngine, index: number, overrides: Partial<ThesisCard> = {}) {
  const observedAt = startedAt + index * 6_000;
  return engine.observe({
    card: card({ updatedAt: observedAt, ...overrides }),
    fill: fill({ netEdge: overrides.netEdge ?? 0.09 }),
    baseCertificate: certificate(),
    bookTimestamp: observedAt,
    bookSequence: index + 1,
    feePolicy,
    observedAt,
  });
}

describe('EntryConfirmationEngine', () => {
  it('fails closed without exchange book provenance or a resolved fee policy', () => {
    const engine = new EntryConfirmationEngine();
    const missingProvenance = engine.observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt, observedAt: startedAt, feePolicy,
    });
    expect(missingProvenance.reason).toMatch(/exchange-origin book timestamp and sequence/i);
    const missingPolicy = engine.observe({
      card: card({ id: 'flow-policy' }), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt, bookSequence: 1, observedAt: startedAt,
    });
    expect(missingPolicy.reason).toMatch(/fee policy is unknown/i);
  });

  it('accepts a quiet book only when continuity is proven, and never past the ceiling', () => {
    const stale = { bookTimestamp: startedAt - 5_000, observedAt: startedAt };
    // Unproven: the strict maxBookAgeMs bound still applies.
    expect(new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookSequence: 1, feePolicy, ...stale,
    }).reason).toMatch(/entry book is stale/i);

    // Proven continuity: an unchanged book from a quiet market is current.
    expect(new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookSequence: 1, feePolicy, bookContinuityProven: true, ...stale,
    }).reason).not.toMatch(/entry book is stale/i);

    // Proof does not extend past the hard ceiling.
    expect(new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookSequence: 1, feePolicy, bookContinuityProven: true,
      bookTimestamp: startedAt - (MAX_PROVEN_QUIET_BOOK_AGE_MS + 1), observedAt: startedAt,
    }).reason).toMatch(/entry book is stale/i);
  });

  it('accumulates samples at an observation cadence near the tiling interval', () => {
    // Production settings: the old spacing rule tiled exactly across the window
    // (15000 / 3 = 5000ms) against a poll cadence whose measured median was
    // exactly 5.0s. An observation arriving a few ms early was dropped, so a
    // candidate could sit at one sample until its source expired.
    const settings = { ...DEFAULT_ENTRY_QUALIFICATION, minSamples: 4, minWindowMs: 15_000 };
    const engine = new EntryConfirmationEngine(settings);
    const cadenceMs = 4_990;
    const step = (index: number) => {
      const observedAt = startedAt + index * cadenceMs;
      return engine.observe({
        card: card({ updatedAt: observedAt }),
        fill: fill(),
        baseCertificate: certificate(),
        bookTimestamp: observedAt,
        bookSequence: index + 1,
        feePolicy,
        observedAt,
      });
    };

    expect(step(0).samples).toBe(1);
    // Under the old bound each of these was silently discarded.
    expect(step(1).samples).toBe(2);
    expect(step(2).samples).toBe(3);

    // The window guarantee is untouched: four samples spanning 14_970ms is
    // still short of minWindowMs, so it stays pending rather than confirming.
    const fourth = step(3);
    expect(fourth.samples).toBe(4);
    expect(fourth.status).toBe('pending');
    expect(fourth.windowMs).toBeLessThan(15_000);

    const fifth = step(4);
    expect(fifth.status).toBe('ready');
    expect(fifth.windowMs).toBeGreaterThanOrEqual(15_000);
  });

  it('still rejects burst samples taken from the same instant', () => {
    const settings = { ...DEFAULT_ENTRY_QUALIFICATION, minSamples: 4, minWindowMs: 15_000 };
    const engine = new EntryConfirmationEngine(settings);
    const burst = (index: number) => engine.observe({
      card: card({ updatedAt: startedAt }),
      fill: fill(),
      baseCertificate: certificate(),
      bookTimestamp: startedAt,
      bookSequence: index + 1,
      feePolicy,
      observedAt: startedAt + index * 10,
    });
    expect(burst(0).samples).toBe(1);
    // 10ms apart is far below the anti-burst bound, so these do not count.
    expect(burst(1).samples).toBe(1);
    expect(burst(2).samples).toBe(1);
  });

  it('enforces the absolute bars at admission and at confirmation, not on every sample', () => {
    // A candidate admitted on qualifying economics keeps accumulating even when
    // an intermediate observation dips below the absolute bar, so long as the
    // edge itself holds -- that is what edgeRetention is for.
    const engine = new EntryConfirmationEngine({
      ...DEFAULT_ENTRY_QUALIFICATION,
      minExpectedNetPnlUsd: 2.2,
    });
    expect(observe(engine, 0).status).toBe('pending');
    const dip = observe(engine, 1, { impliedPrice: 0.54 });
    expect(dip.status).toBe('pending');
    expect(dip.reason).toMatch(/collecting persistent/i);

    // But an entry is never taken on economics that fail at the confirming
    // observation, however good the admitting sample was.
    const strict = new EntryConfirmationEngine({
      ...DEFAULT_ENTRY_QUALIFICATION,
      minSamples: 2,
      minWindowMs: 6_000,
      minExpectedNetPnlUsd: 2.2,
    });
    expect(observe(strict, 0).status).toBe('pending');
    expect(observe(strict, 1, { impliedPrice: 0.5 }).reason).toMatch(/target net reward is below the minimum/i);
  });

  it('reports tickers with evidence in flight so their books stay tracked', () => {
    const engine = new EntryConfirmationEngine();
    expect(engine.inFlightTickers()).toEqual([]);

    expect(observe(engine, 0).status).toBe('pending');
    expect(engine.inFlightTickers()).toEqual([card().ticker]);

    // Once the source is consumed the candidate no longer needs its book pinned.
    engine.markSourceUsed(card().id);
    expect(engine.inFlightTickers()).toEqual([]);
  });

  it('requires six executable samples over at least 30 seconds before confirming', () => {
    const engine = new EntryConfirmationEngine();
    for (let index = 0; index < 5; index += 1) {
      expect(observe(engine, index).status).toBe('pending');
    }
    const result = observe(engine, 5);
    expect(result.status).toBe('ready');
    expect(result.samples).toBe(6);
    expect(result.windowMs).toBe(30_000);
    expect(result.edgeRetention).toBe(1);
    expect(result.targetRewardUsd).toBe(result.expectedRewardUsd);
    expect(result.expectedRewardUsd).toBeGreaterThanOrEqual(1);
    expect(result.rewardRiskRatio).toBeGreaterThanOrEqual(2);
    expect(result.stressedNetPnlUsd).toBeGreaterThan(0);
    expect(result.certificate?.classification).toBe('modeled_confirmed');
    expect(result.certificate?.targetRewardUsd).toBe(result.targetRewardUsd);
  });

  it('rejects stale, reused, non-flow, and cooldown-blocked sources', () => {
    const stale = new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt + 60_001, bookSequence: 1, feePolicy, observedAt: startedAt + 60_001,
    });
    expect(stale.reason).toMatch(/stale/i);
    expect(new EntryConfirmationEngine().observe({
      card: card({ sourceMove: 'news-driven' }), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt, bookSequence: 1, feePolicy, observedAt: startedAt,
    }).reason).toMatch(/flow-driven/i);
    expect(new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt, bookSequence: 1, feePolicy, observedAt: startedAt, sourceAlreadyUsed: true,
    }).reason).toMatch(/already used/i);
    expect(new EntryConfirmationEngine().observe({
      card: card(), fill: fill(), baseCertificate: certificate(),
      bookTimestamp: startedAt, bookSequence: 1, feePolicy, observedAt: startedAt, lastTickerExecutionAt: startedAt - 1_000,
    }).reason).toMatch(/cooldown/i);
  });

  it('rejects edge decay and spread widening during confirmation', () => {
    const decaying = new EntryConfirmationEngine({
      ...DEFAULT_ENTRY_QUALIFICATION,
      minExpectedNetPnlUsd: 0,
      minRewardRiskRatio: 0,
      minStressedNetPnlUsd: -1,
    });
    expect(observe(decaying, 0).status).toBe('pending');
    expect(observe(decaying, 1, { netEdge: 0.06 }).reason).toMatch(/edge decayed/i);

    const widening = new EntryConfirmationEngine();
    expect(observe(widening, 0).status).toBe('pending');
    expect(observe(widening, 1, { spread: 0.031 }).reason).toMatch(/spread widened/i);
  });

  it('fails closed when one-cent stress is not profitable', () => {
    const engine = new EntryConfirmationEngine({
      ...DEFAULT_ENTRY_QUALIFICATION,
      minExpectedNetPnlUsd: -1,
      minRewardRiskRatio: -100,
    });
    const result = engine.observe({
      card: card({ impliedPrice: 0.42, grossEdge: 0.02, netEdge: 0.01 }),
      fill: fill({ filled: 1, contracts: 1, fees: 0.02 }),
      baseCertificate: { ...certificate(), contracts: 1, entryFees: 0.02 },
      bookTimestamp: startedAt,
      bookSequence: 1,
      feePolicy,
      observedAt: startedAt,
    });
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/stressed/i);
  });

  it('accepts fractional/subpenny fills and rejects unsupported excess precision', () => {
    const engine = new EntryConfirmationEngine({
      ...DEFAULT_ENTRY_QUALIFICATION,
      minExpectedNetPnlUsd: -1,
      minRewardRiskRatio: -100,
      minStressedNetPnlUsd: -1,
    });
    const fractional = engine.observe({
      card: card(),
      fill: fill({ contracts: 1.5, filled: 1.5, fees: 0.03 }),
      baseCertificate: { ...certificate(), contracts: 1.5 },
      bookTimestamp: startedAt,
      bookSequence: 1,
      feePolicy,
      observedAt: startedAt,
    });
    expect(fractional.status).toBe('pending');

    const subpenny = engine.observe({
      card: card({ id: 'flow-2' }),
      fill: fill({ fillPrice: 0.405, fees: 0.42 }),
      baseCertificate: certificate(),
      bookTimestamp: startedAt,
      bookSequence: 2,
      feePolicy,
      observedAt: startedAt,
    });
    expect(subpenny.status).toBe('pending');

    const excessPrecision = engine.observe({
      card: card({ id: 'flow-3' }),
      fill: fill({ contracts: 1.005, filled: 1.005, fillPrice: 0.40555 }),
      baseCertificate: certificate(),
      bookTimestamp: startedAt,
      bookSequence: 3,
      feePolicy,
      observedAt: startedAt,
    });
    expect(excessPrecision.reason).toMatch(/four-decimal price and two-decimal quantity/i);
  });

  it('keeps target, reward-risk, and stress gates inclusive at their exact boundaries', () => {
    const relaxed = {
      ...DEFAULT_ENTRY_QUALIFICATION,
      minExpectedNetPnlUsd: -100,
      minRewardRiskRatio: -100,
      minStressedNetPnlUsd: -100,
    };
    const probe = observe(new EntryConfirmationEngine(relaxed), 0);
    expect(probe.status).toBe('pending');

    expect(observe(new EntryConfirmationEngine({
      ...relaxed,
      minExpectedNetPnlUsd: probe.targetRewardUsd,
    }), 0).status).toBe('pending');
    expect(observe(new EntryConfirmationEngine({
      ...relaxed,
      minExpectedNetPnlUsd: probe.targetRewardUsd + 0.000001,
    }), 0).reason).toMatch(/target net reward/i);

    expect(observe(new EntryConfirmationEngine({
      ...relaxed,
      minRewardRiskRatio: probe.rewardRiskRatio,
    }), 0).status).toBe('pending');
    expect(observe(new EntryConfirmationEngine({
      ...relaxed,
      minRewardRiskRatio: probe.rewardRiskRatio + 0.000001,
    }), 0).reason).toMatch(/reward-to-risk/i);

    expect(observe(new EntryConfirmationEngine({
      ...relaxed,
      minStressedNetPnlUsd: probe.stressedNetPnlUsd,
    }), 0).status).toBe('pending');
    expect(observe(new EntryConfirmationEngine({
      ...relaxed,
      minStressedNetPnlUsd: probe.stressedNetPnlUsd + 0.000001,
    }), 0).reason).toMatch(/stressed/i);
  });
});
