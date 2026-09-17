export interface NoTradeDecisionIdentity {
  ticker: string;
  reasons: string[];
  what_would_need_to_change: string;
}

export function noTradeDecisionSignature(decision: NoTradeDecisionIdentity): string {
  return `${decision.ticker}:${decision.reasons.join('|')}:${decision.what_would_need_to_change}`;
}
