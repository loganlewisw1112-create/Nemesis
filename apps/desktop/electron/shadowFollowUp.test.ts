import { describe, expect, it } from 'vitest';
import {
  decideShadowFollowUp,
  SHADOW_EDGE_GONE_OBSERVATIONS,
  SHADOW_TARGET_HOLD_MS,
  SHADOW_TARGET_HOLD_OBSERVATIONS,
  type ShadowFollowUpInput,
  type ShadowObservation,
} from './shadowFollowUp.js';

const STARTED_AT = 1_000_000;
const TICK_MS = 5_000;
const ARM_MS = 15_000;
const DUE_AT = STARTED_AT + 15 * 60_000;

function observations(
  count: number,
  values: { netEdge: number; executableNetPnlUsd: number },
  endingAt: number,
): ShadowObservation[] {
  return Array.from({ length: count }, (_unused, index) => ({
    at: endingAt - (count - 1 - index) * TICK_MS,
    executableNetPnlUsd: values.executableNetPnlUsd,
    netEdge: values.netEdge,
  }));
}

function input(overrides: Partial<ShadowFollowUpInput> = {}): ShadowFollowUpInput {
  return {
    now: STARTED_AT + 60_000,
    startedAt: STARTED_AT,
    dueAt: DUE_AT,
    targetRewardUsd: 2,
    executableNetPnlUsd: -1.4,
    currentNetEdge: 0.05,
    priorObservations: [],
    edgeStopArmMs: ARM_MS,
    ...overrides,
  };
}

describe('decideShadowFollowUp — missing thesis card', () => {
  // The audit's dominant loss path: `cardForTickerSide(...)?.netEdge ?? 0` turned
  // "no card" into a 0.000000 edge reading, and 0 satisfies `netEdge <= 0`, so
  // three consecutive missing cards closed the candidate into the spread. 42 of 74
  // edge-gone closes had all three final readings at exactly 0.000000, causing 67%
  // of every recorded loss.
  it('records no observation when there is no card to read', () => {
    const decision = decideShadowFollowUp(input({ currentNetEdge: null }));
    expect(decision.recordObservation).toBe(false);
    expect(decision.observation).toBeUndefined();
    expect(decision.close).toBe(false);
  });

  it('never closes on edge-gone when the card is missing, however long it stays missing', () => {
    // A candidate whose card vanished: no prior readings at all, well past the arm window.
    let now = STARTED_AT + ARM_MS;
    for (let tick = 0; tick < 20; tick += 1) {
      now += TICK_MS;
      const decision = decideShadowFollowUp(input({ now, currentNetEdge: null }));
      expect(decision.recordObservation).toBe(false);
      expect(decision.close).toBe(false);
    }
  });

  it('does not let a missing card complete an edge-gone series left one short', () => {
    const now = STARTED_AT + 60_000;
    const prior = observations(SHADOW_EDGE_GONE_OBSERVATIONS - 1, { netEdge: -0.02, executableNetPnlUsd: -1.4 }, now - TICK_MS);
    expect(decideShadowFollowUp(input({ now, currentNetEdge: null, priorObservations: prior })).close).toBe(false);
    // The same series completed by a real non-positive reading does close.
    expect(decideShadowFollowUp(input({ now, currentNetEdge: -0.01, priorObservations: prior })))
      .toMatchObject({ close: true, closeReason: 'shadow edge gone for three executable observations' });
  });

  it('still closes on the time deadline without a card — the mark comes from the book', () => {
    const decision = decideShadowFollowUp(input({ now: DUE_AT, currentNetEdge: null }));
    expect(decision.recordObservation).toBe(false);
    expect(decision).toMatchObject({ close: true, closeReason: 'shadow 15-minute follow-up complete' });
  });

  it('treats a genuine zero edge as a reading, unlike a missing card', () => {
    const now = STARTED_AT + 60_000;
    const prior = observations(SHADOW_EDGE_GONE_OBSERVATIONS - 1, { netEdge: 0, executableNetPnlUsd: -1.4 }, now - TICK_MS);
    const decision = decideShadowFollowUp(input({ now, currentNetEdge: 0, priorObservations: prior }));
    expect(decision.recordObservation).toBe(true);
    expect(decision).toMatchObject({ close: true, closeReason: 'shadow edge gone for three executable observations' });
  });

  it('does not arm edge-gone before the confirmation window has elapsed', () => {
    const now = STARTED_AT + ARM_MS - 1;
    const prior = observations(SHADOW_EDGE_GONE_OBSERVATIONS - 1, { netEdge: -0.02, executableNetPnlUsd: -1.4 }, now - 1);
    expect(decideShadowFollowUp(input({ now, currentNetEdge: -0.02, priorObservations: prior })).close).toBe(false);
  });
});

