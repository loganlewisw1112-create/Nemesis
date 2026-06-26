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
import {
  CommandNavRail,
  CommandRibbon,
  CommandShell,
  MetricTile,
  OperationalRail,
  PanelCard,
  RealtimeChartPanel,
  type CommandNavItem,
} from '@nemesis/ui';
import { DataFreshnessBoard } from './components/Visualizations/DataFreshnessBoard';
import { OrderbookHeatView } from './components/Visualizations/OrderbookHeatView';
import { useRealtimeSeries } from './hooks/useRealtimeSeries';

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

const NAV_ITEMS: CommandNavItem<Tab>[] = [
  { id: 'command', label: 'CMD', title: 'Command Center' },
  { id: 'sandbox', label: 'SBX', title: 'Sandbox' },
  { id: 'brain', label: 'BRN', title: 'Brain Health' },
  { id: 'replay', label: 'RLP', title: 'Replay Lab' },
];

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
    const [status, brain, db, tape, publicData, intelligence] = await Promise.all([
      window.gea.getBridgeStatus(),
      window.gea.getBrainHealth(),
      window.gea.getDbStatus(),
      window.gea.getTapeState(),
      window.gea.getPublicDataState(),
      window.gea.getIntelligenceState(),
    ]);
    setBridgeStatus(status);
    setBrainHealth(brain);
    setDbStatus(db);
    setTapeState(tape);
    setPublicDataState(publicData);
    setIntelligenceState(intelligence);
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

  const latestSnapshot = tapeState?.latestSnapshots[0] ?? null;
  const latestOrderbook = tapeState?.latestOrderbooks[0] ?? null;
  const latestTicker = latestSnapshot?.ticker ?? latestOrderbook?.ticker ?? tapeState?.trackedTickers[0] ?? 'none';
  const activeRole = brainHealth?.activeRole ?? 'standalone';
  const connected = bridgeStatus?.connected ?? false;
  const avgLatency = average(brainHealth?.instances.map((brain) => brain.latency_ms) ?? []);
  const packetRate = (brainHealth?.instances ?? []).reduce((sum, brain) => sum + brain.packet_rate, 0);
  const freshnessAgeSec = tapeState?.freshness.kalshiTapeAgeMs == null
    ? null
    : Math.round(tapeState.freshness.kalshiTapeAgeMs / 1000);

  const sampleKey = useMemo(() => [
    latestTicker,
    latestSnapshot?.timestamp ?? 0,
    latestOrderbook?.timestamp ?? 0,
    tapeState?.tradeCount ?? 0,
    intelligenceState?.tribunal.nemesis_probability ?? 0,
    intelligenceState?.edge.net_edge ?? 0,
    brainHealth?.instances.map((brain) => `${brain.id}:${brain.last_heartbeat}:${brain.latency_ms}`).join('|') ?? 'brain:none',
  ].join(':'), [brainHealth, intelligenceState, latestOrderbook, latestSnapshot, latestTicker, tapeState]);

  const liveValues = useMemo(() => ({
    probability: intelligenceState ? intelligenceState.tribunal.nemesis_probability * 100 : null,
    edge: intelligenceState ? intelligenceState.edge.net_edge * 100 : null,
    marketPrice: latestSnapshot ? latestSnapshot.yes_price * 100 : latestOrderbook?.yes_ask != null ? latestOrderbook.yes_ask * 100 : null,
    spread: latestSnapshot?.spread != null ? latestSnapshot.spread * 100 : latestOrderbook?.spread != null ? latestOrderbook.spread * 100 : null,
    confidence: intelligenceState ? intelligenceState.tribunal.model_agreement_score * 100 : null,
    latency: avgLatency,
    packets: packetRate,
    freshnessAge: freshnessAgeSec,
  }), [avgLatency, freshnessAgeSec, intelligenceState, latestOrderbook, latestSnapshot, packetRate]);

  const liveSeries = useRealtimeSeries({
    scopeKey: latestTicker,
    sampleKey,
    values: liveValues,
    maxPoints: 48,
    staleAfterMs: 7_500,
  });

  return (
    <CommandShell
      ribbon={(
        <CommandRibbon
          title="GLOBAL EVENT ALPHA"
          leftMeta={<RibbonPill tone={connected ? 'success' : 'warning'}>{connected ? 'NEMESIS CONNECTED' : 'AWAITING NEMESIS'}</RibbonPill>}
          right={(
            <>
              <span style={ribbonMetaStyle}>{nemesisState ? `${nemesisState.thesesCount} theses / ${nemesisState.marketsCount} mkts / ${nemesisState.isLive ? 'LIVE' : 'paper'}` : 'mirror pending'}</span>
              <span style={ribbonMetaStyle}>DB {dbStatus?.available ? `${dbStatus.migrationsApplied} tables` : 'optional'}</span>
              <span style={{ ...ribbonMetaStyle, color: liveSeries.stale ? 'var(--warning)' : 'var(--success)' }}>
                {liveSeries.stale ? 'visuals stale' : 'realtime visual'}
              </span>
            </>
          )}
        />
      )}
      nav={(
        <CommandNavRail
          items={NAV_ITEMS}
          activeId={tab}
          onSelect={setTab}
          footer={<RailFooter connected={connected} activeRole={activeRole} />}
        />
      )}
      rail={(
        <OperationalRail>
          <StatusRail
            bridgeStatus={bridgeStatus}
            brainHealth={brainHealth}
            dbStatus={dbStatus}
            tapeState={tapeState}
            publicDataState={publicDataState}
          />
        </OperationalRail>
      )}
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          style={mainPanelStyle}
        >
          {tab === 'command' && (
            <CommandCenterView
              connected={connected}
              nemesisState={nemesisState}
              brainHealth={brainHealth}
              tapeState={tapeState}
              publicDataState={publicDataState}
              intelligenceState={intelligenceState}
              liveSeries={liveSeries.series}
              latestTicker={latestTicker}
              liveStale={liveSeries.stale}
            />
          )}
          {tab === 'sandbox' && <SandboxView intelligenceState={intelligenceState} />}
          {tab === 'brain' && <BrainHealthView snapshot={brainHealth} />}
          {tab === 'replay' && <ReplayView intelligenceState={intelligenceState} />}
        </motion.div>
      </AnimatePresence>
    </CommandShell>
  );
}

