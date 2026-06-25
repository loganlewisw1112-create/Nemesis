import { useState } from 'react';
import type {
  AutoCloseDecision,
  AutoCloseSettings,
  AutoCloseState,
  PaperPortfolio,
  PaperPosition,
  PaperOrder,
  PaperTrade,
} from '@nemesis/core';
import { DEFAULT_AUTO_CLOSE_SETTINGS } from '@nemesis/core';
import { positionUnrealizedPnl } from '@nemesis/core';

interface Props {
  portfolio: PaperPortfolio;
  marks: Record<string, number>;
  equity: number;
  unrealized: number;
  workingOrders?: PaperOrder[];
  dailyPnl?: number;
  dailyLossCap?: number;
  autoCloseSettings?: AutoCloseSettings;
  autoCloseStateByPosition?: Record<string, AutoCloseState>;
  autoCloseDecisions?: AutoCloseDecision[];
  onClose: (id: string, contracts?: number) => void;
  onReset: () => void;
  onPreview?: (contracts: number) => void;
  onPlaceLimit?: (contracts: number, limitPrice: number) => void;
  onCancelOrder?: (orderId: string) => void;
  selectedTicker?: string | null;
}

export function PaperDeskPanel({
  portfolio,
  marks,
  equity,
  unrealized,
  workingOrders = [],
  dailyPnl = 0,
  dailyLossCap = 5,
  autoCloseSettings = DEFAULT_AUTO_CLOSE_SETTINGS,
  autoCloseStateByPosition = {},
  autoCloseDecisions = [],
  onClose,
  onReset,
  onPreview,
  onPlaceLimit,
  onCancelOrder,
  selectedTicker,
}: Props) {
  const [closeQty, setCloseQty] = useState<Record<string, string>>({});
  const [ticketQty, setTicketQty] = useState('10');
  const [limitPrice, setLimitPrice] = useState('0.50');

  const deployed = portfolio.positions.reduce((s, p) => s + p.entryPrice * p.contracts, 0);
  const heatPct = equity > 0 ? (deployed / equity) * 100 : 0;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
        <Stat label="Paper equity" value={`$${equity.toFixed(2)}`} accent />
        <Stat label="Cash" value={`$${portfolio.cash.toFixed(2)}`} />
        <Stat label="Heat" value={`${heatPct.toFixed(0)}% deployed`} />
        <Stat label="Unrealized" value={`$${unrealized.toFixed(2)}`} positive={unrealized >= 0} />
        <Stat label="Realized" value={`$${portfolio.realizedPnl.toFixed(2)}`} positive={portfolio.realizedPnl >= 0} />
        <Stat label="Daily P&L" value={`$${dailyPnl.toFixed(2)}`} positive={dailyPnl >= 0} />
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        Daily loss cap: ${dailyLossCap.toFixed(2)} ·{' '}
        {dailyPnl <= -dailyLossCap ? (
          <span style={{ color: 'var(--danger)' }}>CAP BREACHED — new buys blocked</span>
        ) : (
          <span>${(dailyLossCap + dailyPnl).toFixed(2)} remaining</span>
        )}
      </div>

      <div style={{ ...cardStyle, marginBottom: 12, fontSize: 11 }}>
        <span style={{ color: autoCloseSettings.enabled ? 'var(--success)' : 'var(--text-muted)', fontWeight: 700 }}>
          Paper auto-close {autoCloseSettings.enabled ? 'ON' : 'OFF'}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>
          {' '}· trim +{(autoCloseSettings.firstTrimProfitPct * 100).toFixed(0)}%/{(autoCloseSettings.firstTrimGivebackPct * 100).toFixed(0)}% giveback
          {' '}· close +{(autoCloseSettings.finalCloseProfitPct * 100).toFixed(0)}%/{(autoCloseSettings.finalCloseGivebackPct * 100).toFixed(0)}% giveback
        </span>
      </div>

      {selectedTicker && onPreview && (
        <div style={{ ...cardStyle, marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 8, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            Order ticket · {selectedTicker}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ fontSize: 11 }}>
              Qty{' '}
              <input
                type="number"
                min={1}
                value={ticketQty}
                onChange={(e) => setTicketQty(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={{ fontSize: 11 }}>
              Limit{' '}
              <input
                type="number"
                step={0.01}
                min={0.01}
                max={0.99}
                value={limitPrice}
                onChange={(e) => setLimitPrice(e.target.value)}
                style={inputStyle}
              />
            </label>
            <button type="button" onClick={() => onPreview(Number(ticketQty) || 1)} style={btnStyle}>
              Preview fill
            </button>
            {onPlaceLimit && (
              <button
                type="button"
                onClick={() => onPlaceLimit(Number(ticketQty) || 1, Number(limitPrice) || 0.5)}
                style={btnStyle}
              >
                Place limit
              </button>
            )}
          </div>
        </div>
      )}

      <h2 style={sectionTitle}>Open Positions ({portfolio.positions.length})</h2>
      {portfolio.positions.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
          No open paper positions. Select a thesis and click Paper Buy.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {portfolio.positions.map((p) => (
            <PositionRow
              key={p.id}
              pos={p}
              mark={marks[p.ticker] ?? p.entryPrice}
              equity={equity}
              closeQty={closeQty[p.id] ?? String(p.contracts)}
              autoCloseState={autoCloseStateByPosition[p.id]}
              autoCloseSettings={autoCloseSettings}
              onCloseQtyChange={(v) => setCloseQty((prev) => ({ ...prev, [p.id]: v }))}
              onClose={onClose}
            />
          ))}
        </div>
      )}

      {autoCloseDecisions.length > 0 && (
        <>
          <h2 style={sectionTitle}>Auto-close decisions</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {autoCloseDecisions.slice(0, 5).map((d) => (
              <div key={d.id} style={{ ...cardStyle, fontSize: 11 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: 700, color: d.action === 'trim' ? 'var(--warning)' : 'var(--success)' }}>
                    {d.action === 'trim' ? 'Auto-trimmed near peak' : d.reason.toLowerCase().includes('edge gone') ? 'Emergency close: edge gone' : 'Auto-closed after edge decay'}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>{new Date(d.triggeredAt).toLocaleTimeString()}</span>
                </div>
                <div style={{ color: 'var(--text-muted)' }}>
                  {d.ticker} ×{d.contracts} · current {(d.currentPnlPct * 100).toFixed(1)}% · peak {(d.peakPnlPct * 100).toFixed(1)}% · {(d.givebackPct * 100).toFixed(0)}% giveback
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {workingOrders.length > 0 && (
        <>
          <h2 style={sectionTitle}>Working orders ({workingOrders.length})</h2>
          <div style={{ marginBottom: 16 }}>
            {workingOrders.map((o) => (
              <div key={o.id} style={{ ...cardStyle, marginBottom: 6, fontSize: 11, display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  {o.orderType.toUpperCase()} {o.side} ×{o.contracts} @ {(o.limitPrice * 100).toFixed(1)}¢ · {o.ticker}
                </span>
                {onCancelOrder && (
                  <button type="button" onClick={() => onCancelOrder(o.id)} style={btnStyle}>
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <h2 style={sectionTitle}>Trade blotter</h2>
      <div style={{ overflow: 'auto', marginBottom: 12, maxHeight: 220 }}>
        <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
              <th style={thStyle}>Time</th>
              <th style={thStyle}>Type</th>
              <th style={thStyle}>Ticker</th>
              <th style={thStyle}>Qty</th>
              <th style={thStyle}>Fill</th>
              <th style={thStyle}>Slip</th>
              <th style={thStyle}>Fees</th>
              <th style={thStyle}>P&L</th>
              <th style={thStyle}>Book</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.trades.slice(0, 24).map((t) => (
              <BlotterRow key={t.id} trade={t} />
            ))}
          </tbody>
        </table>
      </div>

      <button type="button" onClick={onReset} style={{ ...btnStyle, color: 'var(--danger)' }}>
        Reset paper wallet
      </button>
    </div>
  );
}

function PositionRow({
  pos,
  mark,
  equity,
  closeQty,
  autoCloseState,
  autoCloseSettings,
  onCloseQtyChange,
  onClose,
}: {
  pos: PaperPosition;
  mark: number;
  equity: number;
  closeQty: string;
  autoCloseState?: AutoCloseState;
  autoCloseSettings: AutoCloseSettings;
  onCloseQtyChange: (v: string) => void;
  onClose: (id: string, contracts?: number) => void;
}) {
  const pnl = positionUnrealizedPnl(pos, mark);
  const pctBook = equity > 0 ? ((pos.entryPrice * pos.contracts) / equity) * 100 : 0;
  const costBasis = pos.entryPrice * pos.contracts + pos.fees;
  const currentPnlPct = costBasis > 0 ? pnl / costBasis : 0;
  const giveback = autoCloseState?.peakPnlPct && autoCloseState.peakPnlPct > 0
    ? Math.max(0, (autoCloseState.peakPnlPct - currentPnlPct) / autoCloseState.peakPnlPct)
    : 0;
  const nextTrigger = autoCloseState
    ? autoCloseState.trimmedContracts > 0
      ? `next close ${(autoCloseSettings.finalCloseGivebackPct * 100).toFixed(0)}% giveback`
      : `next trim ${(autoCloseSettings.firstTrimGivebackPct * 100).toFixed(0)}% giveback`
    : `waiting for ${autoCloseSettings.minTicks} ticks`;
  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 600, fontSize: 12 }}>{pos.title}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginBottom: 6 }}>
        {pos.ticker} · {pos.side.toUpperCase()} × {pos.contracts} @ {(pos.entryPrice * 100).toFixed(1)}¢ · {pctBook.toFixed(0)}% of book
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, marginBottom: 6 }}>
        Peak {autoCloseState ? `${(autoCloseState.peakPnlPct * 100).toFixed(1)}%` : 'collecting'}
        {' '}· Giveback {(giveback * 100).toFixed(0)}%
        {' '}· Ticks {autoCloseState?.tickCount ?? 0}
        {autoCloseState && autoCloseState.trimmedContracts > 0 ? ` · Trimmed ${autoCloseState.trimmedContracts}` : ''}
        {' '}· {nextTrigger}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ color: pnl >= 0 ? 'var(--success)' : 'var(--danger)' }}>${pnl.toFixed(2)} unrealized</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            min={1}
            max={pos.contracts}
            value={closeQty}
            onChange={(e) => onCloseQtyChange(e.target.value)}
            style={{ ...inputStyle, width: 48 }}
          />
          <button
            type="button"
            onClick={() => onClose(pos.id, Number(closeQty) || pos.contracts)}
            style={btnStyle}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function BlotterRow({ trade: t }: { trade: PaperTrade }) {
  const typeLabel = t.autoCloseAction ? `auto-${t.autoCloseAction}` : t.type;
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={tdStyle}>{new Date(t.timestamp).toLocaleTimeString()}</td>
      <td style={{ ...tdStyle, color: t.type === 'open' ? 'var(--accent)' : 'var(--warning)' }}>{typeLabel}</td>
      <td style={tdStyle}>{t.ticker}</td>
      <td style={tdStyle}>{t.contracts}</td>
      <td style={tdStyle}>{(t.price * 100).toFixed(1)}¢</td>
      <td style={tdStyle}>{t.slippage !== undefined ? `${(t.slippage * 100).toFixed(2)}¢` : '—'}</td>
      <td style={tdStyle}>${t.fees.toFixed(2)}</td>
      <td style={{ ...tdStyle, color: (t.pnl ?? 0) >= 0 ? 'var(--success)' : 'var(--danger)' }}>
        {t.pnl !== undefined ? `$${t.pnl.toFixed(2)}` : '—'}
      </td>
      <td style={tdStyle} title={t.autoCloseReason}>{t.playbook ?? '—'}</td>
    </tr>
  );
}

function Stat({ label, value, accent, positive }: { label: string; value: string; accent?: boolean; positive?: boolean }) {
  let color = 'var(--text)';
  if (positive === true) color = 'var(--success)';
  if (positive === false) color = 'var(--danger)';
  if (accent) color = 'var(--accent)';
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 10,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 13,
  marginBottom: 8,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
};

const btnStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: '4px 10px',
  borderRadius: 6,
  fontSize: 11,
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: '4px 6px',
  borderRadius: 4,
  fontSize: 11,
  width: 56,
};

const thStyle: React.CSSProperties = { padding: '4px 6px' };
const tdStyle: React.CSSProperties = { padding: '4px 6px' };
