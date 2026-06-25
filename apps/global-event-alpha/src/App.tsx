import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { BridgeStatus, NemesisStateMirror } from '@nemesis/bridge-contracts';
import type {
  AlphaIntercept,
  BrainClusterSnapshot,
  EdgeEstimateResult,
  EventGraphResult,
  HoldEstimateResult,
  NoTradeDecision,
  ProbabilityTribunalResult,
  ProfitRetentionResult,
  SettlementRule,
} from '@nemesis/brain-core';
import type { KalshiTapeState, PublicDataMeshState } from '@nemesis/connectors';
import { ExecutionSim, ReplayEngine, type ModelTournamentResult, type TicketAutopsyResult } from '@nemesis/simulation-core';
import { DataFreshnessBoard } from './components/Visualizations/DataFreshnessBoard';
import { OrderbookHeatView } from './components/Visualizations/OrderbookHeatView';

declare global {
  interface Window {
    gea: {
      getBridgeStatus: () => Promise<BridgeStatus>;
      getBrainHealth: () => Promise<BrainClusterSnapshot>;
      getDbStatus: () => Promise<GeaDbStatus>;
      getTapeState: () => Promise<KalshiTapeState>;
      getPublicDataState: () => Promise<PublicDataMeshState>;
      getIntelligenceState: () => Promise<GlobalEventAlphaIntelligenceState>;
      onBridgeStatus: (cb: (s: BridgeStatus) => void) => void;
      onNemesisState: (cb: (s: NemesisStateMirror) => void) => void;
      onRecommendation: (cb: (p: unknown) => void) => void;
      onBrainHealth: (cb: (s: BrainClusterSnapshot) => void) => void;
      onDbStatus: (cb: (s: GeaDbStatus) => void) => void;
      onTapeUpdate: (cb: (s: KalshiTapeState) => void) => void;
      onPublicDataUpdate: (cb: (s: PublicDataMeshState) => void) => void;
      onIntelligenceUpdate: (cb: (s: GlobalEventAlphaIntelligenceState) => void) => void;
    };
  }
}

type Tab = 'command' | 'sandbox' | 'brain' | 'replay';

type GeaDbStatus = {
  available: boolean;
  path: string;
  migrationsApplied: number;
  error?: string;
};

type GlobalEventAlphaIntelligenceState = {
  settlement: SettlementRule;
  eventGraph: EventGraphResult;
  tribunal: ProbabilityTribunalResult;
  edge: EdgeEstimateResult;
  hold: HoldEstimateResult;
  retention: ProfitRetentionResult;
  noTrade: NoTradeDecision;
  intercepts: AlphaIntercept[];
  autopsy: TicketAutopsyResult;
  tournament: ModelTournamentResult;
  analyticsExport: {
    json: string;
    csv: string;
  };
};

const TAB_LABELS: Record<Tab, string> = {
  command: 'CMD',
  sandbox: 'SBX',
  brain: 'BRN',
  replay: 'RLP',
};

