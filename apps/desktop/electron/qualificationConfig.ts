import { createHash } from 'node:crypto';
import type { DiscoverySettings, GuardrailSettings } from '@nemesis/core';

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
  return createHash('sha256')
    .update(stableJson({ guardrails: qualificationSettings, discovery: discoverySettings }))
    .digest('hex');
}
