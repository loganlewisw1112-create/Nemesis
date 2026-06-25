import { describe, expect, it } from 'vitest';
import {
  AlphaInterceptEngine,
  EdgeEngine,
  EventGraph,
  HoldOptimizer,
  NoTradeIntelligence,
  ProbabilityTribunal,
  ProfitRetentionEngine,
  SettlementIntelligence,
} from './index.js';

describe('settlement intelligence and event graph', () => {
  it('parses settlement rules and blocks low-clarity promotion', () => {
    const rule = SettlementIntelligence.parseRule({
      ticker: 'KXCPI-26JUN',
      title: 'Will CPI year-over-year be above 3.2% for June 2026?',
      category: 'macro',
    });

    expect(rule).toMatchObject({
      ticker: 'KXCPI-26JUN',
      source: 'BLS',
      clarity_score: 0.88,
      gate_passed: true,
    });

    const vague = SettlementIntelligence.parseRule({ ticker: 'KXMISC', title: 'Will something notable happen?', category: 'other' });
    expect(vague.gate_passed).toBe(false);
  });

  it('builds market-event-catalyst graph nodes and edges', () => {
    const graph = EventGraph.fromMarket({
      ticker: 'KXCPI-26JUN',
      title: 'Will CPI year-over-year be above 3.2% for June 2026?',
      category: 'macro',
    }, ['CPI release', 'BLS settlement']);

    expect(graph.nodes.map((node) => node.type)).toEqual(expect.arrayContaining(['market', 'event', 'catalyst']));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'settles_via' }),
      expect.objectContaining({ relation: 'driven_by' }),
    ]));
  });
});

describe('tribunal, edge, hold, retention, and no-trade logic', () => {
  it('produces explainable probability and net edge estimates', () => {
    const tribunal = ProbabilityTribunal.evaluate({
      ticker: 'KXCPI-26JUN',
      market_price: 0.42,
      calibrated_probability: 0.56,
      orderbook_pressure: 0.04,
      trade_flow: 0.03,
      settlement_clarity: 0.88,
      similar_setup_probability: 0.58,
      data_freshness: 0.92,
    });
    const edge = EdgeEngine.estimate({
      ticker: 'KXCPI-26JUN',
      market_price: 0.42,
      probability: tribunal.nemesis_probability,
      spread: 0.03,
      fee: 0.01,
      slippage: 0.01,
      depth: 0.8,
      uncertainty: 1 - tribunal.model_agreement_score,
    });

    expect(tribunal.judges).toHaveLength(7);
    expect(tribunal.nemesis_probability).toBeGreaterThan(0.5);
    expect(edge.raw_edge).toBeGreaterThan(edge.net_edge);
    expect(edge.entry_zone_high).toBeLessThan(edge.do_not_chase_level);
  });

  it('creates time-aware hold and profit-retention actions', () => {
    const hold = HoldOptimizer.estimate({
      ticker: 'KXCPI-26JUN',
      event_time: 1_772_040_000_000,
      now: 1_772_000_000_000,
      edge_half_life_ms: 90_000_000,
      settlement_clarity: 0.86,
      volatility: 0.25,
    });
    const retention = ProfitRetentionEngine.evaluate({
      ticker: 'KXCPI-26JUN',
      original_edge: 0.12,
      current_edge: 0.045,
      captured_edge: 0.075,
      drawdown_from_peak: 0.08,
      settlement_clarity: 0.86,
    });

    expect(hold.hold_class).toBe('catalyst');
    expect(hold.edge_shelf_life_ms).toBeGreaterThan(0);
    expect(retention.action).toBe('trim');
  });

  it('blocks bad tickets and detects alpha intercepts', () => {
    const noTrade = NoTradeIntelligence.evaluate({
      ticker: 'KXMISC',
      net_edge: 0.01,
      spread: 0.09,
      settlement_clarity: 0.4,
      data_freshness_ms: 90_000,
      liquidity_score: 0.2,
    });
    const intercepts = AlphaInterceptEngine.detect({
      ticker: 'KXOIL',
      public_data_delta: 0.08,
      market_move: 0.01,
      orderbook_imbalance: 0.18,
      freshness_ms: 1_000,
    });

    expect(noTrade.blocked).toBe(true);
    expect(noTrade.reasons).toEqual(expect.arrayContaining(['SETTLEMENT_CLARITY_TOO_LOW', 'SPREAD_TOO_WIDE']));
    expect(intercepts).toEqual(expect.arrayContaining([
      expect.objectContaining({ signal: 'PUBLIC_DATA_MOVED_MARKET_HAS_NOT' }),
    ]));
  });
});