const TAB_TITLES: Record<Tab, string> = {
  command: 'Command Center',
  sandbox: 'Sandbox',
  brain: 'Brain Health',
  replay: 'Replay Lab',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('command');
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus | null>(null);
  const [nemesisState, setNemesisState] = useState<NemesisStateMirror | null>(null);
  const [brainHealth, setBrainHealth] = useState<BrainClusterSnapshot | null>(null);
  const [dbStatus, setDbStatus] = useState<GeaDbStatus | null>(null);
  const [tapeState, setTapeState] = useState<KalshiTapeState | null>(null);
  const [publicDataState, setPublicDataState] = useState<PublicDataMeshState | null>(null);
  const [intelligenceState, setIntelligenceState] = useState<GlobalEventAlphaIntelligenceState | null>(null);

  const initBridge = useCallback(async () => {
    if (!window.gea) return;
    const status = await window.gea.getBridgeStatus();
    setBridgeStatus(status);
    setBrainHealth(await window.gea.getBrainHealth());
    setDbStatus(await window.gea.getDbStatus());
    setTapeState(await window.gea.getTapeState());
    setPublicDataState(await window.gea.getPublicDataState());
    setIntelligenceState(await window.gea.getIntelligenceState());
  }, []);

  useEffect(() => {
    void initBridge();
  }, [initBridge]);

  useEffect(() => {
    if (!window.gea) return;
    window.gea.onBridgeStatus((s) => setBridgeStatus(s));
    window.gea.onNemesisState((s) => setNemesisState(s));
    window.gea.onBrainHealth((s) => setBrainHealth(s));
    window.gea.onDbStatus((s) => setDbStatus(s));
    window.gea.onTapeUpdate((s) => setTapeState(s));
    window.gea.onPublicDataUpdate((s) => setPublicDataState(s));
    window.gea.onIntelligenceUpdate((s) => setIntelligenceState(s));
  }, []);

  const isOnline = bridgeStatus?.connected ?? false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'monospace' }}>
      <div style={{
        padding: '8px 16px',
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: 2, color: 'var(--accent)' }}>
          GLOBAL EVENT ALPHA
        </span>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 11 }}>
          {nemesisState && (
            <span style={{ color: 'var(--text-muted)' }}>
              {nemesisState.thesesCount} theses / {nemesisState.marketsCount} mkts
              {nemesisState.isLive ? ' / LIVE' : ' / paper'}
            </span>
          )}
          {dbStatus && (
            <span style={{ color: dbStatus.available ? 'var(--success)' : 'var(--text-muted)' }}>
              DB {dbStatus.available ? `${dbStatus.migrationsApplied} tables` : 'optional'}
            </span>
          )}
          <BridgeBadge connected={isOnline} />
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <nav style={{
          width: 56,
          background: 'var(--bg-elevated)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: 8,
        }}>
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              title={TAB_TITLES[t]}
              style={{
                background: 'transparent',
                border: 'none',
                color: tab === t ? '#fff' : 'var(--text-muted)',
                padding: 8,
                borderRadius: 6,
                fontSize: 10,
                cursor: 'pointer',
                textTransform: 'uppercase',
                position: 'relative',
                transition: 'color 0.2s',
              }}
            >
              {tab === t && (
                <motion.span
                  layoutId="gea-nav-pill"
                  style={{ position: 'absolute', inset: 0, background: 'var(--accent)', borderRadius: 6, zIndex: -1 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                />
              )}
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>

        <main style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              style={{ flex: 1, padding: 24 }}
            >
              {tab === 'command' && <CommandCenterView connected={isOnline} nemesisState={nemesisState} brainHealth={brainHealth} tapeState={tapeState} publicDataState={publicDataState} intelligenceState={intelligenceState} />}
              {tab === 'sandbox' && <SandboxView intelligenceState={intelligenceState} />}
              {tab === 'brain' && <BrainHealthView snapshot={brainHealth} />}
              {tab === 'replay' && <ReplayView intelligenceState={intelligenceState} />}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

function BridgeBadge({ connected }: { connected: boolean }) {
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 1,
      background: connected ? 'rgba(74, 222, 128, 0.1)' : 'rgba(251, 191, 36, 0.1)',
      color: connected ? 'var(--success)' : '#fbbf24',
      border: `1px solid ${connected ? 'var(--success)' : '#fbbf24'}`,
    }}>
      {connected ? 'NEMESIS CONNECTED' : 'AWAITING NEMESIS'}
    </span>
  );
}

function PlaceholderCard({ children }: { children: ReactNode }) {
  return (
    <div style={{
      padding: 20,
      border: '1px solid var(--border)',
      borderRadius: 8,
      fontSize: 12,
      color: 'var(--text-muted)',
      lineHeight: 1.6,
    }}>
      {children}
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, marginBottom: 4 }}>{title}</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>{subtitle}</p>
    </div>
  );
}

