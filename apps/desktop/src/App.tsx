import { useCallback, useEffect, useState, lazy, Suspense } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const WorldPage = lazy(() => import('./WorldPage').then((m) => ({ default: m.WorldPage })));
import { useNotifications, NotificationPanel, type NemesisNotification } from './Notifications';
import {
  GuardrailBanner,
  ThesisCardView,
  GuardrailCockpit,
  ExplainMovePanel,
  RegimeBanner,
  TicketLiveCharts,
  PaperDeskPanel,
  ProfitStationPanel,
  RiskCockpit,
  ReadinessQuiz,
  LiveUnlockWizard,
  DiscoveryCockpitPanel,
} from '@nemesis/ui';
import type {
  AutoCloseDecision,
  AutoCloseSettings,
  AutoCloseState,
  GuardrailSettings,
  ThesisCard,
  GateStatus,
  ConnectorHealth,
  KalshiMarket,
  PaperPortfolio,
  PaperOrder,
  PriceTick,
  DiscoveryState,
  ExecutableTier,
  LiveUnlockEvaluation,
} from '@nemesis/core';
import { DEFAULT_AUTO_CLOSE_SETTINGS } from '@nemesis/core';
import type { FeedHubTradeFeedState } from '@nemesis/connectors';

interface AppState {
  settings: GuardrailSettings;
  theses: ThesisCard[];
  gates: GateStatus[];
  connectors: ConnectorHealth[];
  tradeFeed?: FeedHubTradeFeedState;
  credentialStatus?: KalshiCredentialStatus;
  journalCount: number;
  reviewOnly: boolean;
  canLive: boolean;
  liveUnlock?: LiveUnlockEvaluation;
  activeRegimes?: string[];
  dailyPnl?: number;
  humanQuizPassed?: boolean;
  backtestPassed?: boolean;
  shutdown?: {
    consecutiveInvalidations: number;
    abnormalExecutions: number;
    manualOverrides: number;
    apiDegradedMinutes: number;
  };
}

interface PaperState {
  portfolio: PaperPortfolio;
  marks: Record<string, number>;
  equity: number;
  unrealized: number;
  equityHistory: { t: number; equity: number; deployed: number; cash: number }[];
  workingOrders?: PaperOrder[];
  dailyPnl?: number;
  activeRegimes?: string[];
  autoCloseStateByPosition?: Record<string, AutoCloseState>;
  autoCloseDecisions?: AutoCloseDecision[];
  profitabilityBenchmark?: unknown;
}

interface KalshiCredentialStatus {
  apiKeyId: string | null;
  hasPrivateKey: boolean;
  privateKeyStorage: 'env' | 'electron-safeStorage' | 'none';
  encryptionAvailable: boolean;
  updatedAt: number | null;
}

