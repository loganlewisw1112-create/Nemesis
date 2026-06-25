export interface MarketDescriptor {
  ticker: string;
  title: string;
  category?: string;
}

export interface SettlementRule {
  ticker: string;
  source: string;
  rule_text: string;
  clarity_score: number;
  gate_passed: boolean;
  settlement_url?: string;
}

export interface EventGraphNode {
  id: string;
  type: 'market' | 'event' | 'catalyst' | 'source';
  label: string;
  metadata?: Record<string, unknown>;
}

export interface EventGraphEdge {
  id: string;
  from: string;
  to: string;
  relation: 'settles_via' | 'driven_by' | 'related_to' | 'sourced_from';
  weight: number;
}

export interface EventGraphResult {
  nodes: EventGraphNode[];
  edges: EventGraphEdge[];
}

export interface ProbabilityJudgeResult {
  judge: string;
  probability: number;
  weight: number;
  reason: string;
}

export interface ProbabilityTribunalInput {
  ticker: string;
  market_price: number;
  calibrated_probability: number;
  orderbook_pressure: number;
  trade_flow: number;
  settlement_clarity: number;
  similar_setup_probability: number;
  data_freshness: number;
}

export interface ProbabilityTribunalResult {
  ticker: string;
  nemesis_probability: number;
  confidence_band_low: number;
  confidence_band_high: number;
  model_agreement_score: number;
  judges: ProbabilityJudgeResult[];
}

export interface EdgeEstimateInput {
  ticker: string;
  market_price: number;
  probability: number;
  spread: number;
  fee: number;
  slippage: number;
  depth: number;
  uncertainty: number;
}

export interface EdgeEstimateResult {
  ticker: string;
  raw_edge: number;
  net_edge: number;
  entry_zone_low: number;
  entry_zone_high: number;
  do_not_chase_level: number;
  target_exit: number;
}

export type HoldClass = 'scalp' | 'intraday' | 'catalyst' | 'pre-settlement' | 'settlement' | 'no-hold';

export interface HoldEstimateInput {
  ticker: string;
  event_time: number;
  now: number;
  edge_half_life_ms: number;
  settlement_clarity: number;
  volatility: number;
}

export interface HoldEstimateResult {
  ticker: string;
  hold_class: HoldClass;
  hold_window_ms: number;
  edge_shelf_life_ms: number;
  recheck_at: number;
}

export type ProfitRetentionAction = 'hold' | 'trim' | 'exit' | 'add-only-on-pullback';

export interface ProfitRetentionInput {
  ticker: string;
  original_edge: number;
  current_edge: number;
  captured_edge: number;
  drawdown_from_peak: number;
  settlement_clarity: number;
}

export interface ProfitRetentionResult {
  ticker: string;
  action: ProfitRetentionAction;
  current_edge: number;
  captured_edge: number;
  reason: string;
}

export type NoTradeReason =
  | 'SETTLEMENT_CLARITY_TOO_LOW'
  | 'SPREAD_TOO_WIDE'
  | 'NET_EDGE_TOO_LOW'
  | 'DATA_STALE'
  | 'LIQUIDITY_TOO_THIN';

export interface NoTradeInput {
  ticker: string;
  net_edge: number;
  spread: number;
  settlement_clarity: number;
  data_freshness_ms: number;
  liquidity_score: number;
}

export interface NoTradeDecision {
  ticker: string;
  blocked: boolean;
  reasons: NoTradeReason[];
  what_would_need_to_change: string;
  recheck_at: number;
}

export type AlphaInterceptSignal =
  | 'PUBLIC_DATA_MOVED_MARKET_HAS_NOT'
  | 'ORDERBOOK_IMBALANCE_LEADING_FLOW'
  | 'FRESH_WORLD_DATA_READY';

export interface AlphaInterceptInput {
  ticker: string;
  public_data_delta: number;
  market_move: number;
  orderbook_imbalance: number;
  freshness_ms: number;
}

export interface AlphaIntercept {
  ticker: string;
  signal: AlphaInterceptSignal;
  strength: number;
  reason: string;
}

