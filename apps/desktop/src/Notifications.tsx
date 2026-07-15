import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AutoCloseDecision, ThesisCard } from '@nemesis/core';

let _audioCtx: AudioContext | null = null;
export const NOTIFICATION_ID_TTL_MS = 24 * 60 * 60_000;
export const MAX_RETAINED_NOTIFICATION_IDS = 2_000;

export function pruneFiredNotificationIds(
  fired: Map<string, number>,
  now: number,
  ttlMs = NOTIFICATION_ID_TTL_MS,
  maxEntries = MAX_RETAINED_NOTIFICATION_IDS,
): void {
  for (const [id, firedAt] of fired) {
    if (now - firedAt >= ttlMs) fired.delete(id);
  }
  while (fired.size > maxEntries) {
    const oldest = fired.keys().next().value as string | undefined;
    if (oldest == null) break;
    fired.delete(oldest);
  }
}

function getAudioCtx(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') _audioCtx = new AudioContext();
  return _audioCtx;
}

function playDing(severity: 'info' | 'warn' | 'success') {
  try {
    const ctx = getAudioCtx();
    const freq = severity === 'success' ? 880 : severity === 'warn' ? 660 : 740;
    const play = () => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    };
    if (ctx.state === 'suspended') {
      void ctx.resume().then(play);
    } else {
      play();
    }
  } catch { /* audio unavailable */ }
}

export interface NemesisNotification {
  id: string;
  type: 'close' | 'opportunity' | 'profit' | 'fill' | 'regime';
  severity: 'info' | 'warn' | 'success';
  title: string;
  body: string;
  ts: number;
  positionId?: string;
  thesisId?: string;
}

export const MAX_NEW_OPPORTUNITY_NOTIFICATIONS_PER_UPDATE = 3;

export function selectNewOpportunityNotifications(
  theses: readonly ThesisCard[],
  previousIds: ReadonlySet<string>,
  limit = MAX_NEW_OPPORTUNITY_NOTIFICATIONS_PER_UPDATE,
): ThesisCard[] {
  return theses
    .filter((card) => card.netEdge > 0.025 && card.status === 'tradeable' && !previousIds.has(card.id))
    .sort((left, right) => right.netEdge - left.netEdge)
    .slice(0, Math.max(0, limit));
}

interface PaperPos {
  id: string; ticker: string; title: string; side: 'yes' | 'no';
  contracts: number; entryPrice: number; fees: number;
}
interface WorkingOrder { id: string; ticker: string; }
export interface PaperSlice {
  portfolio: { positions: PaperPos[] };
  marks: Record<string, number>;
  workingOrders?: WorkingOrder[];
  dailyPnl?: number;
  activeRegimes?: string[];
  autoCloseDecisions?: AutoCloseDecision[];
}

function pnlPct(pos: PaperPos, mark: number): number {
  const fee = Math.ceil(0.07 * mark * (1 - mark) * 100) / 100 * pos.contracts;
  const proceeds = mark * pos.contracts - fee;
  const cost = pos.entryPrice * pos.contracts + pos.fees;
  return cost > 0 ? (proceeds - cost) / cost : 0;
}

