import { useCallback, useEffect, useMemo, useRef, useState, lazy, memo, Suspense } from 'react';
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
import type { PaperQualificationSnapshot } from '@nemesis/execution/paperQualification';
import type { StrategyValidationSnapshot } from '@nemesis/execution/strategyValidation';

interface PilotValidationSnapshot {
  completedPositionCount: number;
  realizedPnlUsd: number;
  profitFactor: number;
  winRate: number;
  stressedNetPnlUsd: number;
  maxDrawdownUsd: number;
  falseExitRate: number;
  averageRegretUsd: number;
  lossBudgetRemainingUsd: number;
  passed: boolean;
}

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
  paperQualification?: PaperQualificationSnapshot | null;
  strategyValidation?: StrategyValidationSnapshot | null;
  pilotValidation?: PilotValidationSnapshot | null;
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
  paperQualification?: PaperQualificationSnapshot | null;
  strategyValidation?: StrategyValidationSnapshot | null;
  pilotValidation?: PilotValidationSnapshot | null;
}

interface StateEnvelopeV2<T> {
  schemaVersion: 2;
  stream: string;
  revision: number;
  generatedAt: number;
  full?: T[];
  upserts?: T[];
  removals?: string[];
}

type MarketStateStreamItem =
  | { key: string; kind: 'market'; value: KalshiMarket }
  | { key: string; kind: 'thesis'; value: ThesisCard };
type EquityHistoryPoint = PaperState['equityHistory'][number];
type PaperUpdate = Omit<PaperState, 'equityHistory'> & { equityHistory?: EquityHistoryPoint[] };

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
      resetPaper: (confirmation: string) => Promise<{
        ok: boolean;
        error?: string;
        archivePath?: string;
        newRunId?: string;
        portfolio?: PaperPortfolio;
      }>;
      advanceStrategyStage: (stage: 'pilot' | 'qualification', confirmation: string) => Promise<{
        ok: boolean;
        error?: string;
        strategyValidation?: StrategyValidationSnapshot | null;
        pilotValidation?: PilotValidationSnapshot | null;
      }>;
      getTickHistory: (ticker: string) => Promise<PriceTick[]>;
      watchTicker: (ticker: string | null) => Promise<boolean>;
      getDiscoveryState: () => Promise<DiscoveryState>;
      updateDiscoverySettings: (p: Partial<DiscoveryState['settings']>) => Promise<{ ok: boolean; state: DiscoveryState }>;
      pauseDiscovery: () => Promise<DiscoveryState>;
      resumeDiscovery: () => Promise<DiscoveryState>;
      forceUniverseRefresh: () => Promise<DiscoveryState>;
      forceDepthPass: () => Promise<DiscoveryState>;
      onSettingsUpdate: (cb: (s: GuardrailSettings) => void) => () => void;
      onMarketsUpdate: (cb: (d: { theses?: ThesisCard[]; markets?: KalshiMarket[]; offline?: boolean; connectors?: ConnectorHealth[]; tradeFeed?: FeedHubTradeFeedState; discovery?: DiscoveryState; gates?: GateStatus[] }) => void) => () => void;
      onMarketsStateV2: (cb: (d: StateEnvelopeV2<MarketStateStreamItem>) => void) => () => void;
      onPaperUpdate: (cb: (d: PaperUpdate) => void) => () => void;
      onEquityHistoryStateV2: (cb: (d: StateEnvelopeV2<EquityHistoryPoint>) => void) => () => void;
      onTicksUpdate: (cb: (d: { ticker: string; ticks: PriceTick[] }) => void) => () => void;
      onDiscoveryUpdate: (cb: (d: DiscoveryState) => void) => () => void;
      openWidget: (type: 'pnl' | 'risk' | 'ticker' | 'gates' | 'scout' | 'world') => Promise<{ ok: boolean }>;
      closeThisWidget: () => Promise<void>;
      getWorldEvents: () => Promise<unknown>;
      onWorldEventsUpdate: (cb: (d: unknown) => void) => () => void;
      getBridgeStatus: () => Promise<{ connected: boolean; brainRole: string | null; lastSeenAt: number | null; clientCount: number }>;
      onBridgeStatus: (cb: (s: { connected: boolean; brainRole: string | null; lastSeenAt: number | null; clientCount: number }) => void) => () => void;
      onBridgeRecommendation: (cb: (p: unknown) => void) => () => void;
      onConnectorsUpdate: (cb: (d: ConnectorHealth[]) => void) => () => void;
    };
  }
}

