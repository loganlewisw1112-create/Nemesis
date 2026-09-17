import { createHash } from 'node:crypto';
import { DEFAULT_ENTRY_QUALIFICATION, type DiscoverySettings, type GuardrailSettings } from '@nemesis/core';

export const PAPER_STRATEGY_ENGINE_VERSION = 3;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function buildStrategyConfigHash(
  settings: GuardrailSettings,
  discoverySettings: DiscoverySettings,
): string {
  const qualificationSettings = { ...settings } as Record<string, unknown>;
  for (const key of [
    'liveEnabled',
    'liveStage',
    'autoLiveEnabled',
    'liveUnlockCertificate',
    'demoMode',
    'dryRun',
    'killSwitchActive',
    'kalshiApiKeyId',
    'humanQuizPassed',
    'backtestPassed',
  ]) delete qualificationSettings[key];
  // Shadow sample-size / calendar/time acceptance only — same rationale as
  // NEMESIS_SHADOW_MIN_* env overrides in main.ts: changing them must not
  // pause evidence continuity. Pin existing historical bars to shipped defaults,
  // and omit newer acceptance-only fields that older ledgers never hashed.
  const entryQualification = qualificationSettings.entryQualification;
  if (entryQualification && typeof entryQualification === 'object') {
    qualificationSettings.entryQualification = {
      ...(entryQualification as Record<string, unknown>),
      shadowMinScored: DEFAULT_ENTRY_QUALIFICATION.shadowMinScored,
      shadowMinDistinctDays: DEFAULT_ENTRY_QUALIFICATION.shadowMinDistinctDays,
    };
    delete (qualificationSettings.entryQualification as Record<string, unknown>).shadowMinObservationMs;
  }
  return createHash('sha256')
    .update(stableJson({
      strategyEngineVersion: PAPER_STRATEGY_ENGINE_VERSION,
      guardrails: qualificationSettings,
      discovery: discoverySettings,
    }))
    .digest('hex');
}
