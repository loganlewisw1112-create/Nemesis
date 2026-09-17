/**
 * Shadow follow-up close decision — pure, so the rules that decide what counts
 * as a shadow win or a shadow give-up are testable without an Electron main
 * process.
 *
 * Two defects in the previous inline version made the shadow ledger measure the
 * poller rather than the strategy. Both were found in the 2026-07-29 audit of a
 * 103-scored / 24-win / -$90.68 record:
 *
 *  1. **A missing thesis card read as zero edge.** `cardForTickerSide(...)?.netEdge ?? 0`
 *     manufactured a 0.000000 reading whenever no card existed for the ticker+side,
 *     and 0 satisfies the `netEdge <= 0` edge-gone test — so the candidate was
 *     closed into the spread on absent data. 42 of 74 edge-gone closes had all
 *     three final readings at exactly 0.000000; that path caused 67% of all
 *     recorded losses. A missing card is the absence of a reading, not a reading
 *     of zero: it must skip the observation entirely and can never contribute to
 *     a model-driven close.
 *
 *  2. **The target fired on the first poll that crossed it.** With no stop on the
 *     other side, taking the first crossing of a noisy mark systematically
 *     harvests the running maximum — all 15 target-scored wins landed on the
 *     running maximum of their entire history and 12 were underwater first. Any
 *     strategy with no edge produces winners under that rule. The target now has
 *     to hold across observations spanning real wall time, and the candidate is
 *     scored at the latest mark rather than the peak.
 *
 * The loss stop stays deliberately absent (see the note at the call site): entry
 * to immediate exit always burns spread + fees, so a loss stop before the
 * follow-up horizon would guarantee the shadow gate can never clear. The fix for
 * asymmetry is to make the win condition demand as much evidence as the give-up
 * condition, not to add a stop.
 */

/** Observations that must all read `netEdge <= 0` before a candidate is given up on. */
export const SHADOW_EDGE_GONE_OBSERVATIONS = 3;

/**
 * Observations that must all sit at or above target before the candidate is
 * scored a winner — deliberately the same count the give-up rule demands.
 */
export const SHADOW_TARGET_HOLD_OBSERVATIONS = 3;

/**
 * Wall time the target must survive, on top of the observation count, so three
 * closely-spaced polls of one momentary quote cannot pass for persistence.
 * Two full 5s health ticks.
 */
export const SHADOW_TARGET_HOLD_MS = 10_000;

export interface ShadowObservation {
  at: number;
  executableNetPnlUsd: number;
  netEdge: number;
}

export interface ShadowFollowUpInput {
  now: number;
  startedAt: number;
  dueAt: number;
  /** Absent or non-finite when the candidate carries no target to score against. */
  targetRewardUsd: number | undefined;
  /** Round-trip mark from the current executable book. Always real — a book was fetched to get here. */
  executableNetPnlUsd: number;
  /**
   * The model's net edge right now, or `null` when no thesis card exists for this
   * ticker and side. `null` means "no reading", which is not the same as zero.
   */
  currentNetEdge: number | null;
  /** Observations already on the ledger for this candidate, oldest first. */
  priorObservations: readonly ShadowObservation[];
  /** Edge-gone cannot fire until the candidate has been held at least this long. */
  edgeStopArmMs: number;
}

export interface ShadowFollowUpDecision {
  /** False when there is no model reading to record. */
  recordObservation: boolean;
  observation?: ShadowObservation;
  close: boolean;
  closeReason?: string;
}

function targetHeld(
  observations: readonly ShadowObservation[],
  targetRewardUsd: number,
  now: number,
): boolean {
  const tail = observations.slice(-SHADOW_TARGET_HOLD_OBSERVATIONS);
  if (tail.length < SHADOW_TARGET_HOLD_OBSERVATIONS) return false;
  if (!tail.every((observation) => observation.executableNetPnlUsd >= targetRewardUsd)) return false;
  return now - tail[0]!.at >= SHADOW_TARGET_HOLD_MS;
}

function edgeGone(observations: readonly ShadowObservation[]): boolean {
  const tail = observations.slice(-SHADOW_EDGE_GONE_OBSERVATIONS);
  return tail.length >= SHADOW_EDGE_GONE_OBSERVATIONS
    && tail.every((observation) => observation.netEdge <= 0);
}

export function decideShadowFollowUp(input: ShadowFollowUpInput): ShadowFollowUpDecision {
  const recordObservation = input.currentNetEdge !== null && Number.isFinite(input.currentNetEdge);
  const observation: ShadowObservation | undefined = recordObservation
    ? {
      at: input.now,
      executableNetPnlUsd: input.executableNetPnlUsd,
      netEdge: input.currentNetEdge as number,
    }
    : undefined;
  const observations = observation ? [...input.priorObservations, observation] : input.priorObservations;

  const hasTarget = input.targetRewardUsd !== undefined && Number.isFinite(input.targetRewardUsd);

  // Both model-driven closes require a reading taken right now. Without a card
  // there is no edge and no fresh point in the persistence series, so neither a
  // win nor a give-up can be justified this tick. The deadline is time-based and
  // its mark comes from the book, so it still fires.
  if (recordObservation && hasTarget && targetHeld(observations, input.targetRewardUsd!, input.now)) {
    return { recordObservation, observation, close: true, closeReason: 'shadow target held' };
  }
  if (input.now >= input.dueAt) {
    return { recordObservation, observation, close: true, closeReason: 'shadow 15-minute follow-up complete' };
  }
  const edgeStopArmed = Math.max(0, input.now - input.startedAt) >= input.edgeStopArmMs;
  if (recordObservation && edgeStopArmed && edgeGone(observations)) {
    return {
      recordObservation,
      observation,
      close: true,
      closeReason: 'shadow edge gone for three executable observations',
    };
  }
  return { recordObservation, observation, close: false };
}