describe('decideShadowFollowUp — target persistence', () => {
  // The audit's win-manufacturing path: the target fired on the first poll whose
  // mark crossed it, with no stop on the other side. All 15 target-scored wins
  // landed on the running maximum of their entire history and 12 were underwater
  // first — the signature of harvesting the running max of a noisy series, which
  // any no-edge strategy produces.
  it('does not score a win on a single crossing poll', () => {
    const now = STARTED_AT + 60_000;
    const prior = observations(4, { netEdge: 0.05, executableNetPnlUsd: -1.4 }, now - TICK_MS);
    const decision = decideShadowFollowUp(input({
      now,
      priorObservations: prior,
      executableNetPnlUsd: 2.5,
    }));
    expect(decision.recordObservation).toBe(true);
    expect(decision.close).toBe(false);
  });

  it('does not score a win on a spike that gives the level back', () => {
    let now = STARTED_AT + 60_000;
    const series: ShadowObservation[] = observations(3, { netEdge: 0.05, executableNetPnlUsd: -1.4 }, now);
    // One poll above target, then back under.
    for (const mark of [2.5, -1.2, -1.3]) {
      now += TICK_MS;
      const decision = decideShadowFollowUp(input({
        now,
        priorObservations: series,
        executableNetPnlUsd: mark,
      }));
      expect(decision.close).toBe(false);
      series.push(decision.observation!);
    }
  });

  it('scores a win once the target holds across the required observations and wall time', () => {
    let now = STARTED_AT + 60_000;
    let series: ShadowObservation[] = observations(2, { netEdge: 0.05, executableNetPnlUsd: -1.4 }, now);
    let closed: ReturnType<typeof decideShadowFollowUp> | undefined;
    let ticksAboveTarget = 0;
    for (let tick = 0; tick < 6 && !closed?.close; tick += 1) {
      now += TICK_MS;
      const decision = decideShadowFollowUp(input({ now, priorObservations: series, executableNetPnlUsd: 2.5 }));
      ticksAboveTarget += 1;
      series = [...series, decision.observation!];
      if (decision.close) closed = decision;
    }
    expect(closed).toMatchObject({ close: true, closeReason: 'shadow target held' });
    expect(ticksAboveTarget).toBeGreaterThanOrEqual(SHADOW_TARGET_HOLD_OBSERVATIONS);
  });

  it('requires wall time as well as a count — three rapid polls are not persistence', () => {
    const now = STARTED_AT + 60_000;
    const rapid: ShadowObservation[] = [
      { at: now - 200, executableNetPnlUsd: 2.5, netEdge: 0.05 },
      { at: now - 100, executableNetPnlUsd: 2.5, netEdge: 0.05 },
    ];
    expect(now - rapid[0]!.at).toBeLessThan(SHADOW_TARGET_HOLD_MS);
    expect(decideShadowFollowUp(input({ now, priorObservations: rapid, executableNetPnlUsd: 2.5 })).close).toBe(false);

    const spaced = rapid.map((observation, index) => ({
      ...observation,
      at: now - (SHADOW_TARGET_HOLD_MS + TICK_MS) + index * TICK_MS,
    }));
    expect(decideShadowFollowUp(input({ now, priorObservations: spaced, executableNetPnlUsd: 2.5 })))
      .toMatchObject({ close: true, closeReason: 'shadow target held' });
  });

  it('scores the held target at the latest mark, not the peak', () => {
    const now = STARTED_AT + 60_000;
    const prior: ShadowObservation[] = [
      { at: now - 2 * TICK_MS, executableNetPnlUsd: 9.9, netEdge: 0.05 },
      { at: now - TICK_MS, executableNetPnlUsd: 4.0, netEdge: 0.05 },
    ];
    const decision = decideShadowFollowUp(input({ now, priorObservations: prior, executableNetPnlUsd: 2.1 }));
    expect(decision).toMatchObject({ close: true, closeReason: 'shadow target held' });
    // The caller scores at executableNetPnlUsd; the decision reports the current
    // observation, which carries the latest mark rather than the 9.9 running max.
    expect(decision.observation?.executableNetPnlUsd).toBe(2.1);
  });

  it('never closes on a held target without a current reading', () => {
    const now = STARTED_AT + 60_000;
    const prior = observations(SHADOW_TARGET_HOLD_OBSERVATIONS, { netEdge: 0.05, executableNetPnlUsd: 2.5 }, now - TICK_MS);
    expect(decideShadowFollowUp(input({ now, currentNetEdge: null, priorObservations: prior, executableNetPnlUsd: 2.5 })).close)
      .toBe(false);
  });

  it('takes the deadline over a target that has not yet held', () => {
    const prior = observations(2, { netEdge: 0.05, executableNetPnlUsd: -1.4 }, DUE_AT - TICK_MS);
    expect(decideShadowFollowUp(input({ now: DUE_AT, priorObservations: prior, executableNetPnlUsd: 2.5 })))
      .toMatchObject({ close: true, closeReason: 'shadow 15-minute follow-up complete' });
  });

  it('ignores a non-finite target rather than treating it as reachable', () => {
    const now = STARTED_AT + 60_000;
    const prior = observations(SHADOW_TARGET_HOLD_OBSERVATIONS, { netEdge: 0.05, executableNetPnlUsd: 2.5 }, now - TICK_MS);
    for (const targetRewardUsd of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decideShadowFollowUp(input({ now, targetRewardUsd, priorObservations: prior, executableNetPnlUsd: 2.5 })).close)
        .toBe(false);
    }
  });
});
