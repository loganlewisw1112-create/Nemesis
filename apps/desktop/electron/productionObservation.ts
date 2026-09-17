import { createHash } from 'node:crypto';

export interface ProductionObservationInput {
  enabled: boolean;
  liveEnabled: boolean;
  autoLiveEnabled: boolean;
  dryRun: boolean;
  demoMode: boolean;
  paperPositions: readonly unknown[];
  paperTrades: readonly unknown[];
  workingOrders: readonly unknown[];
  paperPortfolio: unknown;
  paperOrderState: unknown;
  /**
   * Hashes of every durable paper, safety, credential, and strategy-config
   * artifact that must remain byte-for-byte unchanged during observation.
   * Only digests belong here; credential contents must never enter evidence.
   */
  protectedArtifacts: Readonly<Record<string, string>>;
  /** Runtime strategy/discovery configuration, independently of file layout. */
  configurationHash: string;
  /** In-memory paper/config state that may change before a file is flushed. */
  protectedRuntimeState: unknown;
}

export interface ProductionObservationState {
  enabled: boolean;
  settingsLocked: boolean;
  liveEnabled: boolean;
  autoLiveEnabled: boolean;
  dryRun: boolean;
  demoMode: boolean;
  paperPositionCount: number;
  paperTradeCount: number;
  workingOrderCount: number;
  stateHash: string;
  baselineHash: string | null;
  unchanged: boolean;
  qualificationReady: boolean;
  reasons: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function productionObservationStateHash(input: ProductionObservationInput): string {
  const protectedState = canonicalize({
    settings: {
      liveEnabled: input.liveEnabled,
      autoLiveEnabled: input.autoLiveEnabled,
      dryRun: input.dryRun,
      demoMode: input.demoMode,
    },
    paperPortfolio: input.paperPortfolio,
    paperOrderState: input.paperOrderState,
    protectedArtifacts: input.protectedArtifacts,
    configurationHash: input.configurationHash,
    protectedRuntimeState: input.protectedRuntimeState,
  });
  return createHash('sha256').update(JSON.stringify(protectedState)).digest('hex');
}

export function assessProductionObservation(
  input: ProductionObservationInput,
  baselineHash: string | null,
): ProductionObservationState {
  const stateHash = productionObservationStateHash(input);
  const settingsLocked = input.liveEnabled === false
    && input.autoLiveEnabled === false
    && input.dryRun === true
    && input.demoMode === false;
  const reasons: string[] = [];
  if (!input.enabled) reasons.push('production observation mode is not enabled');
  if (!settingsLocked) reasons.push('live, auto-live, dry-run, or demo setting is unsafe');
  if (input.paperPositions.length > 0) reasons.push('paper positions are not empty');
  if (input.paperTrades.length > 0) reasons.push('paper trades are not empty');
  if (input.workingOrders.length > 0) reasons.push('paper working orders are not empty');
  if (baselineHash == null) reasons.push('protected-state baseline is missing');
  else if (stateHash !== baselineHash) reasons.push('protected paper or safety state changed');
  return {
    enabled: input.enabled,
    settingsLocked,
    liveEnabled: input.liveEnabled,
    autoLiveEnabled: input.autoLiveEnabled,
    dryRun: input.dryRun,
    demoMode: input.demoMode,
    paperPositionCount: input.paperPositions.length,
    paperTradeCount: input.paperTrades.length,
    workingOrderCount: input.workingOrders.length,
    stateHash,
    baselineHash,
    unchanged: baselineHash != null && stateHash === baselineHash,
    qualificationReady: reasons.length === 0,
    reasons,
  };
}