export function useNotifications(theses: ThesisCard[], paper: PaperSlice | null) {
  const [notes, setNotes] = useState<NemesisNotification[]>([]);
  const fired = useRef(new Map<string, number>());
  const prevPaper = useRef<PaperSlice | null>(null);
  const prevIds = useRef(new Set<string>());
  const opportunitiesInitialized = useRef(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  function push(n: Omit<NemesisNotification, 'ts'>) {
    const now = Date.now();
    pruneFiredNotificationIds(fired.current, now);
    if (fired.current.has(n.id)) return;
    fired.current.set(n.id, now);
    pruneFiredNotificationIds(fired.current, now);
    const full = { ...n, ts: now };
    setNotes((p) => [full, ...p].slice(0, 5));
    clearTimeout(timers.current.get(n.id));
    timers.current.set(n.id, setTimeout(() => dismiss(n.id), 10_000));
    playDing(n.severity);
  }

  function dismiss(id: string) {
    setNotes((p) => p.filter((n) => n.id !== id));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  // Position & portfolio checks (runs whenever paper or theses update)
  useEffect(() => {
    if (!paper) return;
    const { portfolio, marks, workingOrders = [], dailyPnl = 0, activeRegimes = [], autoCloseDecisions = [] } = paper;
    const prev = prevPaper.current;

    for (const d of autoCloseDecisions) {
      if (Date.now() - d.triggeredAt > 10 * 60_000) continue;
      const edgeGone = d.reason.toLowerCase().includes('edge gone');
      const geaExit = d.reason.toLowerCase().includes('gea exit');
      const title = d.action === 'trim'
        ? 'Auto-trimmed near peak'
        : geaExit
          ? 'GEA exit confirmed'
          : edgeGone
            ? 'Emergency close: edge gone'
            : 'Auto-closed after edge decay';
      push({
        id: `auto-close:${d.id}`,
        type: 'close',
        severity: edgeGone ? 'warn' : 'success',
        title,
        body: `${d.ticker} ×${d.contracts} · current ${(d.currentPnlPct * 100).toFixed(1)}% · peak ${(d.peakPnlPct * 100).toFixed(1)}%`,
        positionId: d.positionId,
      });
    }

    for (const pos of portfolio.positions) {
      const card = theses.find((c) => c.ticker === pos.ticker && c.side === pos.side);
      const mark = marks[`${pos.ticker}:${pos.side}`] ?? marks[pos.ticker] ?? pos.entryPrice;
      const pct = pnlPct(pos, mark);

      if (card && card.netEdge <= 0)
        push({ id: `${pos.id}:edge-gone`, type: 'close', severity: 'warn',
          title: 'Edge gone — consider closing', body: pos.title.slice(0, 60), positionId: pos.id });

      if (pct >= 0.15)
        push({ id: `${pos.id}:profit-15`, type: 'close', severity: 'success',
          title: `Lock in profit +${(pct * 100).toFixed(0)}%`, body: pos.title.slice(0, 60), positionId: pos.id });

      if (card && card.status === 'stale')
        push({ id: `${pos.id}:stale`, type: 'close', severity: 'warn',
          title: 'Signal stale — consider exiting', body: pos.title.slice(0, 60), positionId: pos.id });

      if (card && card.edgeHistory.length >= 3) {
        const h = card.edgeHistory.slice(-3);
        if (h[2] < h[1] && h[1] < h[0])
          push({ id: `${pos.id}:edge-trend`, type: 'close', severity: 'info',
            title: 'Edge weakening', body: `${pos.title.slice(0, 50)} — declining 3 updates`, positionId: pos.id });
      }
    }

    // Portfolio flips profitable
    if ((prev?.dailyPnl ?? 0) <= 0 && dailyPnl > 0)
      push({ id: `profit:${new Date().toDateString()}`, type: 'profit', severity: 'success',
        title: 'Portfolio in the green!', body: `Up $${dailyPnl.toFixed(2)} today` });

    // Order fills (working order disappeared)
    for (const o of prev?.workingOrders ?? []) {
      if (!workingOrders.find((w) => w.id === o.id))
        push({ id: `fill:${o.id}`, type: 'fill', severity: 'success',
          title: 'Order filled', body: `Limit order triggered on ${o.ticker}` });
    }

    // New regime
    const prevR = new Set(prev?.activeRegimes ?? []);
    for (const r of activeRegimes)
      if (!prevR.has(r))
        push({ id: `regime:${r}`, type: 'regime', severity: 'warn',
          title: 'No-trade regime', body: r.replace(/-/g, ' ') });

    prevPaper.current = paper;
  }, [paper, theses]);

  // New high-edge opportunity
  useEffect(() => {
    if (!opportunitiesInitialized.current) {
      if (theses.length === 0) return;
      opportunitiesInitialized.current = true;
      prevIds.current = new Set(theses.map((card) => card.id));
      return;
    }
    for (const c of selectNewOpportunityNotifications(theses, prevIds.current)) {
      push({ id: `opp:${c.id}`, type: 'opportunity', severity: 'info',
        title: 'New trade signal', body: `${c.title.slice(0, 55)} — ${(c.netEdge * 100).toFixed(1)}¢ edge`, thesisId: c.id });
    }
    prevIds.current = new Set(theses.map((c) => c.id));
  }, [theses]);

  return { notes, dismiss };
}

const CLR = { info: '#3b82f6', warn: '#f59e0b', success: '#22c55e' } as const;
const ICO = { close: '⚠️', opportunity: '🎯', profit: '📈', fill: '✅', regime: '🚫' } as const;

export function NotificationPanel({
  notes, onDismiss, onAction,
}: {
  notes: NemesisNotification[];
  onDismiss: (id: string) => void;
  onAction: (n: NemesisNotification) => void;
}) {
  return (
    <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, width: 300, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
      <AnimatePresence>
        {notes.map((n) => (
          <motion.div
            key={n.id}
            initial={{ opacity: 0, x: 64, scale: 0.92 }}
            animate={{ opacity: 1, x: 0, scale: 1, transition: { type: 'spring', stiffness: 360, damping: 28 } }}
            exit={{ opacity: 0, x: 64, scale: 0.9, transition: { duration: 0.18 } }}
            style={{ background: 'var(--bg-card, #1a1d27)', border: `1px solid ${CLR[n.severity]}44`, borderLeft: `4px solid ${CLR[n.severity]}`, borderRadius: 6, padding: '10px 12px', pointerEvents: 'all', boxShadow: '0 4px 20px rgba(0,0,0,0.6)' }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text, #e2e8f0)', lineHeight: 1.3 }}>
                {ICO[n.type]} {n.title}
              </span>
              <button type="button" onClick={() => onDismiss(n.id)} style={{ background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1, marginLeft: 8, flexShrink: 0 }}>×</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted, #8b93a7)', marginTop: 4, lineHeight: 1.4 }}>{n.body}</div>
            {(n.positionId || n.thesisId) && (
              <button type="button" onClick={() => onAction(n)} style={{ marginTop: 7, fontSize: 11, padding: '3px 10px', background: CLR[n.severity] + '20', border: `1px solid ${CLR[n.severity]}88`, borderRadius: 4, color: CLR[n.severity], cursor: 'pointer' }}>
                {n.type === 'close' ? 'Close position →' : 'View signal →'}
              </button>
            )}
            <div style={{ fontSize: 10, color: '#444', marginTop: 4 }}>{new Date(n.ts).toLocaleTimeString()}</div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