declare global {
  interface Window {
    nemesis: {
      getState: () => Promise<AppState>;
      getMarkets: () => Promise<KalshiMarket[]>;
      updateSettings: (p: Partial<GuardrailSettings>) => Promise<{ ok: boolean; error?: string }>;
      getKalshiCredentialStatus: () => Promise<KalshiCredentialStatus>;
      saveKalshiCredentials: (input: { kalshiApiKeyId?: string; privateKeyPem?: string }) => Promise<{ ok: boolean; error?: string; status?: KalshiCredentialStatus }>;
      clearKalshiCredentials: () => Promise<{ ok: boolean; status: KalshiCredentialStatus }>;
      journalAdd: (id: string, notes?: string) => Promise<unknown>;
      journalExport: () => Promise<string>;
      dryRun: (id: string) => Promise<{ aborted: boolean; abortReason?: string; fillPrice?: number; slippage?: number }>;
      passQuiz: () => Promise<boolean>;
      passBacktest: () => Promise<{ passed: boolean; detail: string }>;
      unlockLive: (confirmText: string) => Promise<{ ok: boolean; error?: string }>;
      exportSession: () => Promise<unknown>;
      quarantinePlaybook: (p: string) => Promise<string[]>;
      reconcileLive: () => Promise<{ ok: boolean; mismatches: unknown[] }>;
      killSwitch: () => Promise<GuardrailSettings>;
      refresh: () => Promise<void>;
      liveBuy: (id: string, contracts?: number, limitPrice?: number) => Promise<{ ok: boolean; orderId?: string; error?: string }>;
      paperBuy: (id: string, contracts?: number) => Promise<{ ok: boolean; error?: string; abortReason?: string; fill?: { fillPrice: number; filled: number; slippage: number } }>;
      paperClose: (id: string, contracts?: number) => Promise<{ ok: boolean; error?: string; pnl?: number }>;
      paperPreview: (id: string, contracts?: number) => Promise<{ aborted: boolean; abortReason?: string; fillPrice?: number; slippage?: number }>;
      paperPlaceLimit: (id: string, contracts: number, limitPrice: number) => Promise<{ ok: boolean; error?: string }>;
      paperCancelOrder: (orderId: string) => Promise<{ ok: boolean }>;
      getPaperPortfolio: () => Promise<PaperState>;
      resetPaper: (startingCash?: number) => Promise<PaperPortfolio>;
      getTickHistory: (ticker: string) => Promise<PriceTick[]>;
      watchTicker: (ticker: string | null) => Promise<boolean>;
      getDiscoveryState: () => Promise<DiscoveryState>;
      updateDiscoverySettings: (p: Partial<DiscoveryState['settings']>) => Promise<{ ok: boolean; state: DiscoveryState }>;
      pauseDiscovery: () => Promise<DiscoveryState>;
      resumeDiscovery: () => Promise<DiscoveryState>;
      forceUniverseRefresh: () => Promise<DiscoveryState>;
      forceDepthPass: () => Promise<DiscoveryState>;
      onSettingsUpdate: (cb: (s: GuardrailSettings) => void) => void;
      onMarketsUpdate: (cb: (d: { theses: ThesisCard[]; markets: KalshiMarket[]; offline?: boolean; connectors?: ConnectorHealth[]; tradeFeed?: FeedHubTradeFeedState; discovery?: DiscoveryState; gates?: GateStatus[] }) => void) => void;
      onPaperUpdate: (cb: (d: PaperState) => void) => void;
      onTicksUpdate: (cb: (d: { ticker: string; ticks: PriceTick[] }) => void) => void;
      onDiscoveryUpdate: (cb: (d: DiscoveryState) => void) => void;
      openWidget: (type: 'pnl' | 'risk' | 'ticker' | 'gates' | 'scout' | 'world') => Promise<{ ok: boolean }>;
      closeThisWidget: () => Promise<void>;
      getWorldEvents: () => Promise<unknown>;
      onWorldEventsUpdate: (cb: (d: unknown) => void) => void;
      getBridgeStatus: () => Promise<{ connected: boolean; brainRole: string | null; lastSeenAt: number | null; clientCount: number }>;
      onBridgeStatus: (cb: (s: { connected: boolean; brainRole: string | null; lastSeenAt: number | null; clientCount: number }) => void) => void;
      onBridgeRecommendation: (cb: (p: unknown) => void) => void;
      onConnectorsUpdate: (cb: (d: ConnectorHealth[]) => void) => void;
    };
  }
}