function CommandCenterView({
  connected,
  nemesisState,
  brainHealth,
  tapeState,
  publicDataState,
  intelligenceState,
}: {
  connected: boolean;
  nemesisState: NemesisStateMirror | null;
  brainHealth: BrainClusterSnapshot | null;
  tapeState: KalshiTapeState | null;
  publicDataState: PublicDataMeshState | null;
  intelligenceState: GlobalEventAlphaIntelligenceState | null;
}) {
  const activeRole = brainHealth?.activeRole ?? 'standalone';
  const latestTicker = tapeState?.latestSnapshots[0]?.ticker ?? tapeState?.trackedTickers[0] ?? 'none';
  const freshness = tapeState?.freshness.kalshiTapeAgeMs == null
    ? 'stale'
    : tapeState.freshness.stale
      ? `${Math.round(tapeState.freshness.kalshiTapeAgeMs / 1000)}s stale`
      : `${Math.round(tapeState.freshness.kalshiTapeAgeMs / 1000)}s`;
  return (
    <div>
      <SectionHeader
        title="Institutional Command Center"
        subtitle="Prime Ticket Board / Watch Board / No-Trade Board / Catalyst Radar / Settlement Radar"
      />
      <div style={{ marginBottom: 12 }}>
        <h2 style={panelTitleStyle}>KALSHI TAPE</h2>
        <div style={gridStyle}>
          <MetricTile label="SNAPSHOTS" value={`${tapeState?.snapshotCount ?? 0} snapshots`} />
          <MetricTile label="TRADES" value={tapeState?.tradeCount ?? 0} />
          <MetricTile label="ORDERBOOKS" value={tapeState?.orderbookCount ?? 0} />
          <MetricTile label="FRESHNESS" value={freshness} />
          <MetricTile label="LATEST" value={latestTicker} />
        </div>
      </div>
      {nemesisState && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'THESES', value: nemesisState.thesesCount },
            { label: 'MARKETS', value: nemesisState.marketsCount },
            { label: 'DAILY P&L', value: `$${nemesisState.dailyPnl.toFixed(2)}` },
            { label: 'ACTIVE BRAIN', value: activeRole },
          ].map(({ label, value }) => (
            <MetricTile key={label} label={label} value={value} />
          ))}
        </div>
      )}
      <PlaceholderCard>
        {connected
          ? 'Bridge online. Brain outputs are validated fail-closed before recommendation packets can reach Nemesis.'
          : 'Awaiting Nemesis bridge connection on ws://localhost:7430. Start Nemesis to establish the intelligence link.'}
      </PlaceholderCard>
      {intelligenceState && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginTop: 16 }}>
          <IntelligencePanel title="PRIME TICKET BOARD">
            <MetricLine label="Ticker" value={`Prime ${intelligenceState.edge.ticker}`} />
            <MetricLine label="Probability" value={`${(intelligenceState.tribunal.nemesis_probability * 100).toFixed(1)}%`} />
            <MetricLine label="Net Edge" value={`${(intelligenceState.edge.net_edge * 100).toFixed(2)}pp`} />
            <MetricLine label="Hold" value={intelligenceState.hold.hold_class} />
          </IntelligencePanel>
          <IntelligencePanel title="WATCH BOARD">
            <MetricLine label="Tracked" value={tapeState?.trackedTickers.length ?? 0} />
            <MetricLine label="Candidate" value={`Watch ${latestTicker}`} />
            <MetricLine label="Recheck" value={new Date(intelligenceState.hold.recheck_at).toLocaleTimeString()} />
          </IntelligencePanel>
          <IntelligencePanel title="SETTLEMENT RADAR">
            <MetricLine label="Source" value={intelligenceState.settlement.source} />
            <MetricLine label="Clarity" value={`${(intelligenceState.settlement.clarity_score * 100).toFixed(0)}%`} />
            <MetricLine label="Gate" value={intelligenceState.settlement.gate_passed ? 'PASS' : 'BLOCK'} />
          </IntelligencePanel>
          <IntelligencePanel title="CATALYST RADAR">
            <MetricLine label="Releases" value={publicDataState?.releases.length ?? 0} />
            <MetricLine label="Fresh Sources" value={publicDataState?.freshness.filter((source) => !source.stale).length ?? 0} />
            <MetricLine label="Lead Source" value={`Lead ${publicDataState?.sources[0]?.name ?? intelligenceState.settlement.source}`} />
          </IntelligencePanel>
          <IntelligencePanel title="EVENT GRAPH">
            <MetricLine label="Nodes" value={intelligenceState.eventGraph.nodes.length} />
            <MetricLine label="Edges" value={intelligenceState.eventGraph.edges.length} />
            <MetricLine label="Primary Relation" value={intelligenceState.eventGraph.edges[0]?.relation ?? 'none'} />
          </IntelligencePanel>
          <IntelligencePanel title="PROBABILITY TRIBUNAL">
            <MetricLine label="Judges" value={intelligenceState.tribunal.judges.length} />
            <MetricLine label="Agreement" value={`${(intelligenceState.tribunal.model_agreement_score * 100).toFixed(0)}%`} />
            <MetricLine label="Band" value={`${(intelligenceState.tribunal.confidence_band_low * 100).toFixed(0)}-${(intelligenceState.tribunal.confidence_band_high * 100).toFixed(0)}%`} />
          </IntelligencePanel>
          <IntelligencePanel title="EDGE CURVE">
            <MetricLine label="Entry" value={`${intelligenceState.edge.entry_zone_low.toFixed(3)}-${intelligenceState.edge.entry_zone_high.toFixed(3)}`} />
            <MetricLine label="Do Not Chase" value={intelligenceState.edge.do_not_chase_level.toFixed(3)} />
            <MetricLine label="Target Exit" value={intelligenceState.edge.target_exit.toFixed(3)} />
          </IntelligencePanel>
          <IntelligencePanel title="PROFIT RETENTION">
            <MetricLine label="Action" value={intelligenceState.retention.action} />
            <MetricLine label="Current Edge" value={`${(intelligenceState.retention.current_edge * 100).toFixed(2)}pp`} />
            <MetricLine label="Captured" value={`${(intelligenceState.retention.captured_edge * 100).toFixed(2)}pp`} />
          </IntelligencePanel>
          <IntelligencePanel title="NO-TRADE BOARD">
            <MetricLine label="Status" value={intelligenceState.noTrade.blocked ? 'BLOCKED' : 'CLEAR'} />
            <MetricLine label="Reasons" value={intelligenceState.noTrade.reasons.length === 0 ? 'none' : intelligenceState.noTrade.reasons.join(', ')} />
          </IntelligencePanel>
          <IntelligencePanel title="ALPHA INTERCEPT">
            <MetricLine label="Signals" value={intelligenceState.intercepts.length} />
            <MetricLine label="Lead Signal" value={intelligenceState.intercepts[0]?.signal ?? 'none'} />
          </IntelligencePanel>
          <IntelligencePanel title="P&L">
            <MetricLine label="Daily" value={`$${(nemesisState?.dailyPnl ?? 0).toFixed(2)}`} />
            <MetricLine label="Paper Cash" value={`$${(nemesisState?.paperCash ?? 0).toFixed(2)}`} />
            <MetricLine label="Paper Equity" value={`$${(nemesisState?.paperEquity ?? 0).toFixed(2)}`} />
          </IntelligencePanel>
          <IntelligencePanel title="BRAIN HEALTH">
            <MetricLine label="Active" value={activeRole} />
            <MetricLine label="Instances" value={brainHealth?.instances.length ?? 0} />
            <MetricLine label="Failovers" value={brainHealth?.failoverEvents.length ?? 0} />
          </IntelligencePanel>
          <IntelligencePanel title="AUDIT TRAIL">
            <MetricLine label="Bridge" value={connected ? 'online' : 'degraded'} />
            <MetricLine label="DB" value={publicDataState ? 'state mirrored' : 'awaiting state'} />
            <MetricLine label="Validation" value="fail-closed" />
          </IntelligencePanel>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(320px, 0.65fr)', gap: 16, marginTop: 16 }}>
        <OrderbookHeatView snapshots={tapeState?.latestOrderbooks ?? []} />
        <DataFreshnessBoard state={publicDataState} />
      </div>
    </div>
  );
}

function IntelligencePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={panelStyle}>
      <h2 style={panelTitleStyle}>{title}</h2>
      <div style={{ display: 'grid', gap: 8 }}>{children}</div>
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <strong style={{ textAlign: 'right' }}>{value}</strong>
    </div>
  );
}

function SandboxView({ intelligenceState }: { intelligenceState: GlobalEventAlphaIntelligenceState | null }) {
  const fill = useMemo(() => ExecutionSim.simulateFill({
    ticker: 'KXDEMO-26',
    side: 'yes',
    qty: 8,
    book: {
      ticker: 'KXDEMO-26',
      yes: [{ price: 0.42, quantity: 5 }, { price: 0.45, quantity: 10 }],
      no: [{ price: 0.55, quantity: 10 }],
      spread: 0.03,
    },
  }), []);

  return (
    <div>
      <SectionHeader
        title="Sandboxing Dashboard"
        subtitle="Historical Replay / Paper Trading / Strategy Lab / Execution Sim / Scenario Injection / Model Tournament"
      />
      <div style={gridStyle}>
        <MetricTile label="SANDBOX LIVE ROUTING" value="DISABLED" />
        <MetricTile label="FILL PRICE" value={fill.aborted ? 'ABORTED' : fill.fill_price.toFixed(4)} />
        <MetricTile label="SLIPPAGE" value={`${(fill.slippage * 100).toFixed(2)}pp`} />
        <MetricTile label="FEES" value={`$${fill.fees.toFixed(2)}`} />
      </div>
      <div style={{ ...panelStyle, marginTop: 16 }}>
        <h2 style={panelTitleStyle}>Execution Simulator</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Simulated fill for {fill.qty} YES contracts on {fill.ticker}: {fill.aborted ? fill.abortReason : `average ${fill.fill_price.toFixed(4)}`}.
        </div>
      </div>
      {intelligenceState && (
        <div style={{ ...panelStyle, marginTop: 16 }}>
          <h2 style={panelTitleStyle}>MODEL TOURNAMENT</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.5fr 0.75fr 0.75fr', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            <strong>MODEL</strong>
            <strong>RANK</strong>
            <strong>P&L</strong>
            <strong>HIT RATE</strong>
          </div>
          {intelligenceState.tournament.results.map((result) => (
            <div key={result.model_version} style={{ display: 'grid', gridTemplateColumns: '1fr 0.5fr 0.75fr 0.75fr', gap: 8, fontSize: 12, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <span>{result.model_version}</span>
              <span>{result.rank}</span>
              <span>{result.metrics.pnl.toFixed(2)}</span>
              <span>{(result.metrics.hit_rate * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BrainHealthView({ snapshot }: { snapshot: BrainClusterSnapshot | null }) {
  return (
    <div>
      <SectionHeader
        title="Brain Cluster Health"
        subtitle="Primary / Standby A/B/C / Shadow / Replay / Emergency"
      />
      {!snapshot ? (
        <PlaceholderCard>Waiting for brain heartbeat snapshot.</PlaceholderCard>
      ) : (
        <>
          <div style={gridStyle}>
            <MetricTile label="ACTIVE ROLE" value={snapshot.activeRole} />
            <MetricTile label="INSTANCES" value={snapshot.instances.length} />
            <MetricTile label="FAILOVERS" value={snapshot.failoverEvents.length} />
          </div>
          <div style={{ ...panelStyle, marginTop: 16 }}>
            <h2 style={panelTitleStyle}>Live Heartbeats</h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr 1fr', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
              <strong>ID</strong>
              <strong>ROLE</strong>
              <strong>STATUS</strong>
              <strong>LATENCY</strong>
              <strong>PACKETS</strong>
            </div>
            {snapshot.instances.map((brain) => (
              <div key={brain.id} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr 1fr', gap: 8, fontSize: 12, padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <span>{brain.id}</span>
                <span>{brain.role}</span>
                <span style={{ color: brain.status === 'HEALTHY' || brain.status === 'STANDBY_READY' || brain.status === 'PROMOTED' ? 'var(--success)' : 'var(--warning)' }}>{brain.status}</span>
                <span>{brain.latency_ms}ms</span>
                <span>{brain.packet_rate}/s</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReplayView({ intelligenceState }: { intelligenceState: GlobalEventAlphaIntelligenceState | null }) {
  const replayed = useMemo(() => {
    const engine = new ReplayEngine([
      { id: 'snapshot-open', timestamp: 100, type: 'snapshot', payload: { price: 0.42 } },
      { id: 'trade-print', timestamp: 250, type: 'trade', payload: { price: 0.44 } },
      { id: 'decision', timestamp: 400, type: 'decision', payload: { action: 'watch' } },
    ]);
    engine.seek(0);
    return engine.step(5, 100);
  }, []);

  return (
    <div>
      <SectionHeader
        title="Historical Replay Factory"
        subtitle="Point-in-time orderbook replay / 1x / 5x / 25x / 100x / Ticket autopsy / Calibration metrics"
      />
      <div style={panelStyle}>
        <h2 style={panelTitleStyle}>Replay Timeline</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {replayed.length} event(s) emitted in the first 5x playback window.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {['1x', '5x', '25x', '100x'].map((speed) => (
            <span key={speed} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11 }}>
              {speed}
            </span>
          ))}
        </div>
      </div>
      {intelligenceState && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
          <div style={panelStyle}>
            <h2 style={panelTitleStyle}>TICKET AUTOPSY</h2>
            <MetricLine label="Ticket" value={`Autopsy ${intelligenceState.autopsy.ticker}`} />
            <MetricLine label="Steps" value={intelligenceState.autopsy.decision_path.length} />
            <MetricLine label="Summary" value={intelligenceState.autopsy.summary} />
          </div>
          <div style={panelStyle}>
            <h2 style={panelTitleStyle}>CALIBRATION METRICS</h2>
            <MetricLine label="Best Model" value={intelligenceState.tournament.results[0]?.model_version ?? 'none'} />
            <MetricLine label="Brier" value={(intelligenceState.tournament.results[0]?.metrics.brier_score ?? 0).toFixed(3)} />
            <MetricLine label="Edge Capture" value={`${((intelligenceState.tournament.results[0]?.metrics.edge_capture ?? 0) * 100).toFixed(0)}%`} />
          </div>
          <div style={panelStyle}>
            <h2 style={panelTitleStyle}>ANALYTICS EXPORT</h2>
            <MetricLine label="JSON Bytes" value={intelligenceState.analyticsExport.json.length} />
            <MetricLine label="CSV Rows" value={intelligenceState.analyticsExport.csv.split('\n').filter(Boolean).length} />
            <MetricLine label="Replay" value={intelligenceState.tournament.replay_id} />
          </div>
        </div>
      )}
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{
      padding: '10px 16px',
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      minWidth: 120,
    }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

const gridStyle: CSSProperties = { display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap' };
const panelStyle: CSSProperties = { padding: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8 };
const panelTitleStyle: CSSProperties = { fontSize: 13, margin: 0, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 };
