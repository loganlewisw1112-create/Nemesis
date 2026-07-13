import type { PlaybookId, ThesisCard, ThesisStatus } from '@nemesis/core';

const RESEARCH_SIMULATION_STATUSES = new Set<ThesisStatus>([
  'tradeable',
  'qualified',
  'watch-only',
]);

// Only signals backed by current per-ticker trade/orderbook evidence or
// confirmed live crypto flow may open a position. Shared forecasts, broad
// news, and coarse alerts remain research surfaces and cannot authorize execution.
const ENTRY_PLAYBOOKS = new Set<PlaybookId>([
  'flow-hunter',
  'crypto-lead',
]);

type EntryCard = Pick<ThesisCard, 'status' | 'playbook' | 'invalidations' | 'netEdge' | 'sourceMove'>;

export function entryEligibilityBlockReason(card: EntryCard): string | undefined {
  if (card.status !== 'tradeable') return `status ${card.status} is research-only`;
  if (!ENTRY_PLAYBOOKS.has(card.playbook)) return `playbook ${card.playbook} is research-only`;
  if (card.invalidations.length > 0) return `active invalidation: ${card.invalidations.join(', ')}`;
  if (!Number.isFinite(card.netEdge) || card.netEdge <= 0) return 'net edge must be positive';
  if (card.playbook === 'crypto-lead' && card.sourceMove !== 'flow-driven') return 'crypto-lead requires confirmed live flow';
  return undefined;
}

export function isEntryEligible(card: EntryCard): boolean {
  return entryEligibilityBlockReason(card) === undefined;
}

export function isResearchSimulationEligible(card: Pick<ThesisCard, 'status'>): boolean {
  return RESEARCH_SIMULATION_STATUSES.has(card.status);
}