type Tab = 'theater' | 'paper' | 'markets' | 'journal' | 'profit' | 'settings' | 'world';
export const DEFAULT_VISIBLE_THESIS_LIMIT = 25;
// Markets tab can carry up to ~500 rows; cap the rendered window so the table
// never mounts an unbounded number of <tr> elements at once (see limitVisibleItems).
export const DEFAULT_VISIBLE_MARKET_LIMIT = 100;

export function limitVisibleItems<T>(
  items: readonly T[],
  limit = DEFAULT_VISIBLE_THESIS_LIMIT,
  offset = 0,
): T[] {
  const start = Math.max(0, offset);
  return items.slice(start, start + Math.max(0, limit));
}

// Stable (module-level) empty-array references so components memoized with
// React.memo don't see a "changed" prop every render just because the caller
// wrote `[]` inline in JSX.
const EMPTY_CONCENTRATION_WARNINGS: string[] = [];
const EMPTY_PLAYBOOK_DRAWDOWNS: { playbook: string; pnl: number }[] = [];

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>('theater');
  const [selected, setSelected] = useState<ThesisCard | null>(null);
  const [markets, setMarkets] = useState<KalshiMarket[]>([]);
  const [dryRunResult, setDryRunResult] = useState<string | null>(null);
  const [paperResult, setPaperResult] = useState<string | null>(null);
  const [liveResult, setLiveResult] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [visibleThesisOffset, setVisibleThesisOffset] = useState(0);
  const [visibleMarketsOffset, setVisibleMarketsOffset] = useState(0);
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
    const unsubscribeBridge = window.nemesis.onBridgeStatus((s) => setBridgeConnected(s.connected));
    const bridgePoll = setInterval(() => {
      window.nemesis.getBridgeStatus().then((s) => setBridgeConnected(s.connected)).catch(() => {});
    }, 1_000);
    return () => {
      clearInterval(bridgePoll);
      unsubscribeBridge();
    };
  }, [load]);

  // Coalesce inbound IPC state updates so a burst of messages produces at most
  // one React commit per animation frame instead of one commit per message.
  // Every message's state-update logic is queued (never dropped, never reordered)
  // in a ref; a single rAF (setTimeout(…,16) fallback) then runs every queued
  // update in arrival order inside one callback. Because React 18+ batches all
  // setState calls made synchronously within that callback, this yields exactly
  // one commit per flush while preserving the exact same final state (upserts/
  // removals/full deltas still apply in order, later-arriving deltas for the
  // same stream still land after earlier ones).
  const pendingIpcUpdatesRef = useRef<Array<() => void>>([]);
  const ipcFlushHandleRef = useRef<number | ReturnType<typeof setTimeout> | null>(null);

  const flushIpcUpdates = useCallback(() => {
    ipcFlushHandleRef.current = null;
    const updates = pendingIpcUpdatesRef.current;
    if (updates.length === 0) return;
    pendingIpcUpdatesRef.current = [];
    for (const applyUpdate of updates) applyUpdate();
  }, []);

  const enqueueIpcUpdate = useCallback((applyUpdate: () => void) => {
    pendingIpcUpdatesRef.current.push(applyUpdate);
    if (ipcFlushHandleRef.current != null) return;
    if (typeof requestAnimationFrame === 'function') {
      ipcFlushHandleRef.current = requestAnimationFrame(flushIpcUpdates);
    } else {
      ipcFlushHandleRef.current = setTimeout(flushIpcUpdates, 16);
    }
  }, [flushIpcUpdates]);

  // Cancel any pending flush on unmount so we never call setState after unmount.
  useEffect(() => () => {
    const handle = ipcFlushHandleRef.current;
    if (handle != null) {
      if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(handle as number);
      } else {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
    }
    pendingIpcUpdatesRef.current = [];
  }, []);

  // IPC subscriptions own and release their exact listener.
  useEffect(() => {
    if (!window.nemesis) return;
    const unsubscribers = [window.nemesis.onMarketsUpdate((d) => {
      enqueueIpcUpdate(() => {
        setState((prev) => (prev ? {
          ...prev,
          theses: d.theses ?? prev.theses,
          connectors: d.connectors ?? prev.connectors,
          tradeFeed: d.tradeFeed ?? prev.tradeFeed,
          gates: d.gates ?? prev.gates,
        } : prev));
        if (d.markets) setMarkets(d.markets);
        if (d.discovery) setDiscovery(d.discovery);
      });
    }), window.nemesis.onMarketsStateV2((envelope) => {
      enqueueIpcUpdate(() => {
        const changes = envelope.full ?? envelope.upserts ?? [];
        setMarkets((previous) => {
          const next = new Map((envelope.full ? [] : previous).map((market) => [market.ticker, market]));
          for (const key of envelope.removals ?? []) if (key.startsWith('market:')) next.delete(key.slice(7));
          for (const item of changes) if (item.kind === 'market') next.set(item.value.ticker, item.value);
          return [...next.values()];
        });
        setState((previous) => {
          if (!previous) return previous;
          const next = new Map((envelope.full ? [] : previous.theses).map((thesis) => [thesis.id, thesis]));
          for (const key of envelope.removals ?? []) if (key.startsWith('thesis:')) next.delete(key.slice(7));
          for (const item of changes) if (item.kind === 'thesis') next.set(item.value.id, item.value);
          return { ...previous, theses: [...next.values()] };
        });
      });
    }), window.nemesis.onConnectorsUpdate((connectors) => {
      enqueueIpcUpdate(() => {
        setState((prev) => prev ? { ...prev, connectors } : prev);
      });
    }), window.nemesis.onDiscoveryUpdate((d) => {
      enqueueIpcUpdate(() => setDiscovery(d as DiscoveryState));
    }),
    window.nemesis.onSettingsUpdate((s) => {
      enqueueIpcUpdate(() => {
        setState((prev) => prev ? { ...prev, settings: s } : prev);
      });
    }), window.nemesis.onPaperUpdate((d) => {
      enqueueIpcUpdate(() => {
        setPaper((previous) => ({ ...d, equityHistory: d.equityHistory ?? previous?.equityHistory ?? [] }));
        setState((prev) => prev ? {
          ...prev,
          activeRegimes: d.activeRegimes,
          dailyPnl: d.dailyPnl,
          paperQualification: d.paperQualification,
          strategyValidation: d.strategyValidation,
          pilotValidation: d.pilotValidation,
        } : prev);
      });
    }), window.nemesis.onEquityHistoryStateV2((envelope) => {
      enqueueIpcUpdate(() => {
        setPaper((previous) => {
          if (!previous) return previous;
          const changes = envelope.full ?? envelope.upserts ?? [];
          const next = new Map((envelope.full ? [] : previous.equityHistory).map((point) => [String(point.t), point]));
          for (const key of envelope.removals ?? []) next.delete(key);
          for (const point of changes) next.set(String(point.t), point);
          return { ...previous, equityHistory: [...next.values()].sort((left, right) => left.t - right.t) };
        });
      });
    }), window.nemesis.onTicksUpdate((d) => {
      enqueueIpcUpdate(() => {
        if (selected?.ticker === d.ticker) setTicks(d.ticks);
      });
    })];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [selected?.ticker, enqueueIpcUpdate]);

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

  // Expensive per-render derivations — memoized so a coalesced-but-unrelated
  // render (e.g. connectors/settings updating) doesn't re-filter every thesis.
  // Must also be above early returns to satisfy Rules of Hooks.
  const theses = state?.theses ?? [];
  const filtered = useMemo(() => theses.filter((t) => {
    if (filter === 'scout' || filter === 'solid' || filter === 'whale') {
      const tier = t.executableTier;
      if (!tier) return false;
      const order: Record<ExecutableTier, number> = { whale: 3, solid: 2, scout: 1 };
      return order[tier] >= order[filter as ExecutableTier];
    }
    if (filter === 'all') return true;
    if (filter === 'tradeable') return t.status === 'tradeable' || t.status === 'qualified' || t.status === 'watch-only';
    return t.playbook === filter || t.status === filter;
  }), [theses, filter]);
  const tierCounts = useMemo(() => ({
    scout: theses.filter((t) => t.executableTier === 'scout' || t.executableTier === 'solid' || t.executableTier === 'whale').length,
    solid: theses.filter((t) => t.executableTier === 'solid' || t.executableTier === 'whale').length,
    whale: theses.filter((t) => t.executableTier === 'whale').length,
  }), [theses]);
  const tradableCount = useMemo(
    () => theses.filter((t) => t.status === 'tradeable' || t.status === 'qualified' || t.status === 'watch-only').length,
    [theses],
  );

  // Stable callback identity (changes only when `state` itself changes, not on
  // every unrelated re-render) so the memoized NotificationPanel can bail out.
  const handleNotifAction = useCallback((n: NemesisNotification) => {
    if (n.positionId) {
      void window.nemesis.paperClose(n.positionId).then(loadPaper);
    } else if (n.thesisId && state) {
      setTab('theater');
      const card = state.theses.find((c) => c.id === n.thesisId);
      if (card) setSelected(card);
    }
  }, [state, loadPaper]);

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

  const normalizedThesisOffset = Math.min(
    visibleThesisOffset,
    Math.max(0, Math.floor(Math.max(0, filtered.length - 1) / DEFAULT_VISIBLE_THESIS_LIMIT) * DEFAULT_VISIBLE_THESIS_LIMIT),
  );
  const visibleTheses = limitVisibleItems(filtered, DEFAULT_VISIBLE_THESIS_LIMIT, normalizedThesisOffset);
  const normalizedMarketsOffset = Math.min(
    visibleMarketsOffset,
    Math.max(0, Math.floor(Math.max(0, markets.length - 1) / DEFAULT_VISIBLE_MARKET_LIMIT) * DEFAULT_VISIBLE_MARKET_LIMIT),
  );
  const visibleMarkets = limitVisibleItems(markets, DEFAULT_VISIBLE_MARKET_LIMIT, normalizedMarketsOffset);
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
                    <button key={f} type="button" onClick={() => {
                      setFilter(f);
                      setVisibleThesisOffset(0);
                    }} style={chipStyle(filter === f)}>
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
                {visibleTheses.map((card) => (
                  <motion.div
                    key={card.id}
                    initial={{ opacity: 0, y: 14, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.16 }}
                  >
                  <TheaterThesisCard
                    card={card}
                    selected={selected?.id === card.id}
                    showLiveBuy={state.settings.liveEnabled && !state.settings.killSwitchActive}
                    onSelectCard={setSelected}
                    load={load}
                    loadPaper={loadPaper}
                    setDryRunResult={setDryRunResult}
                    setLiveResult={setLiveResult}
                    setPaperResult={setPaperResult}
                  />
                  </motion.div>
                ))}
                </AnimatePresence>
              </div>
              {filtered.length > DEFAULT_VISIBLE_THESIS_LIMIT && (
                <div style={{ display: 'flex', gap: 8, alignSelf: 'center', alignItems: 'center', marginTop: 12 }}>
                  <button
                    type="button"
                    disabled={normalizedThesisOffset === 0}
                    onClick={() => setVisibleThesisOffset((current) => Math.max(0, current - DEFAULT_VISIBLE_THESIS_LIMIT))}
                    style={chipStyle(false)}
                  >
                    Previous 25
                  </button>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {normalizedThesisOffset + 1}–{normalizedThesisOffset + visibleTheses.length}/{filtered.length}
                  </span>
                  <button
                    type="button"
                    disabled={normalizedThesisOffset + visibleTheses.length >= filtered.length}
                    onClick={() => setVisibleThesisOffset((current) => Math.min(filtered.length - 1, current + DEFAULT_VISIBLE_THESIS_LIMIT))}
                    style={chipStyle(false)}
                  >
                    Next 25
                  </button>
                </div>
              )}
            </>
          )}

          {tab === 'paper' && paper && (
            <>
              <h1 style={{ fontSize: 18, marginBottom: 12 }}>Paper Command Desk</h1>
              {paper.strategyValidation && (() => {
                const sv = paper.strategyValidation!;
                const minScored = sv.shadowMinScored ?? 100;
                const minDays = sv.shadowMinDistinctDays ?? 3;
                const minObservationMs = sv.shadowMinObservationMs ?? 0;
                const countOk = sv.shadowCountPassed
                  ?? (sv.shadowCandidateCount >= minScored
                    && sv.shadowDistinctDayCount >= minDays
                    && (sv.shadowObservationWindowMs ?? 0) >= minObservationMs
                    && !sv.paused
                    && !sv.integrityError);
                const qualityOk = sv.shadowQualityPassed ?? sv.shadowPassed;
                const daysMatter = minDays > 1;
                const daysPart = daysMatter ? ` · days ${sv.shadowDistinctDayCount}/${minDays}` : '';
                const observationPart = minObservationMs > 0
                  ? ` · age ${((sv.shadowObservationWindowMs ?? 0) / 86_400_000).toFixed(1)}/${(minObservationMs / 86_400_000).toFixed(1)}d`
                  : '';
                const pf = Number.isFinite(sv.shadowProfitFactor) ? sv.shadowProfitFactor.toFixed(2) : '∞';
                const countLabel = countOk ? 'count PASS' : 'count short';
                const qualityLabel = qualityOk
                  ? 'quality PASS'
                  : `quality FAIL (net $${sv.shadowNetPnlUsd.toFixed(2)})`;
                return (
                <div style={{ padding: 12, marginBottom: 12, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase' }}>
                        Validation stage: {sv.stage}
                      </div>
                      <div style={{ marginTop: 5, fontSize: 11, color: 'var(--text-muted)' }}>
                        {`Shadow ${sv.shadowCandidateCount}/${minScored}${daysPart}${observationPart} · ${countLabel} · ${qualityLabel} · PF ${pf} · wins ${(sv.shadowWinRate * 100).toFixed(1)}%`}
                      </div>
                      {paper.pilotValidation && (
                        <div style={{ marginTop: 3, fontSize: 11, color: 'var(--text-muted)' }}>
                          Pilot {paper.pilotValidation.completedPositionCount}/20 · net ${paper.pilotValidation.realizedPnlUsd.toFixed(2)} · PF {Number.isFinite(paper.pilotValidation.profitFactor) ? paper.pilotValidation.profitFactor.toFixed(2) : '∞'} · loss budget ${paper.pilotValidation.lossBudgetRemainingUsd.toFixed(2)}
                        </div>
                      )}
                      {sv.paused && (
                        <div style={{ marginTop: 5, fontSize: 11, color: 'var(--danger)' }}>Paused: {sv.pauseReason}</div>
                      )}
                    </div>
                    {sv.stage === 'shadow' && qualityOk && (
                      <button type="button" style={chipStyle(false)} onClick={async () => {
                        const confirmation = window.prompt('Type ADVANCE_TO_PILOT to start the capped paper pilot.');
                        if (!confirmation) return;
                        const result = await window.nemesis.advanceStrategyStage('pilot', confirmation);
                        setPaperResult(result.ok ? 'Advanced to capped paper pilot.' : `Stage advance blocked: ${result.error}`);
                        await loadPaper();
                      }}>Advance to pilot</button>
                    )}
                    {sv.stage === 'pilot' && paper.pilotValidation?.passed && (
                      <button type="button" style={chipStyle(false)} onClick={async () => {
                        const confirmation = window.prompt('Type ADVANCE_TO_QUALIFICATION to continue into full qualification.');
                        if (!confirmation) return;
                        const result = await window.nemesis.advanceStrategyStage('qualification', confirmation);
                        setPaperResult(result.ok ? 'Advanced to full qualification.' : `Stage advance blocked: ${result.error}`);
                        await loadPaper();
                      }}>Advance to qualification</button>
                    )}
                  </div>
                </div>
                );
              })()}
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
                  const confirmation = window.prompt('Type ARCHIVE_AND_RESET_PAPER to archive the current run and create a clean $5,000 run.');
                  if (!confirmation) return;
                  const result = await window.nemesis.resetPaper(confirmation);
                  setPaperResult(result.ok
                    ? `Archived current run and created clean $5,000 run ${result.newRunId}`
                    : `Reset blocked: ${result.error}`);
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
                  {visibleMarkets.map((m) => (
                    <tr key={m.ticker} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={tdStyle}>{m.ticker}</td>
                      <td style={tdStyle}>{m.title}</td>
                      <td style={tdStyle}>{m.category ?? '—'}</td>
                      <td style={tdStyle}>{m.yes_ask ?? m.yes_bid ?? '—'}¢</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {markets.length > DEFAULT_VISIBLE_MARKET_LIMIT && (
                <div style={{ display: 'flex', gap: 8, alignSelf: 'center', alignItems: 'center', marginTop: 12 }}>
                  <button
                    type="button"
                    disabled={normalizedMarketsOffset === 0}
                    onClick={() => setVisibleMarketsOffset((current) => Math.max(0, current - DEFAULT_VISIBLE_MARKET_LIMIT))}
                    style={chipStyle(false)}
                  >
                    Previous {DEFAULT_VISIBLE_MARKET_LIMIT}
                  </button>
                  <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                    {normalizedMarketsOffset + 1}–{normalizedMarketsOffset + visibleMarkets.length}/{markets.length}
                  </span>
                  <button
                    type="button"
                    disabled={normalizedMarketsOffset + visibleMarkets.length >= markets.length}
                    onClick={() => setVisibleMarketsOffset((current) => Math.min(markets.length - 1, current + DEFAULT_VISIBLE_MARKET_LIMIT))}
                    style={chipStyle(false)}
                  >
                    Next {DEFAULT_VISIBLE_MARKET_LIMIT}
                  </button>
                </div>
              )}
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
                  <button
                    type="button"
                    onClick={async () => {
                      const confirmation = window.prompt('Type ARCHIVE_AND_RESET_PAPER to archive the current run and create a clean $5,000 run.');
                      if (!confirmation) return;
                      const result = await window.nemesis.resetPaper(confirmation);
                      setPaperResult(result.ok
                        ? `Archived current run and created clean $5,000 run ${result.newRunId}`
                        : `Reset blocked: ${result.error}`);
                      await loadPaper();
                    }}
                    style={chipStyle(false)}
                  >
                    Archive and reset to $5,000
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
              concentrationWarnings={EMPTY_CONCENTRATION_WARNINGS}
              playbookDrawdowns={EMPTY_PLAYBOOK_DRAWDOWNS}
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

// Wraps ThesisCardView with stable, per-card callback identities so
// React.memo (applied inside ThesisCardView) can actually bail out of
// re-rendering a card when neither its data nor selection state changed —
// even though the parent App re-renders on every coalesced IPC flush.
interface TheaterThesisCardProps {
  card: ThesisCard;
  selected: boolean;
  showLiveBuy: boolean;
  onSelectCard: (card: ThesisCard) => void;
  load: () => Promise<void>;
  loadPaper: () => Promise<void>;
  setDryRunResult: (v: string | null) => void;
  setLiveResult: (v: string | null) => void;
  setPaperResult: (v: string | null) => void;
}

const TheaterThesisCard = memo(function TheaterThesisCard({
  card,
  selected,
  showLiveBuy,
  onSelectCard,
  load,
  loadPaper,
  setDryRunResult,
  setLiveResult,
  setPaperResult,
}: TheaterThesisCardProps) {
  const onSelect = useCallback(() => onSelectCard(card), [onSelectCard, card]);

  const onJournal = useCallback(async () => {
    await window.nemesis.journalAdd(card.id);
    load();
  }, [card.id, load]);

  const onDryRun = useCallback(async () => {
    const r = await window.nemesis.dryRun(card.id);
    setDryRunResult(r.aborted
      ? `Dry-run aborted: ${r.abortReason}`
      : `Dry-run fill @ ${((r.fillPrice ?? 0) * 100).toFixed(1)}¢ slippage ${((r.slippage ?? 0) * 100).toFixed(2)}¢`);
  }, [card.id, setDryRunResult]);

  const onLiveBuy = useCallback(async () => {
    const r = await window.nemesis.liveBuy(card.id);
    if (r.ok) {
      setLiveResult(`Live order placed on ${card.ticker}${r.orderId ? ` (#${r.orderId})` : ''}`);
    } else {
      setLiveResult(`Live buy failed: ${r.error ?? 'unknown'}`);
    }
  }, [card.id, card.ticker, setLiveResult]);

  const onPaperBuy = useCallback(async () => {
    const r = await window.nemesis.paperBuy(card.id);
    if (r.ok) {
      setPaperResult(`Paper buy filled on ${card.ticker}${r.fill ? ` @ ${((r.fill.fillPrice ?? 0) * 100).toFixed(1)}¢` : ''}`);
      onSelectCard(card);
      loadPaper();
    } else {
      setPaperResult(`Paper buy failed: ${r.error ?? r.abortReason ?? 'unknown'}`);
    }
  }, [card, setPaperResult, onSelectCard, loadPaper]);

  return (
    <ThesisCardView
      card={card}
      selected={selected}
      onSelect={onSelect}
      showLiveBuy={showLiveBuy}
      showPaperBuy={true}
      onJournal={onJournal}
      onDryRun={onDryRun}
      onLiveBuy={onLiveBuy}
      onPaperBuy={onPaperBuy}
    />
  );
});

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