const MIN_SETTLEMENT_CLARITY = 0.55;

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function standardDeviation(values: number[]): number {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function normalizedText(market: MarketDescriptor): string {
  return `${market.ticker} ${market.title} ${market.category ?? ''}`.toLowerCase();
}

export class SettlementIntelligence {
  static parseRule(market: MarketDescriptor): SettlementRule {
    const text = normalizedText(market);

    if (/\b(cpi|consumer price|inflation|bls)\b/.test(text)) {
      return {
        ticker: market.ticker,
        source: 'BLS',
        rule_text: 'Settles against the Bureau of Labor Statistics release for the referenced CPI period.',
        clarity_score: 0.88,
        gate_passed: true,
        settlement_url: 'https://www.bls.gov/cpi/',
      };
    }

    if (/\b(weather|temperature|rain|snow|hurricane|noaa|nws)\b/.test(text)) {
      return {
        ticker: market.ticker,
        source: 'NOAA/NWS',
        rule_text: 'Settles against official National Weather Service or NOAA observations.',
        clarity_score: 0.86,
        gate_passed: true,
      };
    }

    if (/\b(eia|energy|oil|wti|gas|inventory|crude)\b/.test(text)) {
      return {
        ticker: market.ticker,
        source: 'EIA',
        rule_text: 'Settles against official Energy Information Administration data for the referenced release.',
        clarity_score: 0.84,
        gate_passed: true,
      };
    }

    if (/\b(sec|edgar|filing|earnings|ipo|merger)\b/.test(text)) {
      return {
        ticker: market.ticker,
        source: 'SEC EDGAR',
        rule_text: 'Settles against company filing or official market-event documentation.',
        clarity_score: 0.82,
        gate_passed: true,
      };
    }

    if (/\b(nba|nfl|mlb|nhl|soccer|match|game|tournament)\b/.test(text)) {
      return {
        ticker: market.ticker,
        source: 'Official league source',
        rule_text: 'Settles against the official league or competition result.',
        clarity_score: 0.78,
        gate_passed: true,
      };
    }

    return {
      ticker: market.ticker,
      source: 'Kalshi settlement rules',
      rule_text: 'Settlement source could not be classified with enough specificity for promotion.',
      clarity_score: 0.45,
      gate_passed: false,
    };
  }
}

export class EventGraph {
  static fromMarket(market: MarketDescriptor, catalysts: string[]): EventGraphResult {
    const marketId = `market:${market.ticker}`;
    const eventId = `event:${market.ticker}`;
    const nodes: EventGraphNode[] = [
      { id: marketId, type: 'market', label: market.ticker, metadata: { title: market.title, category: market.category ?? 'unknown' } },
      { id: eventId, type: 'event', label: market.title, metadata: { ticker: market.ticker } },
    ];
    const edges: EventGraphEdge[] = [
      { id: `${marketId}->${eventId}:settles_via`, from: marketId, to: eventId, relation: 'settles_via', weight: 1 },
    ];

    for (const [index, catalyst] of catalysts.entries()) {
      const catalystId = `catalyst:${market.ticker}:${index}`;
      nodes.push({ id: catalystId, type: 'catalyst', label: catalyst, metadata: { rank: index + 1 } });
      edges.push({
        id: `${eventId}->${catalystId}:driven_by`,
        from: eventId,
        to: catalystId,
        relation: 'driven_by',
        weight: round(1 - index * 0.08, 2),
      });
    }

    return { nodes, edges };
  }
}

export class ProbabilityTribunal {
  static evaluate(input: ProbabilityTribunalInput): ProbabilityTribunalResult {
    const marketPrice = clamp(input.market_price);
    const judges: ProbabilityJudgeResult[] = [
      {
        judge: 'Market-Implied',
        probability: clamp(1 - marketPrice),
        weight: 0.12,
        reason: 'Counter-checks the orderbook price against implied consensus.',
      },
      {
        judge: 'Calibrated',
        probability: clamp(input.calibrated_probability),
        weight: 0.2,
        reason: 'Uses locally calibrated setup probability.',
      },
      {
        judge: 'Orderbook',
        probability: clamp(marketPrice + input.orderbook_pressure + 0.08),
        weight: 0.15,
        reason: 'Adjusts price for book pressure and displayed liquidity.',
      },
      {
        judge: 'Trade Flow',
        probability: clamp(marketPrice + input.trade_flow + 0.08),
        weight: 0.13,
        reason: 'Adjusts for recent prints and taker-side pressure.',
      },
      {
        judge: 'Settlement Clarity',
        probability: clamp(0.5 + (input.settlement_clarity - 0.5) * 0.25),
        weight: 0.12,
        reason: 'Rewards markets with verifiable settlement sources.',
      },
      {
        judge: 'Similar Setup',
        probability: clamp(input.similar_setup_probability),
        weight: 0.15,
        reason: 'Uses deterministic nearest-neighbor setup history.',
      },
      {
        judge: 'Meta-Confidence',
        probability: clamp(0.5 + input.data_freshness * 0.08 + input.settlement_clarity * 0.04),
        weight: 0.13,
        reason: 'Blends data freshness and model-confidence context.',
      },
    ];

    const totalWeight = judges.reduce((sum, judge) => sum + judge.weight, 0);
    const finalProbability = judges.reduce((sum, judge) => sum + judge.probability * judge.weight, 0) / totalWeight;
    const deviation = standardDeviation(judges.map((judge) => judge.probability));
    const agreement = clamp(1 - deviation * 2.5, 0.1, 0.99);
    const bandWidth = clamp(0.06 + (1 - agreement) * 0.12, 0.04, 0.18);

    return {
      ticker: input.ticker,
      nemesis_probability: round(finalProbability),
      confidence_band_low: round(clamp(finalProbability - bandWidth)),
      confidence_band_high: round(clamp(finalProbability + bandWidth)),
      model_agreement_score: round(agreement),
      judges: judges.map((judge) => ({ ...judge, probability: round(judge.probability) })),
    };
  }
}

export class EdgeEngine {
  static estimate(input: EdgeEstimateInput): EdgeEstimateResult {
    const rawEdge = input.probability - input.market_price;
    const executionDrag = input.spread / 2 + input.fee + input.slippage;
    const uncertaintyDrag = clamp(input.uncertainty) * 0.02;
    const depthDrag = (1 - clamp(input.depth)) * 0.015;
    const netEdge = rawEdge - executionDrag - uncertaintyDrag - depthDrag;
    const entryZoneLow = clamp(input.market_price - Math.max(0.01, input.spread), 0.01, 0.99);
    const entryZoneHigh = clamp(input.market_price + Math.max(0.01, netEdge / 2), 0.01, 0.99);
    const doNotChase = Math.max(entryZoneHigh + 0.01, input.probability - 0.03);

    return {
      ticker: input.ticker,
      raw_edge: round(rawEdge),
      net_edge: round(netEdge),
      entry_zone_low: round(entryZoneLow),
      entry_zone_high: round(entryZoneHigh),
      do_not_chase_level: round(clamp(doNotChase, 0.01, 0.99)),
      target_exit: round(clamp(input.probability + Math.max(0.03, netEdge), 0.01, 0.99)),
    };
  }
}

export class HoldOptimizer {
  static estimate(input: HoldEstimateInput): HoldEstimateResult {
    const untilEvent = Math.max(0, input.event_time - input.now);
    const edgeShelfLife = Math.max(0, input.edge_half_life_ms * (1 - clamp(input.volatility) * 0.45));
    let holdClass: HoldClass = 'settlement';

    if (input.settlement_clarity < MIN_SETTLEMENT_CLARITY) holdClass = 'no-hold';
    else if (untilEvent <= 30 * 60 * 1000) holdClass = 'scalp';
    else if (untilEvent <= 6 * 60 * 60 * 1000) holdClass = 'intraday';
    else if (untilEvent <= 72 * 60 * 60 * 1000) holdClass = 'catalyst';
    else if (untilEvent <= 7 * 24 * 60 * 60 * 1000) holdClass = 'pre-settlement';

    return {
      ticker: input.ticker,
      hold_class: holdClass,
      hold_window_ms: holdClass === 'no-hold' ? 0 : Math.min(untilEvent, edgeShelfLife),
      edge_shelf_life_ms: round(edgeShelfLife, 0),
      recheck_at: input.now + Math.max(60_000, Math.min(edgeShelfLife / 3, 30 * 60 * 1000)),
    };
  }
}

export class ProfitRetentionEngine {
  static evaluate(input: ProfitRetentionInput): ProfitRetentionResult {
    const captureRatio = input.original_edge > 0 ? input.captured_edge / input.original_edge : 0;

    if (input.settlement_clarity < MIN_SETTLEMENT_CLARITY || input.current_edge <= 0.02 || input.drawdown_from_peak > 0.15) {
      return {
        ticker: input.ticker,
        action: 'exit',
        current_edge: round(input.current_edge),
        captured_edge: round(input.captured_edge),
        reason: 'Edge or settlement quality no longer supports the position.',
      };
    }

    if (captureRatio >= 0.6 && input.current_edge < input.original_edge * 0.5) {
      return {
        ticker: input.ticker,
        action: 'trim',
        current_edge: round(input.current_edge),
        captured_edge: round(input.captured_edge),
        reason: 'Captured most available edge while remaining edge has compressed.',
      };
    }

    if (input.current_edge > input.original_edge * 0.85 && input.drawdown_from_peak < 0.04) {
      return {
        ticker: input.ticker,
        action: 'add-only-on-pullback',
        current_edge: round(input.current_edge),
        captured_edge: round(input.captured_edge),
        reason: 'Edge remains intact; add only if price returns to the entry zone.',
      };
    }

    return {
      ticker: input.ticker,
      action: 'hold',
      current_edge: round(input.current_edge),
      captured_edge: round(input.captured_edge),
      reason: 'Position still has enough live edge to justify holding.',
    };
  }
}

export class NoTradeIntelligence {
  static evaluate(input: NoTradeInput): NoTradeDecision {
    const reasons: NoTradeReason[] = [];
    if (input.settlement_clarity < MIN_SETTLEMENT_CLARITY) reasons.push('SETTLEMENT_CLARITY_TOO_LOW');
    if (input.spread > 0.07) reasons.push('SPREAD_TOO_WIDE');
    if (input.net_edge < 0.02) reasons.push('NET_EDGE_TOO_LOW');
    if (input.data_freshness_ms > 60_000) reasons.push('DATA_STALE');
    if (input.liquidity_score < 0.35) reasons.push('LIQUIDITY_TOO_THIN');

    const blocked = reasons.length > 0;
    return {
      ticker: input.ticker,
      blocked,
      reasons,
      what_would_need_to_change: blocked
        ? `Resolve ${reasons.join(', ')} before promotion.`
        : 'No blocking condition detected.',
      recheck_at: Date.now() + (blocked ? 5 * 60_000 : 10 * 60_000),
    };
  }
}

export class AlphaInterceptEngine {
  static detect(input: AlphaInterceptInput): AlphaIntercept[] {
    const signals: AlphaIntercept[] = [];
    if (Math.abs(input.public_data_delta) >= 0.05 && Math.abs(input.market_move) <= 0.02 && input.freshness_ms <= 5_000) {
      signals.push({
        ticker: input.ticker,
        signal: 'PUBLIC_DATA_MOVED_MARKET_HAS_NOT',
        strength: round(clamp(Math.abs(input.public_data_delta) * 8), 3),
        reason: 'Fresh public data moved materially before the market price followed.',
      });
    }

    if (Math.abs(input.orderbook_imbalance) >= 0.15) {
      signals.push({
        ticker: input.ticker,
        signal: 'ORDERBOOK_IMBALANCE_LEADING_FLOW',
        strength: round(clamp(Math.abs(input.orderbook_imbalance) * 4), 3),
        reason: 'Displayed depth imbalance may be leading near-term trade flow.',
      });
    }

    if (input.freshness_ms <= 1_000 && signals.length === 0) {
      signals.push({
        ticker: input.ticker,
        signal: 'FRESH_WORLD_DATA_READY',
        strength: 0.35,
        reason: 'Source data is fresh enough for tribunal refresh.',
      });
    }

    return signals;
  }
}
