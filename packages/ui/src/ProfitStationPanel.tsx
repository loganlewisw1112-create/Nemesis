import { memo } from 'react';
import type { AutoCloseDecision, PaperPortfolio } from '@nemesis/core';
import {
  buildLinePath,
  buildEquityCurve,
  profitSeries,
  pctReturnSeries,
  deployedSeries,
  cashSeries,
  profitMetrics,
  computeFillQuality,
  depthLadderFromTrades,
  playbookAttribution,
  portfolioFeeWaterfall,
  type EquityPoint,
} from '@nemesis/charts';
import { ChartPanel } from './ChartPanel.js';

interface Props {
  portfolio: PaperPortfolio;
  equity: number;
  unrealized: number;
  equityHistory: EquityPoint[];
  autoCloseDecisions?: AutoCloseDecision[];
}

const CHART_WIDTH = 400;
const HERO_HEIGHT = 160;
const MINI_HEIGHT = 72;

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function pnlColor(value: number): string {
  return value >= 0 ? 'var(--success)' : 'var(--danger)';
}

function StatCard({ label, value, color = 'var(--text)' }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--bg-card)', borderRadius: 8, padding: 10, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

export const ProfitStationPanel = memo(function ProfitStationPanel({ portfolio, equity, unrealized, equityHistory, autoCloseDecisions = [] }: Props) {
  const points = equityHistory.length > 0
    ? equityHistory
    : [{ t: Date.now(), equity, deployed: 0, cash: portfolio.cash }];
  const metrics = profitMetrics(points, portfolio.startingCash, unrealized, portfolio.realizedPnl);
  const hasHistory = points.length >= 2;
  const collecting = !hasHistory ? 'Collecting data...' : undefined;
  const fillQuality = computeFillQuality(portfolio.trades);
  const ladder = depthLadderFromTrades(portfolio.trades);
  const attribution = playbookAttribution(portfolio.trades, portfolio.positions);
  const fees = portfolioFeeWaterfall(portfolio.trades);
  const autoCloseTrades = portfolio.trades.filter((t) => t.type === 'close' && t.autoCloseAction);
  const autoCloseRealized = autoCloseTrades.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0);
  const autoCloseSaved = autoCloseTrades.reduce((sum, trade) => sum + Math.max(0, trade.pnl ?? 0), 0);
  const autoCloseRegret = autoCloseDecisions.reduce((sum, d) => sum + Math.max(0, d.peakPnlUsd - d.currentPnlUsd), 0);
  const missedUpside = autoCloseDecisions.reduce((sum, d) => sum + Math.max(0, d.peakPnlUsd - d.currentPnlUsd), 0);

  const equityPath = buildEquityCurve(points, CHART_WIDTH, HERO_HEIGHT);
  const profitVals = profitSeries(points, portfolio.startingCash);
  const deployedVals = deployedSeries(points);
  const cashVals = cashSeries(points);
  const pctVals = pctReturnSeries(points, portfolio.startingCash);
  const lastProfit = profitVals[profitVals.length - 1] ?? 0;
  const lastDeployed = deployedVals[deployedVals.length - 1] ?? 0;
  const lastCash = cashVals[cashVals.length - 1] ?? portfolio.cash;
  const lastPct = pctVals[pctVals.length - 1] ?? 0;

  return (
    <div>
      <h1 style={{ fontSize: 18, marginBottom: 12 }}>Profit Station</h1>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 16 }}>
        <StatCard label="Equity" value={formatUsd(metrics.equity)} color="var(--accent)" />
        <StatCard label="Total P&L" value={formatUsd(metrics.totalPnl)} color={pnlColor(metrics.totalPnl)} />
        <StatCard label="Return" value={formatPct(metrics.pctReturn)} color={pnlColor(metrics.pctReturn)} />
        <StatCard label="Cash" value={formatUsd(metrics.cash)} />
        <StatCard label="In trades" value={formatUsd(metrics.deployed)} />
      </div>

      <ChartPanel
        title="Equity"
        subtitle={collecting ?? formatUsd(metrics.equity)}
        path={equityPath}
        color={metrics.totalPnl >= 0 ? 'var(--success)' : 'var(--danger)'}
        width={CHART_WIDTH}
        height={HERO_HEIGHT}
        marginBottom={16}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <ChartPanel title="Total P&L" subtitle={collecting ?? formatUsd(lastProfit)} path={hasHistory ? buildLinePath(profitVals, CHART_WIDTH, MINI_HEIGHT) : ''} color={pnlColor(lastProfit)} width={CHART_WIDTH} height={MINI_HEIGHT} baseline={0} marginBottom={0} />
        <ChartPanel title="Capital in trades" subtitle={collecting ?? formatUsd(lastDeployed)} path={hasHistory ? buildLinePath(deployedVals, CHART_WIDTH, MINI_HEIGHT) : ''} color="var(--warning)" width={CHART_WIDTH} height={MINI_HEIGHT} marginBottom={0} />
        <ChartPanel title="Cash" subtitle={collecting ?? formatUsd(lastCash)} path={hasHistory ? buildLinePath(cashVals, CHART_WIDTH, MINI_HEIGHT) : ''} color="var(--accent)" width={CHART_WIDTH} height={MINI_HEIGHT} marginBottom={0} />
        <ChartPanel title="Return %" subtitle={collecting ?? formatPct(lastPct)} path={hasHistory ? buildLinePath(pctVals, CHART_WIDTH, MINI_HEIGHT) : ''} color={pnlColor(lastPct)} width={CHART_WIDTH} height={MINI_HEIGHT} baseline={0} marginBottom={0} />
      </div>

      <h2 style={sectionTitle}>Fill quality</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
        <StatCard label="Avg slippage" value={`${(fillQuality.avgSlippage * 100).toFixed(2)}¢`} />
        <StatCard label="Avg shortfall" value={formatUsd(fillQuality.avgShortfall)} />
        <StatCard label="Abort rate" value={`${(fillQuality.abortRate * 100).toFixed(0)}%`} />
        <StatCard label="Fills" value={String(fillQuality.fillCount)} />
      </div>

      <h2 style={sectionTitle}>Auto-close attribution</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 }}>
        <StatCard label="Saved profit" value={formatUsd(autoCloseSaved)} color={pnlColor(autoCloseSaved)} />
        <StatCard label="Close regret" value={formatUsd(autoCloseRegret)} color={autoCloseRegret > 0 ? 'var(--warning)' : 'var(--text)' } />
        <StatCard label="Missed upside" value={formatUsd(missedUpside)} color={missedUpside > 0 ? 'var(--warning)' : 'var(--text)' } />
        <StatCard label="Auto realized" value={formatUsd(autoCloseRealized)} color={pnlColor(autoCloseRealized)} />
      </div>

      {ladder.length > 0 && (
        <>
          <h2 style={sectionTitle}>Depth ladder (recent fills)</h2>
          <div style={{ marginBottom: 16 }}>
            {ladder.map((row) => (
              <div key={row.label} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 11 }}>
                <span style={{ minWidth: 140 }}>{row.label}</span>
                <div style={{ flex: 1, display: 'flex', gap: 2, height: 20 }}>
                  <div style={{ flex: row.expected * 100, background: 'var(--border)', borderRadius: 2 }} title={`Expected ${(row.expected * 100).toFixed(1)}¢`} />
                  <div style={{ flex: row.filled * 100, background: row.slippage > 0.01 ? 'var(--danger)' : 'var(--success)', borderRadius: 2 }} title={`Filled ${(row.filled * 100).toFixed(1)}¢`} />
                </div>
                <span style={{ color: 'var(--text-muted)' }}>{(row.slippage * 100).toFixed(2)}¢ slip</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 style={sectionTitle}>Portfolio fee waterfall</h2>
      <div style={{ display: 'flex', gap: 4, height: 28, marginBottom: 16 }}>
        <div style={{ flex: Math.max(0.1, Math.abs(fees.grossPnl)), background: '#22c55e', borderRadius: 2 }} title={`Gross ${formatUsd(fees.grossPnl)}`} />
        <div style={{ flex: Math.max(0.1, fees.feesPaid), background: '#f97316', borderRadius: 2 }} title={`Fees ${formatUsd(fees.feesPaid)}`} />
        <div style={{ flex: Math.max(0.1, Math.abs(fees.netPnl)), background: '#6366f1', borderRadius: 2 }} title={`Net ${formatUsd(fees.netPnl)}`} />
      </div>

      {attribution.length > 0 && (
        <>
          <h2 style={sectionTitle}>Playbook attribution</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
            {attribution.map((a) => (
              <div key={a.playbook} style={{ background: 'var(--bg-card)', borderRadius: 8, padding: 10, fontSize: 11 }}>
                <div style={{ fontWeight: 600 }}>{a.playbook}</div>
                <div style={{ color: pnlColor(a.realizedPnl) }}>{formatUsd(a.realizedPnl)} · {a.tradeCount} closes</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
        <div style={detailCardStyle}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>Realized P&L</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: pnlColor(metrics.realizedPnl) }}>{formatUsd(metrics.realizedPnl)}</div>
        </div>
        <div style={detailCardStyle}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>Unrealized P&L</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: pnlColor(metrics.unrealized) }}>{formatUsd(metrics.unrealized)}</div>
        </div>
      </div>
    </div>
  );
});

const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  marginBottom: 8,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
};

const detailCardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  borderRadius: 8,
  padding: 12,
};
