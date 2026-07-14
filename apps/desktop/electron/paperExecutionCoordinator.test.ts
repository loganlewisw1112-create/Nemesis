import { describe, expect, it } from 'vitest';
import type { ThesisCard } from '@nemesis/core';
import { OpportunityThroughputQueue, PaperDesk } from '@nemesis/execution';
import { PaperExecutionCoordinator } from './paperExecutionCoordinator.js';

function card(ticker: string, side: 'yes' | 'no'): ThesisCard {
  return {
    id: `${ticker}-${side}`,
    ticker,
    title: ticker,
    category: 'sports',
    playbook: 'flow-hunter',
    side,
    impliedPrice: 0.7,
    marketPrice: 0.4,
    grossEdge: 0.3,
    netEdge: 0.27,
    spread: 0.02,
    depthUsd: 500,
    freshnessMs: 100,
    predictability: 90,
    feeEstimate: 0.01,
    signalReason: 'GEA trade flow',
    externalSummary: 'test',
    createdAt: 1,
    updatedAt: 1,
    edgeHistory: [0.27],
    drivers: [],
    status: 'tradeable',
    invalidations: [],
  };
}

function inFlight() {
  return {
    ok: false as const,
    aborted: true,
    abortCode: 'execution_in_flight',
    queueState: 'blocked_retryable' as const,
    wouldMutate: false,
  };
}

describe('PaperExecutionCoordinator integration', () => {
  it('allows one mutation and one execution count for concurrent identical keys', async () => {
    const coordinator = new PaperExecutionCoordinator();
    const desk = new PaperDesk(1_000);
    const queue = new OpportunityThroughputQueue();
    const opportunity = card('KENSHE', 'yes');
    queue.discover([opportunity]);
    let releaseRun!: () => void;
    const held = new Promise<void>((resolve) => { releaseRun = resolve; });
    let stats = 0;

    const execute = () => coordinator.execute(
      'KENSHE:yes',
      async () => {
        await held;
        const opened = desk.openPosition(opportunity, 10, 0.4);
        if (opened.ok) {
          queue.markExecuted('KENSHE:yes');
          stats += 1;
        }
        return { ok: opened.ok, wouldMutate: opened.ok };
      },
      inFlight,
    );

    const first = execute();
    expect(coordinator.isReserved('KENSHE:yes')).toBe(true);
    const duplicate = await execute();
    releaseRun();
    const accepted = await first;

    expect(duplicate).toMatchObject({ ok: false, abortCode: 'execution_in_flight', wouldMutate: false });
    expect(accepted).toMatchObject({ ok: true, wouldMutate: true });
    expect(desk.snapshot().trades).toHaveLength(1);
    expect(desk.snapshot().positions[0]?.contracts).toBe(10);
    expect(queue.snapshot().telemetry.executedTrades).toBe(1);
    expect(stats).toBe(1);
  });

  it('keeps opposite sides independent', async () => {
    const coordinator = new PaperExecutionCoordinator();
    const desk = new PaperDesk(1_000);
    const yes = card('KENSHE', 'yes');
    const no = card('KENSHE', 'no');

    const [yesResult, noResult] = await Promise.all([
      coordinator.execute('KENSHE:yes', async () => desk.openPosition(yes, 5, 0.4), inFlight),
      coordinator.execute('KENSHE:no', async () => desk.openPosition(no, 5, 0.4), inFlight),
    ]);

    expect(yesResult.ok).toBe(true);
    expect(noResult.ok).toBe(true);
    expect(desk.snapshot().positions).toHaveLength(2);
  });

  it('releases after failure so a later retry can execute', async () => {
    const coordinator = new PaperExecutionCoordinator();
    const desk = new PaperDesk(1_000);
    const opportunity = card('BOUZHA', 'yes');

    await expect(coordinator.execute(
      'BOUZHA:yes',
      async () => { throw new Error('book failed'); },
      inFlight,
    )).rejects.toThrow('book failed');

    expect(coordinator.isReserved('BOUZHA:yes')).toBe(false);
    const retry = await coordinator.execute(
      'BOUZHA:yes',
      async () => desk.openPosition(opportunity, 5, 0.4),
      inFlight,
    );
    expect(retry.ok).toBe(true);
    expect(desk.snapshot().trades).toHaveLength(1);
  });
});
