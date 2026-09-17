import type { ThesisCard } from '@nemesis/core';

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Stable source/economic identity. Presentation text and re-issued card.id are
 * excluded so confirmation and campaign enrollment accumulate across GEA
 * signal re-issues for the same ticker/side/playbook/sourceMove.
 */
export function campaignEconomicIdentity(card: Pick<ThesisCard, 'ticker' | 'side' | 'playbook' | 'sourceMove'>): string {
  return [
    normalizeIdentityPart(card.ticker),
    card.side,
    normalizeIdentityPart(card.playbook),
    normalizeIdentityPart(card.sourceMove ?? 'unknown'),
  ].join('|');
}