function CommandCenterView({
  connected,
  nemesisState,
  brainHealth,
  tapeState,
  publicDataState,
  intelligenceState,
  liveSeries,
  latestTicker,
  liveStale,
}: {
  connected: boolean;
  nemesisState: NemesisStateMirror | null;
  brainHealth: BrainClusterSnapshot | null;
  tapeState: KalshiTapeState | null;
  publicDataState: PublicDataMeshState | null;
  intelligenceState: GlobalEventAlphaIntelligenceState | null;
  liveSeries: Record<string, number[]>;
  latestTicker: string;
  liveStale: boolean;
}) {
  const activeRole = brainHealth?.activeRole ?? 'standalone';
  const latestSnapshot = tapeState?.latestSnapshots[0] ?? null;
  const freshness = formatFreshness(tapeState);
  const probability = intelligenceState ? formatPct(intelligenceState.tribunal.nemesis_probability * 100) : 'pending';
  const netEdge = intelligenceState ? formatPp(intelligenceState.edge.net_edge * 100) : 'pending';
  const spread = latestSnapshot?.spread != null ? formatCents(latestSnapshot.spread * 100) : 'pending';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionHeader
        title="Institutional Command Center"
        subtitle="Prime Ticket Board / Watch Board / No-Trade Board / Catalyst Radar / Settlement Radar"
        right={<RibbonPill tone={liveStale ? 'warning' : 'success'}>{liveStale ? 'visual feed stale' : 'visual feed live'}</RibbonPill>}
      />

      <PanelCard title="KALSHI TAPE" meta={freshness}>
        <div style={metricGridStyle}>
          <MetricTile label="Snapshots" value={`${tapeState?.snapshotCount ?? 0} snapshots`} />
          <MetricTile label="Trades" value={tapeState?.tradeCount ?? 0} />
          <MetricTile label="Orderbooks" value={tapeState?.orderbookCount ?? 0} />
          <MetricTile label="Freshness" value={freshness} color={tapeState?.freshness.stale ? 'var(--warning)' : 'var(--success)'} />
          <MetricTile label="Latest" value={latestTicker} minWidth={210} />
        </div>
      </PanelCard>

      <div style={chartGridStyle}>
        <RealtimeChartPanel
          title="Alpha Pulse"
          subtitle={`${probability} / ${netEdge}`}
          values={liveSeries.probability ?? []}
          color="var(--accent)"
          height={86}
          emptyLabel="Waiting for probability samples."
          ariaLabel="Alpha Pulse probability trend"
        />
        <RealtimeChartPanel
          title="Tape Pulse"
          subtitle={spread}
          values={liveSeries.spread ?? []}
          color="var(--warning)"
          height={86}
          emptyLabel="Waiting for spread samples."
          ariaLabel="Tape Pulse spread trend"
        />
        <RealtimeChartPanel
          title="Brain Heartbeat"
          subtitle={`${Math.round(last(liveSeries.latency) ?? 0)}ms`}
          values={liveSeries.latency ?? []}
          color="var(--success)"
          height={86}
          emptyLabel="Waiting for heartbeat samples."
          ariaLabel="Brain Heartbeat latency trend"
        />
      </div>

      <PanelCard tone={connected ? 'success' : 'warning'}>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
          {connected
            ? 'Bridge online. Brain outputs are validated fail-closed before recommendation packets can reach Nemesis.'
            : 'Awaiting Nemesis bridge connection on ws://localhost:7430. Start Nemesis to establish the intelligence link.'}
        </div>
      </PanelCard>

      {nemesisState && (
        <div style={metricGridStyle}>
          <MetricTile label="Theses" value={nemesisState.thesesCount} />
          <MetricTile label="Markets" value={nemesisState.marketsCount} />
          <MetricTile label="Daily P&L" value={`$${nemesisState.dailyPnl.toFixed(2)}`} color={nemesisState.dailyPnl >= 0 ? 'var(--success)' : 'var(--danger)'} />
          <MetricTile label="Active Brain" value={activeRole} />
        </div>
      )}

      {intelligenceState && (
        <div style={intelligenceGridStyle}>
          <IntelligencePanel title="PRIME TICKET BOARD">
            <MetricLine label="Ticker" value={`Prime ${intelligenceState.edge.ticker}`} />
            <MetricLine label="Probability" value={probability} />
            <MetricLine label="Net Edge" value={netEdge} />
            <MetricLine label="Hold" value={intelligenceState.hold.hold_class} />
          </IntelligencePanel>
          <IntelligencePanel title="WATCH BOARD">
            <MetricLine label="Tracked" value={tapeState?.trackedTickers.length ?? 0} />
            <MetricLine label="Candidate" value={`Watch ${latestTicker}`} />
            <MetricLine label="Recheck" value={new Date(intelligenceState.hold.recheck_at).toLocaleTimeString()} />
          </IntelligencePanel>
          <IntelligencePanel title="SETTLEMENT RADAR">
            <MetricLine label="Source" value={intelligenceState.settlement.source} />
            <MetricLine label="Clarity" value={formatPct(intelligenceState.settlement.clarity_score * 100)} />
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
            <MetricLine label="Agreement" value={formatPct(intelligenceState.tribunal.model_agreement_score * 100)} />
            <MetricLine label="Band" value={`${formatPct(intelligenceState.tribunal.confidence_band_low * 100)}-${formatPct(intelligenceState.tribunal.confidence_band_high * 100)}`} />
          </IntelligencePanel>
          <IntelligencePanel title="EDGE CURVE">
            <MetricLine label="Entry" value={`${intelligenceState.edge.entry_zone_low.toFixed(3)}-${intelligenceState.edge.entry_zone_high.toFixed(3)}`} />
            <MetricLine label="Do Not Chase" value={intelligenceState.edge.do_not_chase_level.toFixed(3)} />
            <MetricLine label="Target Exit" value={intelligenceState.edge.target_exit.toFixed(3)} />
          </IntelligencePanel>
          <IntelligencePanel title="PROFIT RETENTION">
            <MetricLine label="Action" value={intelligenceState.retention.action} />
            <MetricLine label="Current Edge" value={formatPp(intelligenceState.retention.current_edge * 100)} />
            <MetricLine label="Captured" value={formatPp(intelligenceState.retention.captured_edge * 100)} />
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

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
        <OrderbookHeatView snapshots={tapeState?.latestOrderbooks ?? []} />
      </div>
    </div>
  );
}

function StatusRail({
  bridgeStatus,
  brainHealth,
  dbStatus,
  tapeState,
  publicDataState,
}: {
  bridgeStatus: BridgeStatus | null;
  brainHealth: BrainClusterSnapshot | null;
  dbStatus: GeaDbStatus | null;
  tapeState: KalshiTapeState | null;
  publicDataState: PublicDataMeshState | null;
}) {
  const connected = bridgeStatus?.connected ?? false;
  const freshCount = publicDataState?.freshness.filter((source) => !source.stale).length ?? 0;

  return (
    <>
      <PanelCard title="BRIDGE LINK" tone={connected ? 'success' : 'warning'}>
        <MetricLine label="Status" value={connected ? 'online' : 'awaiting'} />
        <MetricLine label="Role" value={bridgeStatus?.brainRole ?? 'none'} />
        <MetricLine label="Clients" value={bridgeStatus?.clientCount ?? 0} />
      </PanelCard>

      <PanelCard title="BRAIN CLUSTER">
        <MetricLine label="Active" value={brainHealth?.activeRole ?? 'standalone'} />
        <MetricLine label="Instances" value={brainHealth?.instances.length ?? 0} />
        <MetricLine label="Avg Latency" value={`${Math.round(average(brainHealth?.instances.map((brain) => brain.latency_ms) ?? []))}ms`} />
      </PanelCard>

      <DataFreshnessBoard state={publicDataState} />

      <PanelCard title="TAPE HEALTH" tone={tapeState?.freshness.stale ? 'warning' : 'success'}>
        <MetricLine label="Freshness" value={formatFreshness(tapeState)} />
        <MetricLine label="Tracked" value={tapeState?.trackedTickers.length ?? 0} />
        <MetricLine label="Books" value={tapeState?.orderbookCount ?? 0} />
      </PanelCard>

      <PanelCard title="LOCAL STORE" tone={dbStatus?.available ? 'success' : 'default'}>
        <MetricLine label="DB" value={dbStatus?.available ? 'available' : 'optional'} />
        <MetricLine label="Tables" value={dbStatus?.migrationsApplied ?? 0} />
        <MetricLine label="Fresh Sources" value={freshCount} />
      </PanelCard>
    </>
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
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionHeader
        title="Sandboxing Dashboard"
        subtitle="Historical Replay / Paper Trading / Strategy Lab / Execution Sim / Scenario Injection / Model Tournament"
      />
      <div style={metricGridStyle}>
        <MetricTile label="Sandbox Live Routing" value="DISABLED" color="var(--warning)" />
        <MetricTile label="Fill Price" value={fill.aborted ? 'ABORTED' : fill.fill_price.toFixed(4)} />
        <MetricTile label="Slippage" value={formatPp(fill.slippage * 100)} />
        <MetricTile label="Fees" value={`$${fill.fees.toFixed(2)}`} />
      </div>
      <PanelCard title="Execution Simulator">
        <div style={mutedTextStyle}>
          Simulated fill for {fill.qty} YES contracts on {fill.ticker}: {fill.aborted ? fill.abortReason : `average ${fill.fill_price.toFixed(4)}`}.
        </div>
      </PanelCard>
      {intelligenceState && (
        <PanelCard title="MODEL TOURNAMENT">
          <TableHeader columns={['MODEL', 'RANK', 'P&L', 'HIT RATE']} />
          {intelligenceState.tournament.results.map((result) => (
            <div key={result.model_version} style={tableRowStyle}>
              <span>{result.model_version}</span>
              <span>{result.rank}</span>
              <span>{result.metrics.pnl.toFixed(2)}</span>
              <span>{formatPct(result.metrics.hit_rate * 100)}</span>
            </div>
          ))}
        </PanelCard>
      )}
    </div>
  );
}

function BrainHealthView({ snapshot }: { snapshot: BrainClusterSnapshot | null }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionHeader
        title="Brain Cluster Health"
        subtitle="Primary / Standby A/B/C / Shadow / Replay / Emergency"
      />
      {!snapshot ? (
        <PanelCard>
          <div style={mutedTextStyle}>Waiting for brain heartbeat snapshot.</div>
        </PanelCard>
      ) : (
        <>
          <div style={metricGridStyle}>
            <MetricTile label="Active Role" value={snapshot.activeRole} />
            <MetricTile label="Instances" value={snapshot.instances.length} />
            <MetricTile label="Failovers" value={snapshot.failoverEvents.length} />
          </div>
          <PanelCard title="Live Heartbeats">
            <TableHeader columns={['ID', 'ROLE', 'STATUS', 'LATENCY', 'PACKETS']} />
            {snapshot.instances.map((brain) => (
              <div key={brain.id} style={tableRowStyle}>
                <span>{brain.id}</span>
                <span>{brain.role}</span>
                <span style={{ color: brain.status === 'HEALTHY' || brain.status === 'STANDBY_READY' || brain.status === 'PROMOTED' ? 'var(--success)' : 'var(--warning)' }}>{brain.status}</span>
                <span>{brain.latency_ms}ms</span>
                <span>{brain.packet_rate}/s</span>
              </div>
            ))}
          </PanelCard>
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
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionHeader
        title="Historical Replay Factory"
        subtitle="Point-in-time orderbook replay / 1x / 5x / 25x / 100x / Ticket autopsy / Calibration metrics"
      />
      <PanelCard title="Replay Timeline">
        <div style={mutedTextStyle}>{replayed.length} event(s) emitted in the first 5x playback window.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {['1x', '5x', '25x', '100x'].map((speed) => (
            <span key={speed} style={chipStyle}>{speed}</span>
          ))}
        </div>
      </PanelCard>
      {intelligenceState && (
        <div style={intelligenceGridStyle}>
          <IntelligencePanel title="TICKET AUTOPSY">
            <MetricLine label="Ticket" value={`Autopsy ${intelligenceState.autopsy.ticker}`} />
            <MetricLine label="Steps" value={intelligenceState.autopsy.decision_path.length} />
            <MetricLine label="Summary" value={intelligenceState.autopsy.summary} />
          </IntelligencePanel>
          <IntelligencePanel title="CALIBRATION METRICS">
            <MetricLine label="Best Model" value={intelligenceState.tournament.results[0]?.model_version ?? 'none'} />
            <MetricLine label="Brier" value={(intelligenceState.tournament.results[0]?.metrics.brier_score ?? 0).toFixed(3)} />
            <MetricLine label="Edge Capture" value={formatPct((intelligenceState.tournament.results[0]?.metrics.edge_capture ?? 0) * 100)} />
          </IntelligencePanel>
          <IntelligencePanel title="ANALYTICS EXPORT">
            <MetricLine label="JSON Bytes" value={intelligenceState.analyticsExport.json.length} />
            <MetricLine label="CSV Rows" value={intelligenceState.analyticsExport.csv.split('\n').filter(Boolean).length} />
            <MetricLine label="Replay" value={intelligenceState.tournament.replay_id} />
          </IntelligencePanel>
        </div>
      )}
    </div>
  );
}

function IntelligencePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PanelCard title={title}>
      <div style={{ display: 'grid', gap: 8 }}>{children}</div>
    </PanelCard>
  );
}

