import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import type { BridgeStatus } from '@nemesis/bridge-contracts';
import type { BrainClusterSnapshot } from '@nemesis/brain-core';

const bridgeStatus: BridgeStatus = {
  connected: true,
  brainRole: 'primary',
  lastSeenAt: Date.now(),
  clientCount: 1,
  lastInboundAt: Date.now(),
  lastOutboundAt: Date.now(),
  lastPongAt: Date.now(),
  lastSequenceIn: 1,
  lastSequenceOut: 1,
  reconnects: 0,
  disconnects: 0,
  failovers: 0,
  tapeFreshnessMs: 0,
};

const brainHealth: BrainClusterSnapshot = {
  activeRole: 'primary',
  instances: [
    {
      id: 'brain-primary',
      role: 'primary',
      status: 'HEALTHY',
      model_version: 'alpha-v1',
      started_at: Date.now(),
      last_heartbeat: Date.now(),
      missed_heartbeats: 0,
      packet_rate: 1,
      error_rate: 0,
      latency_ms: 1,
    },
    {
      id: 'brain-standby-a',
      role: 'standby-a',
      status: 'STANDBY_READY',
      model_version: 'alpha-v1',
      started_at: Date.now(),
      last_heartbeat: Date.now(),
      missed_heartbeats: 0,
      packet_rate: 0,
      error_rate: 0,
      latency_ms: 1,
    },
  ],
  failoverEvents: [],
};

beforeEach(() => {
  window.gea = {
    getBridgeStatus: vi.fn().mockResolvedValue(bridgeStatus),
    getBrainHealth: vi.fn().mockResolvedValue(brainHealth),
    getDbStatus: vi.fn().mockResolvedValue({ available: false, path: 'local.sqlite', migrationsApplied: 0 }),
    getTapeState: vi.fn().mockResolvedValue({
      snapshotCount: 2,
      tradeCount: 1,
      orderbookCount: 1,
      trackedTickers: ['KXPHASE4-26'],
      latestSnapshots: [
        {
          id: 'snapshot-1',
          ticker: 'KXPHASE4-26',
          yes_bid: 0.41,
          yes_ask: 0.44,
          yes_price: 0.44,
          volume: 100,
          spread: 0.03,
          timestamp: Date.now(),
          source: 'rest-market',
        },
      ],
      latestOrderbooks: [
        {
          id: 'book-1',
          ticker: 'KXPHASE4-26',
          yes_levels_json: JSON.stringify([{ price: 0.41, quantity: 10 }]),
          no_levels_json: JSON.stringify([{ price: 0.55, quantity: 8 }]),
          best_yes_bid: 0.41,
          yes_ask: 0.45,
          no_ask: 0.59,
          spread: 0.04,
          timestamp: Date.now(),
          observed_at: Date.now(),
          exchange_timestamp: null,
          exchange_sequence: null,
        },
      ],
      latestTrades: [],
      freshness: { kalshiTapeAgeMs: 500, stale: false },
    }),
    getPublicDataState: vi.fn().mockResolvedValue({
      sources: [
        {
          id: 'sec-edgar',
          name: 'SEC EDGAR RSS',
          category: 'filings',
          trust_tier: 1,
          stale_after_ms: 300000,
          last_success: Date.now(),
          last_error: null,
        },
        {
          id: 'eia',
          name: 'EIA Energy',
          category: 'energy',
          trust_tier: 1,
          stale_after_ms: 600000,
          last_success: Date.now(),
          last_error: null,
        },
      ],
      observations: [
        {
          id: 'obs-1',
          source_id: 'eia',
          key: 'PET.RWTC.D',
          value: 82.41,
          unit: 'dollars per barrel',
          timestamp: Date.now(),
          observed_at: Date.now(),
          metadata_json: '{}',
        },
      ],
      releases: [],
      freshness: [
        { source_id: 'sec-edgar', name: 'SEC EDGAR RSS', trust_tier: 1, age_ms: 1200, stale_after_ms: 300000, stale: false },
        { source_id: 'eia', name: 'EIA Energy', trust_tier: 1, age_ms: 800, stale_after_ms: 600000, stale: false },
      ],
    }),
    getIntelligenceState: vi.fn().mockResolvedValue({
      settlement: {
        ticker: 'KXPHASE4-26',
        source: 'Kalshi settlement rules',
        clarity_score: 0.82,
        gate_passed: true,
        rule_text: 'Official settlement rule detected',
      },
      eventGraph: {
        nodes: [
          { id: 'market:KXPHASE4-26', type: 'market', label: 'KXPHASE4-26' },
          { id: 'event:KXPHASE4-26', type: 'event', label: 'Market event' },
        ],
        edges: [{ id: 'edge-1', from: 'market:KXPHASE4-26', to: 'event:KXPHASE4-26', relation: 'tracks' }],
      },
      tribunal: {
        ticker: 'KXPHASE4-26',
        nemesis_probability: 0.57,
        confidence_band_low: 0.51,
        confidence_band_high: 0.63,
        model_agreement_score: 0.78,
        judges: [],
      },
      edge: {
        ticker: 'KXPHASE4-26',
        raw_edge: 0.13,
        net_edge: 0.08,
        entry_zone_low: 0.41,
        entry_zone_high: 0.47,
        do_not_chase_level: 0.52,
        target_exit: 0.62,
      },
      hold: {
        ticker: 'KXPHASE4-26',
        hold_class: 'intraday',
        hold_window_ms: 3600000,
        edge_shelf_life_ms: 1800000,
        recheck_at: Date.now() + 600000,
      },
      retention: {
        ticker: 'KXPHASE4-26',
        action: 'trim',
        current_edge: 0.04,
        captured_edge: 0.07,
        reason: 'Captured most edge',
      },
      noTrade: {
        ticker: 'KXPHASE4-26',
        blocked: false,
        reasons: [],
        what_would_need_to_change: 'No block',
        recheck_at: Date.now() + 600000,
      },
      intercepts: [{ ticker: 'KXPHASE4-26', signal: 'PUBLIC_DATA_MOVED_MARKET_HAS_NOT', strength: 0.7, reason: 'Public data moved first' }],
      autopsy: {
        ticker: 'KXPHASE4-26',
        decision_path: [{ timestamp: Date.now(), event_type: 'decision', summary: 'Watch' }],
        summary: '1 decision events reviewed',
      },
      tournament: {
        replay_id: 'demo',
        results: [{ model_version: 'alpha-v1', rank: 1, metrics: { brier_score: 0.1, hit_rate: 1, pnl: 12, edge_capture: 0.8, blocked_ticket_accuracy: 1 } }],
      },
      analyticsExport: { json: '{}', csv: 'ticker,pnl\nKXPHASE4-26,12' },
    }),
    onBridgeStatus: vi.fn(),
    onNemesisState: vi.fn(),
    onRecommendation: vi.fn(),
    onBrainHealth: vi.fn(),
    onDbStatus: vi.fn(),
    onTapeUpdate: vi.fn(),
    onPublicDataUpdate: vi.fn(),
    onIntelligenceUpdate: vi.fn(),
  };
});

