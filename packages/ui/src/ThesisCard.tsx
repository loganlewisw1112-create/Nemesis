import { memo, useState } from 'react';
import type { ThesisCard } from '@nemesis/core';
import { feeWaterfallData } from '@nemesis/charts';
import { buildProfitExplanation, edgeBreakdownRows, buildRiskItems, depthRiskItem } from './profitExplanation.js';

interface Props {
  card: ThesisCard;
  onDryRun?: () => void;
  onPaperBuy?: () => void;
  onJournal?: () => void;
  selected?: boolean;
  onSelect?: () => void;
  onLiveBuy?: () => void;
  showLiveBuy?: boolean;
  showPaperBuy?: boolean;
}

const STATUS_COLORS: Record<string, string> = {
  tradeable: 'var(--success)',
  qualified: 'var(--accent)',
  'watch-only': 'var(--warning)',
  uncertain: 'var(--warning)',
  stale: 'var(--danger)',
  blocked: 'var(--danger)',
  observe: 'var(--text-muted)',
};

const TRADABLE = new Set(['tradeable', 'qualified', 'watch-only']);

export const ThesisCardView = memo(function ThesisCardView({
  card,
  onDryRun,
  onPaperBuy,
  onLiveBuy,
  onJournal,
  selected,
  onSelect,
  showLiveBuy = false,
  showPaperBuy = true,
}: Props) {
  const [hovered, setHovered] = useState(false);
  const waterfall = feeWaterfallData({
    grossEdge: card.grossEdge,
    spreadCost: card.spread / 2,
    feeCost: card.feeEstimate,
    slippageBuffer: 0.01,
    netEdge: card.netEdge,
  });
  const profitLines = buildProfitExplanation(card);
  const breakdown = edgeBreakdownRows(card);
  const riskItems = buildRiskItems(card);
  const depthRisk = depthRiskItem(card);
  const failedCount = riskItems.filter((r) => !r.ok).length + (depthRisk.ok ? 0 : 1);
  const showProfitBox = true;
  const cryptoContext = card.cryptoContext;
  const certifiedPaperBuy = showPaperBuy
    && card.netEdge > 0
    && card.executionQueueState === 'certified'
    && !!card.profitCertificate;
  const certificationPending = showPaperBuy
    && card.netEdge > 0
    && !certifiedPaperBuy
    && !card.executionBlockReason;

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: selected ? 'var(--bg-elevated)' : 'var(--bg-card)',
        border: `1px solid ${selected ? 'var(--accent)' : card.status === 'tradeable' ? 'var(--success)' : 'var(--border)'}`,
        borderRadius: 10,
        padding: 14,
        cursor: 'pointer',
        transition: 'border-color 0.2s, opacity 0.3s, transform 0.15s ease-out, box-shadow 0.15s ease-out',
        opacity: card.status === 'stale' ? 0.6 : 1,
        transform: hovered && !selected ? 'translateY(-3px)' : 'none',
        boxShadow: hovered ? '0 8px 24px rgba(0,0,0,0.45)' : selected ? '0 0 0 1px var(--accent-glow)' : 'none',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
            {card.playbook} · {card.category}
          </div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{card.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{card.ticker} · {card.side.toUpperCase()}</div>
          {card.executableTier && card.fillableUsd != null && (
            <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 4 }}>
              ~${card.fillableUsd.toFixed(0)} fillable · {((card.slippagePp ?? 0) * 100).toFixed(1)}¢ slip
              {card.depthLevels != null ? ` · ${card.depthLevels} lvls` : ''}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          {card.executableTier && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: 0.5,
                padding: '2px 6px',
                borderRadius: 4,
                background: card.executableTier === 'whale' ? 'rgba(255,193,7,0.2)' : card.executableTier === 'solid' ? 'rgba(99,102,241,0.2)' : 'rgba(34,197,94,0.15)',
                color: card.executableTier === 'whale' ? 'var(--warning)' : card.executableTier === 'solid' ? 'var(--accent)' : 'var(--success)',
              }}
            >
              {card.executableTier.toUpperCase()}
            </span>
          )}
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: STATUS_COLORS[card.status] ?? 'var(--text-muted)',
            textTransform: 'uppercase',
          }}
        >
          {card.status}
        </span>
        </div>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
        {card.externalSummary}
      </div>

      {card.profitCertificate && (
        <div style={{ fontSize: 11, color: 'var(--success)', marginBottom: 8, fontWeight: 700 }}>
          Strict certified +${card.profitCertificate.netPnlUsd.toFixed(2)} net after fees/slippage
        </div>
      )}
      {card.executionBlockReason && (
        <div style={{ fontSize: 11, color: 'var(--warning)', marginBottom: 8, lineHeight: 1.4 }}>
          Execution blocked: {card.executionBlockReason}
        </div>
      )}
      {certificationPending && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
          Certifying executable book before this can be traded.
        </div>
      )}

      {cryptoContext && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 6,
            fontSize: 11,
            marginBottom: 10,
            color: 'var(--text-muted)',
          }}
        >
          <div>
            <div>Momentum</div>
            <div style={{ color: cryptoContext.momentumBps >= 0 ? 'var(--success)' : 'var(--danger)' }}>
              {cryptoContext.momentumBps >= 0 ? '+' : ''}{cryptoContext.momentumBps.toFixed(1)} bps
            </div>
          </div>
          <div>
            <div>Volatility</div>
            <div>{cryptoContext.volatilityBps.toFixed(1)} bps</div>
          </div>
          <div>
            <div>Context</div>
            <div>{cryptoContext.confidence}% · {cryptoContext.sampleCount} ticks</div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 12, marginBottom: 10 }}>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>Market</div>
          <div>{(card.marketPrice * 100).toFixed(0)}¢</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>Implied</div>
          <div>{(card.impliedPrice * 100).toFixed(0)}¢</div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>Net edge</div>
          <div style={{ color: card.netEdge > 0 ? 'var(--success)' : 'var(--danger)' }}>
            {(card.netEdge * 100).toFixed(1)}¢
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--text-muted)' }}>Predict</div>
          <div>{card.predictability}%</div>
        </div>
      </div>

      {showProfitBox && (
        <details
          style={{ marginBottom: 10, background: 'var(--bg)', borderRadius: 8, padding: 8, fontSize: 11 }}
          onClick={(e) => e.stopPropagation()}
        >
          <summary style={{ cursor: 'pointer', fontWeight: 700, color: card.netEdge > 0 ? 'var(--success)' : 'var(--warning)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{card.profitCertificate ? 'Certified profit proof' : 'Profit model and execution checks'}</span>
            {failedCount > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--warning)', background: 'rgba(245,158,11,0.15)', padding: '1px 6px', borderRadius: 4 }}>
                {failedCount} risk{failedCount > 1 ? 's' : ''}
              </span>
            )}
          </summary>

          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Signal narrative */}
            {profitLines.slice(0, 2).map((line) => (
              <div key={line} style={{ color: 'var(--text-muted)', lineHeight: 1.45 }}>{line}</div>
            ))}

            {/* Edge breakdown table */}
            <table style={{ width: '100%', marginTop: 4, marginBottom: 4, borderCollapse: 'collapse' }}>
              <tbody>
                {breakdown.map((row) => (
                  <tr key={row.label}>
                    <td style={{ padding: '2px 0', color: 'var(--text-muted)' }}>{row.label}</td>
                    <td style={{ padding: '2px 4px', textAlign: 'right', color: row.value >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: row.label === 'Net edge' ? 700 : 400 }}>
                      {row.value >= 0 ? '+' : ''}{(row.value * 100).toFixed(1)}¢
                    </td>
                    <td style={{ padding: '2px 0', color: 'var(--text-muted)', fontSize: 10 }}>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Divider */}
            <div style={{ borderTop: '1px solid var(--border)', margin: '2px 0' }} />

            {/* Risk checklist */}
            <div style={{ fontWeight: 700, color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>
              Risk Checklist
            </div>
            {[depthRisk, ...riskItems].map((item) => (
              <div key={item.key} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5 }}>
                  <span style={{ color: item.ok ? 'var(--success)' : 'var(--warning)', flexShrink: 0, marginTop: 1 }}>
                    {item.ok ? '✓' : '⚠'}
                  </span>
                  <span style={{ color: item.ok ? 'var(--text)' : 'var(--warning)', fontWeight: item.ok ? 400 : 600 }}>
                    {item.label}
                  </span>
                </div>
                {!item.ok && item.detail && (
                  <div style={{ color: 'var(--text-muted)', paddingLeft: 14, lineHeight: 1.45 }}>
                    {item.detail}
                  </div>
                )}
              </div>
            ))}

            {/* Signal source lines */}
            {profitLines.slice(2).map((line) => (
              <div key={line} style={{ color: 'var(--text-muted)', lineHeight: 1.45, marginTop: 4 }}>{line}</div>
            ))}
          </div>
        </details>
      )}

      <div style={{ display: 'flex', gap: 4, height: 24, marginBottom: 10 }}>
        {waterfall.map((w) => (
          <div
            key={w.label}
            title={`${w.label}: ${(w.value * 100).toFixed(1)}¢`}
            style={{
              flex: Math.max(0.1, Math.abs(w.value) * 10),
              background: w.color,
              borderRadius: 2,
              opacity: 0.85,
            }}
          />
        ))}
      </div>

      {card.edgeHistory.length > 1 && (
        <svg width="100%" height="24" style={{ marginBottom: 8 }}>
          <polyline
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
            points={card.edgeHistory
              .map((y, i) => `${(i / (card.edgeHistory.length - 1)) * 280},${20 - y * 100}`)
              .join(' ')}
          />
        </svg>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {TRADABLE.has(card.status) && showLiveBuy && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onLiveBuy?.(); }}
            style={{ ...btnStyle, borderColor: 'var(--danger)', color: 'var(--danger)' }}
          >
            Live Buy
          </button>
        )}
        {certifiedPaperBuy && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPaperBuy?.(); }}
            style={{ ...btnStyle, borderColor: 'var(--success)', color: 'var(--success)' }}
          >
            Certified Buy
          </button>
        )}
        {card.netEdge > 0 && showPaperBuy && !certifiedPaperBuy && (
          <button
            type="button"
            disabled
            title={card.executionBlockReason ?? 'Awaiting strict profit certification'}
            onClick={(e) => { e.stopPropagation(); }}
            style={{ ...btnStyle, color: 'var(--text-muted)', opacity: 0.6, cursor: 'not-allowed' }}
          >
            Not Certified
          </button>
        )}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDryRun?.(); }}
          style={btnStyle}
        >
          Dry-Run
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onJournal?.(); }}
          style={btnStyle}
        >
          Journal
        </button>
      </div>
    </div>
  );
});

const btnStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: '4px 10px',
  borderRadius: 6,
  fontSize: 11,
  cursor: 'pointer',
};
