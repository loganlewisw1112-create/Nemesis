import type { CampaignSnapshot } from '@nemesis/execution';

export type PaperExecutionSource = 'manual' | 'working-order' | 'throughput';

export function isEvidenceOnlyCampaignExecution(
  source: PaperExecutionSource,
  campaign: CampaignSnapshot | null,
): boolean {
  return source === 'throughput'
    && campaign?.manifest.status === 'active';
}

export function campaignPendingCapacity(
  campaign: CampaignSnapshot,
  maxPendingCandidates: number,
): number {
  const pending = campaign.candidates.filter((candidate) => !candidate.terminalState).length;
  return Math.max(0, maxPendingCandidates - pending);
}
