import type { ThesisCard } from '@nemesis/core';
import { computeNetEdge } from '@nemesis/core';

const TRADABLE = new Set(['tradeable', 'qualified', 'watch-only']);

export function buildProfitExplanation(card: ThesisCard): string[] {
  const sideLabel = card.side.toUpperCase();
  const mkt = (card.marketPrice * 100).toFixed(1);
  const fair = (card.impliedPrice * 100).toFixed(1);
  const gross = (card.grossEdge * 100).toFixed(1);
  const spread = ((card.spread / 2) * 100).toFixed(1);
  const fees = (card.feeEstimate * 100).toFixed(1);
  const net = (card.netEdge * 100).toFixed(1);

  const lines = [
    `${sideLabel} is offered at ${mkt}¢ but ${card.playbook} fair value is ${fair}¢ — market looks mispriced by ${gross}¢ gross.`,
    `After half-spread (${spread}¢) and Kalshi fees (~${fees}¢/contract), estimated net edge is ${net}¢ per contract.`,
    card.signalReason,
    card.externalSummary,
  ];

  if (card.drivers.length > 0) {
    lines.push(
      'Drivers: ' + card.drivers.map((d) => `${d.label} (${d.impact >= 0 ? '+' : ''}${(d.impact * 100).toFixed(1)}¢)`).join(' · '),
    );
  }

  if (card.invalidations.length > 0) {
    lines.push(`Failed gates: ${card.invalidations.join(', ')}`);
  } else if (TRADABLE.has(card.status)) {
    lines.push('All qualification gates passed — eligible for paper/dry-run.');
  }

  return lines;
}

export function passedGateSummary(card: ThesisCard): { passed: string[]; failed: string[] } {
  const all = ['netEdge', 'liquidity', 'freshness', 'confidence', 'agreement', 'regime', 'concentration', 'executionHealth'];
  const failed = card.invalidations;
  const passed = all.filter((g) => !failed.includes(g));
  return { passed, failed };
}

const GATE_RISK_LABELS: Record<string, { label: string; detail: string }> = {
  netEdge:         { label: 'Negative net edge', detail: 'After spread + fees, expected profit is negative. This trade costs more in friction than the fair-value gap earns.' },
  liquidity:       { label: 'Thin liquidity', detail: 'Less than $50 fillable at current market depth. Large fills will move the price against you.' },
  freshness:       { label: 'Stale signal', detail: 'Source data is more than 2 minutes old. Market may have moved since the estimate was generated.' },
  confidence:      { label: 'Low confidence', detail: 'Signal predictability is below threshold. The model has weak conviction on fair value here.' },
  agreement:       { label: 'Source disagreement', detail: 'Multiple data sources give conflicting estimates. Edge is uncertain when sources diverge.' },
  regime:          { label: 'Adverse regime', detail: 'Current market conditions (wide spreads, low depth, or high volatility) are unfavorable for entry.' },
  concentration:   { label: 'Concentration risk', detail: 'Too many open positions in this event or category. Adding more increases correlated exposure.' },
  executionHealth: { label: 'Execution degraded', detail: 'API or order-flow issues detected. Fill quality may be worse than modelled.' },
};

const GATE_OK_LABELS: Record<string, string> = {
  netEdge:         'Net edge positive after all costs',
  liquidity:       'Liquidity sufficient for entry',
  freshness:       'Signal data is fresh (<2 min)',
  confidence:      'Predictability meets threshold',
  agreement:       'Sources agree on fair value',
  regime:          'Market regime is favorable',
  concentration:   'Concentration within limits',
  executionHealth: 'Execution health is normal',
};

export interface RiskItem {
  key: string;
  ok: boolean;
  label: string;
  detail: string;
}

export function buildRiskItems(card: ThesisCard): RiskItem[] {
  const allGates = ['netEdge', 'liquidity', 'freshness', 'confidence', 'agreement', 'regime', 'concentration', 'executionHealth'];
  const failed = new Set(card.invalidations);
  return allGates.map((g) => {
    const isOk = !failed.has(g);
    return {
      key: g,
      ok: isOk,
      label: isOk ? GATE_OK_LABELS[g] : (GATE_RISK_LABELS[g]?.label ?? g),
      detail: isOk ? '' : (GATE_RISK_LABELS[g]?.detail ?? ''),
    };
  });
}

export function depthRiskItem(card: ThesisCard): RiskItem {
  if (card.executableTier) {
    return {
      key: 'depth',
      ok: true,
      label: `Depth verified — ${card.executableTier.toUpperCase()} tier (~$${(card.fillableUsd ?? 0).toFixed(0)} fillable, ${((card.slippagePp ?? 0) * 100).toFixed(1)}¢ slip)`,
      detail: '',
    };
  }
  return {
    key: 'depth',
    ok: false,
    label: 'Depth unverified',
    detail: 'Orderbook depth data is unavailable for this ticker. Fill size and slippage are estimates only — actual execution quality is unknown.',
  };
}

export function edgeBreakdownRows(card: ThesisCard) {
  const b = computeNetEdge(card.impliedPrice, card.marketPrice, card.spread);
  return [
    { label: 'Gross edge', value: b.grossEdge, note: 'Fair value − market' },
    { label: 'Spread cost', value: -b.spreadCost, note: 'Half spread' },
    { label: 'Fees', value: -b.feeCost, note: 'Kalshi taker fee' },
    { label: 'Net edge', value: b.netEdge, note: 'Expected profit / contract' },
  ];
}