type Tab = 'theater' | 'paper' | 'markets' | 'journal' | 'profit' | 'settings' | 'world';

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>('theater');
  const [selected, setSelected] = useState<ThesisCard | null>(null);
  const [markets, setMarkets] = useState<KalshiMarket[]>([]);
  const [dryRunResult, setDryRunResult] = useState<string | null>(null);
  const [paperResult, setPaperResult] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [ticks, setTicks] = useState<PriceTick[]>([]);
  const [backtestResult, setBacktestResult] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reconcileResult, setReconcileResult] = useState<string | null>(null);
  const [quarantinePlaybook, setQuarantinePlaybook] = useState('flow-hunter');
  const [frozenPlaybooks, setFrozenPlaybooks] = useState<string[]>([]);
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);
  const [settingsSubTab, setSettingsSubTab] = useState<'guardrails' | 'discovery'>('guardrails');
  const [apiKeyId, setApiKeyId] = useState('');
  const [apiPrivateKey, setApiPrivateKey] = useState('');
  const [paperCashInput, setPaperCashInput] = useState('1000');
  const [bridgeConnected, setBridgeConnected] = useState(false);

  const loadPaper = useCallback(async () => {
    if (!window.nemesis) return;
    const p = await window.nemesis.getPaperPortfolio();
    setPaper(p);
  }, []);

  const load = useCallback(async () => {
    if (!window.nemesis) {
      setLoadError('NEMESIS bridge unavailable — restart the desktop app.');
      return;
    }
    try {
      const s = await window.nemesis.getState();
      setState(s);
      const m = await window.nemesis.getMarkets();
      setMarkets(m);
      const d = await window.nemesis.getDiscoveryState();
      setDiscovery(d);
      await loadPaper();
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load NEMESIS state');
    }
  }, [loadPaper]);

  // Initial load — runs once on mount (load is stable via useCallback)
  useEffect(() => {
    if (!window.nemesis) {
      setLoadError('NEMESIS bridge unavailable — restart the desktop app.');
      return;
    }
    load();
    window.nemesis.getBridgeStatus().then((s) => setBridgeConnected(s.connected)).catch(() => {});
    window.nemesis.onBridgeStatus((s) => setBridgeConnected(s.connected));
    const bridgePoll = setInterval(() => {
      window.nemesis.getBridgeStatus().then((s) => setBridgeConnected(s.connected)).catch(() => {});
    }, 1_000);
    return () => clearInterval(bridgePoll);
  }, [load]);

  // IPC subscriptions — re-registers when selected ticker changes so the
  // onTicksUpdate closure captures the latest ticker value. Safe because
  // preload uses removeAllListeners before each on(), so no accumulation.
  useEffect(() => {
    if (!window.nemesis) return;
    window.nemesis.onMarketsUpdate((d) => {
      setState((prev) => (prev ? {
        ...prev,
        theses: d.theses,
        connectors: d.connectors ?? prev.connectors,
        tradeFeed: d.tradeFeed ?? prev.tradeFeed,
        gates: d.gates ?? prev.gates,
      } : prev));
      setMarkets(d.markets);
      if (d.discovery) setDiscovery(d.discovery);
    });
    window.nemesis.onConnectorsUpdate((connectors) => {
      setState((prev) => prev ? { ...prev, connectors } : prev);
    });
    window.nemesis.onDiscoveryUpdate((d) => setDiscovery(d as DiscoveryState));
    window.nemesis.onSettingsUpdate((s) => {
      setState((prev) => prev ? { ...prev, settings: s } : prev);
    });
    window.nemesis.onPaperUpdate((d) => {
      setPaper(d as PaperState);
      setState((prev) => prev ? { ...prev, activeRegimes: (d as PaperState).activeRegimes, dailyPnl: (d as PaperState).dailyPnl } : prev);
    });
    window.nemesis.onTicksUpdate((d) => {
      if (selected?.ticker === d.ticker) setTicks(d.ticks);
    });
  }, [selected?.ticker]);

  useEffect(() => {
    if (!window.nemesis) return;
    if (!selected) {
      window.nemesis.watchTicker(null);
      setTicks([]);
      return;
    }
    window.nemesis.watchTicker(selected.ticker);
    window.nemesis.getTickHistory(selected.ticker).then(setTicks);
  }, [selected]);

  // Must be above early returns to satisfy Rules of Hooks
  const { notes, dismiss } = useNotifications(state?.theses ?? [], paper);

  // Warm up AudioContext on first interaction so notification sounds always play
  useEffect(() => {
    const unlock = () => { try { new AudioContext().resume(); } catch { /* noop */ } };
    window.addEventListener('click', unlock, { once: true });
    return () => window.removeEventListener('click', unlock);
  }, []);

  if (loadError) {
    return (
      <div style={{ padding: 24, color: 'var(--danger)' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>NEMESIS failed to load</div>
        <div style={{ color: 'var(--text-muted)', marginBottom: 16 }}>{loadError}</div>
        <button type="button" onClick={() => { setLoadError(null); void load(); }} style={{ padding: '8px 14px' }}>
          Retry
        </button>
      </div>
    );
  }

  if (!state) return <div style={{ padding: 20, color: '#8b93a7' }}>Loading NEMESIS...</div>;

  const filtered = state.theses.filter((t) => {
    if (filter === 'scout' || filter === 'solid' || filter === 'whale') {
      const tier = t.executableTier;
      if (!tier) return false;
      const order: Record<ExecutableTier, number> = { whale: 3, solid: 2, scout: 1 };
      return order[tier] >= order[filter as ExecutableTier];
    }
    if (filter === 'all') return true;
    if (filter === 'tradeable') return t.status === 'tradeable' || t.status === 'qualified' || t.status === 'watch-only';
    return t.playbook === filter || t.status === filter;
  });
  const tierCounts = {
    scout: state.theses.filter((t) => t.executableTier === 'scout' || t.executableTier === 'solid' || t.executableTier === 'whale').length,
    solid: state.theses.filter((t) => t.executableTier === 'solid' || t.executableTier === 'whale').length,
    whale: state.theses.filter((t) => t.executableTier === 'whale').length,
  };
  const tradableCount = state.theses.filter((t) => t.status === 'tradeable' || t.status === 'qualified' || t.status === 'watch-only').length;
  const openPosition = paper?.portfolio.positions.find(
    (p) => selected && p.ticker === selected.ticker && p.side === selected.side,
  );
  const regimes = paper?.activeRegimes ?? state.activeRegimes ?? [];
  const dailyPnl = paper?.dailyPnl ?? state.dailyPnl ?? 0;
  const deployed = paper?.portfolio.positions.reduce((s, p) => s + p.entryPrice * p.contracts, 0) ?? 0;
  const heatPct = paper && paper.equity > 0 ? (deployed / paper.equity) * 100 : 0;
  const tradeFeed = state.tradeFeed;
  const tradeFeedRetrySeconds = tradeFeed?.nextRetryAt
    ? Math.max(0, Math.ceil((tradeFeed.nextRetryAt - Date.now()) / 1000))
    : null;
  const credentialStatus = state.credentialStatus;

  function handleNotifAction(n: NemesisNotification) {
    if (n.positionId) {
      void window.nemesis.paperClose(n.positionId).then(loadPaper);
    } else if (n.thesisId && state) {
      setTab('theater');
      const card = state.theses.find((c) => c.id === n.thesisId);
      if (card) setSelected(card);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <NotificationPanel notes={notes} onDismiss={dismiss} onAction={handleNotifAction} />
      <GuardrailBanner settings={state.settings} />
      <RegimeBanner regimes={regimes} />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <nav style={{ width: 56, background: 'var(--bg-elevated)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 4, padding: 8 }}>
          {(['theater', 'paper', 'markets', 'journal', 'profit', 'settings', 'world'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
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
                  layoutId="nav-pill"
                  style={{ position: 'absolute', inset: 0, background: 'var(--accent)', borderRadius: 6, zIndex: -1 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                />
              )}
              {t.slice(0, 3)}
            </button>
          ))}
          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: bridgeConnected ? 'var(--success)' : '#fbbf24' }} />
            <span style={{ fontSize: 7, color: bridgeConnected ? 'var(--success)' : '#fbbf24', letterSpacing: 0.5, textAlign: 'center', lineHeight: 1.3 }}>
              {bridgeConnected ? 'INTEL\nONLINE' : 'STND\nALONE'}
            </span>
          </div>
        </nav>

        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          style={{ flex: 1, overflow: tab === 'world' ? 'hidden' : 'auto', padding: tab === 'world' ? 0 : 16, display: 'flex', flexDirection: 'column' }}
        >
          {tab === 'theater' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <h1 style={{ fontSize: 18, fontWeight: 700 }}>Edge Theater</h1>
                    <button type="button" title="Pop out Scout widget" onClick={() => window.nemesis.openWidget('scout')} style={popoutStyle}>⧉</button>
                    <button type="button" title="Pop out P&L widget" onClick={() => window.nemesis.openWidget('pnl')} style={popoutStyle}>⧉ P&L</button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {tierCounts.scout} scout · {tierCounts.solid} solid · {tierCounts.whale} whale · {state.theses.length} total
                    {state.reviewOnly ? ' · review-only mode' : ''}
                  </div>
                  {discovery && (
                    <button type="button" onClick={() => { setTab('settings'); setSettingsSubTab('discovery'); }} style={{ fontSize: 11, marginTop: 4, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>
                      Manage discovery →
                    </button>
                  )}
                  {tradeFeed?.status === 'degraded' && (
                    <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6, maxWidth: 520 }}>
                      Kalshi trade tape degraded. Using cached trade prints{tradeFeedRetrySeconds !== null ? `; retry in ${tradeFeedRetrySeconds}s` : ''}. Other theses remain available.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {['all', 'scout', 'solid', 'whale', 'tradeable', 'flow-hunter', 'weather-wing', 'crypto-lead', 'global-pulse'].map((f) => (
                    <button key={f} type="button" onClick={() => setFilter(f)} style={chipStyle(filter === f)}>
                      {f}{f === 'tradeable' ? ` (${tradableCount})` : f === 'scout' ? ` (${tierCounts.scout})` : f === 'solid' ? ` (${tierCounts.solid})` : f === 'whale' ? ` (${tierCounts.whale})` : ''}
                    </button>
                  ))}
                  <button type="button" onClick={() => window.nemesis.refresh()} style={chipStyle(false)}>Refresh</button>
                </div>
              </div>
              {filtered.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                  {discovery && discovery.metrics.scoutCount === 0
                    ? `Scanning universe — ${discovery.metrics.trackedTickers} markets, ${discovery.metrics.depthPending} depth checks queued.`
                    : 'No tickets match this filter. Try "all" or click Refresh.'}
                  {discovery && discovery.metrics.scoutCount === 0 && (
                    <button type="button" onClick={() => { setTab('settings'); setSettingsSubTab('discovery'); }} style={{ display: 'block', marginTop: 8, fontSize: 11, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0 }}>
                      Open Discovery Cockpit →
                    </button>
                  )}
                </div>
              )}
              {dryRunResult && (
                <div style={{ background: 'var(--bg-card)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
                  {dryRunResult}
                </div>
              )}
              {liveResult && (
                <div style={{ background: 'var(--bg-card)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12, color: liveResult.includes('failed') || liveResult.includes('error') ? 'var(--danger)' : 'var(--success)' }}>
                  {liveResult}
                </div>
              )}
              {paperResult && (
                <div style={{ background: 'var(--bg-card)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12, color: paperResult.toLowerCase().includes('fail') || paperResult.toLowerCase().includes('error') || paperResult.toLowerCase().includes('abort') ? 'var(--danger)' : 'var(--success)' }}>
                  {paperResult}
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
                <AnimatePresence>
                {filtered.map((card) => (
                  <motion.div
                    key={card.id}
                    initial={{ opacity: 0, y: 14, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.16 }}
                  >
                  <ThesisCardView
                    card={card}
                    selected={selected?.id === card.id}
                    onSelect={() => setSelected(card)}
                    showLiveBuy={state.settings.liveEnabled && !state.settings.killSwitchActive}
                    showPaperBuy={true}
                    onJournal={async () => {
                      await window.nemesis.journalAdd(card.id);
                      load();
                    }}
                    onDryRun={async () => {
                      const r = await window.nemesis.dryRun(card.id);
                      setDryRunResult(r.aborted
                        ? `Dry-run aborted: ${r.abortReason}`
                        : `Dry-run fill @ ${((r.fillPrice ?? 0) * 100).toFixed(1)}¢ slippage ${((r.slippage ?? 0) * 100).toFixed(2)}¢`);
                    }}
                    onLiveBuy={async () => {
                      const r = await window.nemesis.liveBuy(card.id);
                      if (r.ok) {
                        setLiveResult(`Live order placed on ${card.ticker}${r.orderId ? ` (#${r.orderId})` : ''}`);
                      } else {
                        setLiveResult(`Live buy failed: ${r.error ?? 'unknown'}`);
                      }
                    }}
                    onPaperBuy={async () => {
                      const r = await window.nemesis.paperBuy(card.id);
                      if (r.ok) {
                        setPaperResult(`Paper buy filled on ${card.ticker}${r.fill ? ` @ ${((r.fill.fillPrice ?? 0) * 100).toFixed(1)}¢` : ''}`);
                        setSelected(card);
                        loadPaper();
                      } else {
                        setPaperResult(`Paper buy failed: ${r.error ?? r.abortReason ?? 'unknown'}`);
                      }
                    }}
                  />
                  </motion.div>
                ))}
                </AnimatePresence>
              </div>
            </>
          )}

          {tab === 'paper' && paper && (
            <>
              <h1 style={{ fontSize: 18, marginBottom: 12 }}>Paper Command Desk</h1>
              <PaperDeskPanel
                portfolio={paper.portfolio}
                marks={paper.marks}
                equity={paper.equity}
                unrealized={paper.unrealized}
                workingOrders={paper.workingOrders}
                dailyPnl={dailyPnl}
                dailyLossCap={state.settings.dailyLossCapUsd}
                autoCloseSettings={state.settings.autoClose ?? DEFAULT_AUTO_CLOSE_SETTINGS}
                autoCloseStateByPosition={paper.autoCloseStateByPosition}
                autoCloseDecisions={paper.autoCloseDecisions}
                selectedTicker={selected?.ticker ?? null}
                onPreview={selected ? async (qty) => {
                  const r = await window.nemesis.paperPreview(selected.id, qty);
                  setPaperResult(r.aborted
                    ? `Preview aborted: ${r.abortReason}`
                    : `Preview fill @ ${((r.fillPrice ?? 0) * 100).toFixed(1)}¢ · slip ${((r.slippage ?? 0) * 100).toFixed(2)}¢`);
                } : undefined}
                onPlaceLimit={selected ? async (qty, price) => {
                  const r = await window.nemesis.paperPlaceLimit(selected.id, qty, price);
                  setPaperResult(r.ok ? `Limit order placed` : `Limit failed: ${r.error}`);
                  loadPaper();
                } : undefined}
                onCancelOrder={async (orderId) => {
                  await window.nemesis.paperCancelOrder(orderId);
                  loadPaper();
                }}
                onClose={async (id, contracts) => {
                  const r = await window.nemesis.paperClose(id, contracts);
                  if (r.ok) setPaperResult(`Closed position — P&L $${(r.pnl ?? 0).toFixed(2)}`);
                  else setPaperResult(`Close failed: ${r.error}`);
                  loadPaper();
                }}
                onReset={async () => {
                  await window.nemesis.resetPaper();
                  setPaperResult('Paper wallet reset to $1,000');
                  loadPaper();
                }}
              />
            </>
          )}

          {tab === 'markets' && (
            <>
              <h1 style={{ fontSize: 18, marginBottom: 12 }}>Kalshi Markets</h1>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={thStyle}>Ticker</th>
                    <th style={thStyle}>Title</th>
                    <th style={thStyle}>Category</th>
                    <th style={thStyle}>YES</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((m) => (
                    <tr key={m.ticker} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={tdStyle}>{m.ticker}</td>
                      <td style={tdStyle}>{m.title}</td>
                      <td style={tdStyle}>{m.category ?? '—'}</td>
                      <td style={tdStyle}>{m.yes_ask ?? m.yes_bid ?? '—'}¢</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {tab === 'journal' && (
            <>
              <h1 style={{ fontSize: 18, marginBottom: 12 }}>Session Journal</h1>
              <div style={{ marginBottom: 12, fontSize: 13 }}>
                Progress: <strong>{state.journalCount}</strong> / 100 signals (gate 5)
              </div>
              <div style={{ height: 8, background: 'var(--bg-card)', borderRadius: 4, marginBottom: 16 }}>
                <div style={{ width: `${Math.min(100, state.journalCount)}%`, height: '100%', background: 'var(--accent)', borderRadius: 4 }} />
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={async () => {
                    const csv = await window.nemesis.journalExport();
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'nemesis-journal.csv';
                    a.click();
                  }}
                  style={chipStyle(false)}
                >
                  Export journal CSV
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const blob = new Blob([JSON.stringify(await window.nemesis.exportSession(), null, 2)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = 'nemesis-session-export.json';
                    a.click();
                  }}
                  style={chipStyle(false)}
                >
                  Export session bundle
                </button>
              </div>
            </>
          )}

          {tab === 'profit' && paper && (
            <ProfitStationPanel
              portfolio={paper.portfolio}
              equity={paper.equity}
              unrealized={paper.unrealized}
              equityHistory={paper.equityHistory}
              autoCloseDecisions={paper.autoCloseDecisions}
            />
          )}

          {tab === 'settings' && (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button type="button" onClick={() => setSettingsSubTab('guardrails')} style={chipStyle(settingsSubTab === 'guardrails')}>Guardrails</button>
                <button type="button" onClick={() => setSettingsSubTab('discovery')} style={chipStyle(settingsSubTab === 'discovery')}>Discovery</button>
              </div>
              {settingsSubTab === 'discovery' && discovery && (
                <DiscoveryCockpitPanel
                  state={discovery}
                  onPreset={(preset) => window.nemesis.updateDiscoverySettings({ preset }).then((r) => setDiscovery(r.state))}
                  onToggle={(key, value) => window.nemesis.updateDiscoverySettings({ [key]: value }).then((r) => setDiscovery(r.state))}
                  onPause={() => window.nemesis.pauseDiscovery().then(setDiscovery)}
                  onResume={() => window.nemesis.resumeDiscovery().then(setDiscovery)}
                  onForceUniverse={() => window.nemesis.forceUniverseRefresh().then(setDiscovery)}
                  onForceDepth={() => window.nemesis.forceDepthPass().then(setDiscovery)}
                />
              )}
              {settingsSubTab === 'guardrails' && (
              <>
              <h1 style={{ fontSize: 18, marginBottom: 12 }}>Settings</h1>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 400 }}>

                {/* Trading mode toggles */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={() => window.nemesis.updateSettings({ demoMode: !state.settings.demoMode }).then(load)}
                    style={{ ...chipStyle(state.settings.demoMode), flex: 1 }}
                  >
                    Demo mode: {state.settings.demoMode ? 'ON' : 'OFF'}
                  </button>
                  <button
                    type="button"
                    onClick={() => window.nemesis.updateSettings({ dryRun: !state.settings.dryRun }).then(load)}
                    style={{ ...chipStyle(state.settings.dryRun), flex: 1 }}
                  >
                    Dry-run: {state.settings.dryRun ? 'ON' : 'OFF'}
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={async () => {
                      const r = await window.nemesis.updateSettings({ liveEnabled: !state.settings.liveEnabled });
                      if (!r.ok) { alert(r.error); return; }
                      load();
                    }}
                    style={{ ...chipStyle(state.settings.liveEnabled), flex: 1, color: state.settings.liveEnabled ? 'var(--danger)' : undefined, borderColor: state.settings.liveEnabled ? 'var(--danger)' : undefined }}
                  >
                    Live trading: {state.settings.liveEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>
                {(() => {
                  const autoClose: AutoCloseSettings = state.settings.autoClose ?? DEFAULT_AUTO_CLOSE_SETTINGS;
                  return (
                    <div style={{ padding: '10px 12px', background: 'var(--bg)', borderRadius: 8 }}>
                      <button
                        type="button"
                        onClick={() => window.nemesis.updateSettings({ autoClose: { ...autoClose, enabled: !autoClose.enabled } }).then(load)}
                        style={{ ...chipStyle(autoClose.enabled), width: '100%', marginBottom: 6 }}
                      >
                        Paper auto-close: {autoClose.enabled ? 'ON' : 'OFF'}
                      </button>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        Trim +{(autoClose.firstTrimProfitPct * 100).toFixed(0)}% after {(autoClose.firstTrimGivebackPct * 100).toFixed(0)}% giveback · Close +{(autoClose.finalCloseProfitPct * 100).toFixed(0)}% after {(autoClose.finalCloseGivebackPct * 100).toFixed(0)}% giveback · Min {Math.round(autoClose.minAgeMs / 1000)}s/{autoClose.minTicks} ticks
                      </div>
                    </div>
                  );
                })()}
                <label style={labelStyle}>
                  Max position ($)
                  <input
                    type="number"
                    value={state.settings.maxPositionUsd}
                    onChange={(e) => window.nemesis.updateSettings({ maxPositionUsd: Number(e.target.value) }).then(load)}
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Daily loss cap ($)
                  <input
                    type="number"
                    value={state.settings.dailyLossCapUsd}
                    onChange={(e) => window.nemesis.updateSettings({ dailyLossCapUsd: Number(e.target.value) }).then(load)}
                    style={inputStyle}
                  />
                </label>
                <label style={labelStyle}>
                  Max slippage (pp)
                  <input
                    type="number"
                    step={0.01}
                    value={state.settings.maxSlippagePp}
                    onChange={(e) => window.nemesis.updateSettings({ maxSlippagePp: Number(e.target.value) }).then(load)}
                    style={inputStyle}
                  />
                </label>
                {/* Kalshi API credentials */}
                <div style={{ marginTop: 4, padding: '10px 12px', background: 'var(--bg)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Kalshi Live Trading Credentials</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    Status: {credentialStatus?.apiKeyId ? `key ${credentialStatus.apiKeyId.slice(0, 8)}…` : 'no key ID'} · private key {credentialStatus?.hasPrivateKey ? `set via ${credentialStatus.privateKeyStorage}` : 'not set'}
                  </div>
                  <label style={labelStyle}>
                    API Key ID
                    <input
                      type="text"
                      placeholder={credentialStatus?.apiKeyId ? `Current: ${credentialStatus.apiKeyId.slice(0, 8)}…` : 'Paste your Kalshi API Key ID'}
                      value={apiKeyId}
                      onChange={(e) => setApiKeyId(e.target.value)}
                      style={inputStyle}
                    />
                  </label>
                  <label style={labelStyle}>
                    Private Key (PEM)
                    <textarea
                      placeholder={credentialStatus?.hasPrivateKey ? '(private key already set — paste new to replace)' : '-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----'}
                      value={apiPrivateKey}
                      onChange={(e) => setApiPrivateKey(e.target.value)}
                      rows={4}
                      style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10, resize: 'vertical' }}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!apiKeyId && !apiPrivateKey}
                    onClick={async () => {
                      const r = await window.nemesis.saveKalshiCredentials({
                        kalshiApiKeyId: apiKeyId.trim() || undefined,
                        privateKeyPem: apiPrivateKey.trim() || undefined,
                      });
                      if (!r.ok) { alert(r.error); return; }
                      setApiKeyId('');
                      setApiPrivateKey('');
                      load();
                    }}
                    style={chipStyle(false)}
                  >
                    Save credentials
                  </button>
                  <button
                    type="button"
                    disabled={!credentialStatus?.apiKeyId && !credentialStatus?.hasPrivateKey}
                    onClick={async () => {
                      await window.nemesis.clearKalshiCredentials();
                      setApiKeyId('');
                      setApiPrivateKey('');
                      load();
                    }}
                    style={chipStyle(false)}
                  >
                    Clear stored credentials
                  </button>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    Private keys are encrypted with Electron safeStorage before local persistence. If safeStorage is unavailable, use NEMESIS_KALSHI_PRIVATE_KEY for the session.
                  </div>
                </div>

                {/* Paper wallet */}
                <div style={{ marginTop: 4, padding: '10px 12px', background: 'var(--bg)', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>Paper Wallet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Current balance: <span style={{ color: 'var(--text)', fontWeight: 600 }}>${paper?.portfolio.cash.toFixed(2) ?? '—'}</span>
                  </div>
                  <label style={labelStyle}>
                    Reset with starting cash ($)
                    <input
                      type="number"
                      min={1}
                      step={100}
                      value={paperCashInput}
                      onChange={(e) => setPaperCashInput(e.target.value)}
                      style={inputStyle}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      const cash = Math.max(1, Number(paperCashInput) || 1000);
                      await window.nemesis.resetPaper(cash);
                      await loadPaper();
                    }}
                    style={chipStyle(false)}
                  >
                    Reset paper wallet
                  </button>
                </div>

                {backtestResult && (
                  <div style={{ fontSize: 12, color: backtestResult.includes('passed') || backtestResult.includes('Avg net') ? 'var(--success)' : 'var(--text-muted)' }}>
                    {backtestResult}
                  </div>
                )}
                <button
                  type="button"
                  onClick={async () => {
                    const r = await window.nemesis.passBacktest();
                    setBacktestResult(r.detail);
                    load();
                  }}
                  style={chipStyle(false)}
                >
                  Run fee-aware backtest (gate 4)
                </button>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label style={labelStyle}>
                    Quarantine playbook
                    <select
                      value={quarantinePlaybook}
                      onChange={(e) => setQuarantinePlaybook(e.target.value)}
                      style={inputStyle}
                    >
                      {['flow-hunter', 'weather-wing', 'macro-pulse', 'crypto-lead', 'global-pulse', 'infra-watch', 'sports-live'].map((p) => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      const frozen = await window.nemesis.quarantinePlaybook(quarantinePlaybook);
                      setFrozenPlaybooks(frozen);
                    }}
                    style={chipStyle(false)}
                  >
                    Evaluate quarantine
                  </button>
                  {frozenPlaybooks.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--warning)' }}>
                      Frozen: {frozenPlaybooks.join(', ')}
                    </div>
                  )}
                </div>
                {state.settings.liveEnabled && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      onClick={async () => {
                        const r = await window.nemesis.reconcileLive();
                        setReconcileResult(
                          r.ok
                            ? 'Live book reconciled — no mismatches'
                            : `${r.mismatches.length} mismatch(es) found`,
                        );
                      }}
                      style={chipStyle(false)}
                    >
                      Reconcile live book
                    </button>
                    {reconcileResult && (
                      <div style={{ fontSize: 12, marginTop: 6, color: reconcileResult.includes('no mismatches') ? 'var(--success)' : 'var(--warning)' }}>
                        {reconcileResult}
                      </div>
                    )}
                  </div>
                )}
                <ReadinessQuiz
                  alreadyPassed={state.humanQuizPassed}
                  onPass={() => window.nemesis.passQuiz().then(load)}
                />
                <LiveUnlockWizard
                  gates={state.gates}
                  canLive={state.canLive}
                  liveUnlock={state.liveUnlock}
                  onUnlock={(text) => window.nemesis.unlockLive(text).then((r) => { load(); return r; })}
                />
                <button type="button" onClick={() => window.nemesis.killSwitch().then(load)} style={{ ...chipStyle(false), color: 'var(--danger)' }}>
                  Kill Switch (Ctrl+Shift+K)
                </button>
                {state.shutdown && (
                  <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-muted)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text)' }}>Session shutdown counters</div>
                    <div>Invalidations: {state.shutdown.consecutiveInvalidations} · Abnormal exec: {state.shutdown.abnormalExecutions}</div>
                    <div>Manual overrides: {state.shutdown.manualOverrides} · API degraded min: {state.shutdown.apiDegradedMinutes}</div>
                  </div>
                )}
              </div>
              <div style={{ marginTop: 20 }}>
                <h2 style={{ fontSize: 14, marginBottom: 8 }}>Connector Health</h2>
                {state.connectors.map((c) => {
                  const idle = c.status === 'warn' && c.lastSuccess === null && c.lastError === null;
                  const displayStatus = idle ? 'idle' : c.status;
                  const dotColor = c.status === 'ok' ? 'var(--success)' : c.status === 'error' ? 'var(--danger)' : idle ? '#555' : 'var(--warning)';
                  return (
                    <div key={c.id} style={{ fontSize: 11, marginBottom: 4 }}>
                      <span style={{ color: dotColor }}>●</span>{' '}
                      {c.name} — {displayStatus}
                      {c.latencyMs != null ? ` (${c.latencyMs}ms)` : ''}
                      {c.lastError ? ` — ${c.lastError.slice(0, 40)}` : ''}
                    </div>
                  );
                })}
              </div>
              </>
              )}
            </>
          )}
          {tab === 'world' && (
            <Suspense fallback={<div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>Loading map…</div>}>
              <WorldPage />
            </Suspense>
          )}
        </motion.div>
        </AnimatePresence>
        </main>

        <aside style={{ width: 280, borderLeft: '1px solid var(--border)', background: 'var(--bg-elevated)', overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '4px 8px', gap: 4 }}>
            <button type="button" title="Pop out Gate Status widget" onClick={() => window.nemesis.openWidget('gates')} style={popoutStyle}>⧉ Gates</button>
            <button type="button" title="Pop out Risk Cockpit widget" onClick={() => window.nemesis.openWidget('risk')} style={popoutStyle}>⧉ Risk</button>
            {selected && <button type="button" title="Pop out Live Ticker widget" onClick={() => window.nemesis.openWidget('ticker')} style={popoutStyle}>⧉ Ticker</button>}
          </div>
          <GuardrailCockpit gates={state.gates} />
          {paper && (
            <RiskCockpit
              deployedPct={heatPct}
              dailyPnl={dailyPnl}
              dailyLossCap={state.settings.dailyLossCapUsd}
              concentrationWarnings={[]}
              playbookDrawdowns={[]}
            />
          )}
          {selected && (
            <TicketLiveCharts
              ticker={selected.ticker}
              ticks={ticks}
              position={openPosition}
            />
          )}
          <ExplainMovePanel card={selected} />
        </aside>
      </div>
    </div>
  );
}

const popoutStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  fontSize: 10,
  padding: '2px 6px',
  borderRadius: 4,
  cursor: 'pointer',
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  background: active ? 'var(--accent)' : 'var(--bg-card)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: '4px 10px',
  borderRadius: 6,
  fontSize: 11,
  cursor: 'pointer',
});

const thStyle: React.CSSProperties = { padding: '8px 4px' };
const tdStyle: React.CSSProperties = { padding: '8px 4px' };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 };
const inputStyle: React.CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)', padding: 8, borderRadius: 6 };