function MetricLine({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, minWidth: 0 }}>
      <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <strong style={{ textAlign: 'right', wordBreak: 'break-word' }}>{value}</strong>
    </div>
  );
}

function SectionHeader({ title, subtitle, right }: { title: string; subtitle: string; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
      <div>
        <h1 style={{ fontSize: 18, fontWeight: 800, margin: 0, marginBottom: 4 }}>{title}</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>{subtitle}</p>
      </div>
      {right}
    </div>
  );
}

function TableHeader({ columns }: { columns: string[] }) {
  return (
    <div style={tableHeaderStyle}>
      {columns.map((column) => <strong key={column}>{column}</strong>)}
    </div>
  );
}

function RailFooter({ connected, activeRole }: { connected: boolean; activeRole: string }) {
  return (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? 'var(--success)' : 'var(--warning)' }} />
      <span style={{ fontSize: 7, color: connected ? 'var(--success)' : 'var(--warning)', textAlign: 'center', lineHeight: 1.25 }}>
        {connected ? 'INTEL\nONLINE' : 'STND\nALONE'}
      </span>
      <span style={{ fontSize: 7, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.25 }}>
        {activeRole.toUpperCase()}
      </span>
    </div>
  );
}

function RibbonPill({ tone, children }: { tone: 'success' | 'warning' | 'danger' | 'accent'; children: ReactNode }) {
  return (
    <span style={{
      padding: '3px 8px',
      borderRadius: 4,
      border: `1px solid var(--${tone})`,
      color: `var(--${tone})`,
      background: tone === 'success'
        ? 'rgba(34, 197, 94, 0.1)'
        : tone === 'warning'
          ? 'rgba(245, 158, 11, 0.1)'
          : tone === 'danger'
            ? 'rgba(239, 68, 68, 0.1)'
            : 'rgba(99, 102, 241, 0.14)',
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: 1,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function formatFreshness(tapeState: KalshiTapeState | null): string {
  if (!tapeState || tapeState.freshness.kalshiTapeAgeMs == null) return 'stale';
  const seconds = Math.round(tapeState.freshness.kalshiTapeAgeMs / 1000);
  return tapeState.freshness.stale ? `${seconds}s stale` : `${seconds}s`;
}

function formatPct(value: number): string {
  return `${value.toFixed(0)}%`;
}

function formatPp(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}pp`;
}

function formatCents(value: number): string {
  return `${value.toFixed(1)}¢`;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function last(values: number[] | undefined): number | null {
  if (!values || values.length === 0) return null;
  return values[values.length - 1];
}

const mainPanelStyle: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  overflowX: 'hidden',
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
};

const ribbonMetaStyle: CSSProperties = {
  color: 'var(--text-muted)',
  whiteSpace: 'nowrap',
};

const metricGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(135px, 100%), 1fr))',
  gap: 8,
};

const chartGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
  gap: 12,
};

const intelligenceGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
  gap: 12,
};

const mutedTextStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 12,
  lineHeight: 1.6,
};

const tableHeaderStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.2fr 0.6fr 0.8fr 0.8fr',
  gap: 8,
  fontSize: 11,
  color: 'var(--text-muted)',
  marginBottom: 8,
};

const tableRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.2fr 0.6fr 0.8fr 0.8fr',
  gap: 8,
  fontSize: 12,
  padding: '8px 0',
  borderTop: '1px solid var(--border)',
};

const chipStyle: CSSProperties = {
  padding: '4px 8px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 11,
  color: 'var(--text-muted)',
};