describe('Global Event Alpha shell', () => {
  it('renders the NEMESIS-style shell with command ribbon and operational rail', async () => {
    render(<App />);

    expect(await screen.findByText('GEA COMMAND RIBBON')).toBeTruthy();
    expect(await screen.findByText('OPERATIONAL RAIL')).toBeTruthy();
    expect(await screen.findByText('BRIDGE LINK')).toBeTruthy();
    expect(await screen.findByText('BRAIN CLUSTER')).toBeTruthy();
  });

  it('keeps the operational rail visible while navigating tabs', async () => {
    render(<App />);

    fireEvent.click(screen.getByTitle('Replay Lab'));

    expect(await screen.findByText('Historical Replay Factory')).toBeTruthy();
    expect(screen.getByText('OPERATIONAL RAIL')).toBeTruthy();
    expect(screen.getByText('DATA FRESHNESS')).toBeTruthy();
  });

  it('renders realtime alpha, tape, and brain charts in the command center', async () => {
    render(<App />);

    expect(await screen.findByLabelText('Alpha Pulse probability trend')).toBeTruthy();
    expect(await screen.findByLabelText('Tape Pulse spread trend')).toBeTruthy();
    expect(await screen.findByLabelText('Brain Heartbeat latency trend')).toBeTruthy();
  });

  it('renders live brain health rows', async () => {
    render(<App />);

    fireEvent.click(screen.getByTitle('Brain Health'));

    expect(await screen.findByText('brain-primary')).toBeTruthy();
    expect(await screen.findByText('HEALTHY')).toBeTruthy();
    expect(await screen.findByText('STANDBY_READY')).toBeTruthy();
  });

  it('renders sandbox execution simulator output', async () => {
    render(<App />);

    fireEvent.click(screen.getByTitle('Sandbox'));

    expect(await screen.findByText(/Execution Simulator/i)).toBeTruthy();
    expect(await screen.findByText(/Simulated fill/i)).toBeTruthy();
  });

  it('renders Kalshi tape state in the command center', async () => {
    render(<App />);

    expect(await screen.findByText('KALSHI TAPE')).toBeTruthy();
    expect(await screen.findByText('2 snapshots')).toBeTruthy();
    expect(await screen.findAllByText('KXPHASE4-26')).toHaveLength(2);
  });

  it('renders public data freshness in the command center', async () => {
    render(<App />);

    expect(await screen.findByText('DATA FRESHNESS')).toBeTruthy();
    expect(await screen.findByText('SEC EDGAR RSS')).toBeTruthy();
    expect(await screen.findByText('EIA Energy')).toBeTruthy();
  });

  it('renders institutional command center intelligence sections', async () => {
    render(<App />);

    expect(await screen.findByText('PRIME TICKET BOARD')).toBeTruthy();
    expect(await screen.findByText('WATCH BOARD')).toBeTruthy();
    expect(await screen.findByText('SETTLEMENT RADAR')).toBeTruthy();
    expect(await screen.findByText('CATALYST RADAR')).toBeTruthy();
    expect(await screen.findByText('EVENT GRAPH')).toBeTruthy();
    expect(await screen.findByText('PROBABILITY TRIBUNAL')).toBeTruthy();
    expect(await screen.findByText('NO-TRADE BOARD')).toBeTruthy();
    expect(await screen.findByText('ALPHA INTERCEPT')).toBeTruthy();
    expect(await screen.findByText('P&L')).toBeTruthy();
    expect(await screen.findByText('BRAIN HEALTH')).toBeTruthy();
    expect(await screen.findByText('AUDIT TRAIL')).toBeTruthy();
  });

  it('renders replay autopsy and model tournament surfaces', async () => {
    render(<App />);

    fireEvent.click(screen.getByTitle('Replay Lab'));
    expect(await screen.findByText('TICKET AUTOPSY')).toBeTruthy();
    expect(await screen.findByText('CALIBRATION METRICS')).toBeTruthy();
    expect(await screen.findByText('ANALYTICS EXPORT')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Sandbox'));
    expect(await screen.findByText('MODEL TOURNAMENT')).toBeTruthy();
  });
});
