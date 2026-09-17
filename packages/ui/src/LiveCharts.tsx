import { memo } from 'react';
import type { PriceTick, PaperPosition } from '@nemesis/core';
import {
  buildLinePath,
  computeVolatility,
  priceChangePct,
  unrealizedPnlSeries,
  formatCents,
} from '@nemesis/charts';
import { ChartPanel } from './ChartPanel.js';

interface LiveChartsProps {
  ticker: string;
  ticks: PriceTick[];
  position?: PaperPosition | null;
  width?: number;
  height?: number;
}

export const TicketLiveCharts = memo(function TicketLiveCharts({ ticker, ticks, position, width = 248, height = 72 }: LiveChartsProps) {
  if (ticks.length === 0) {
    return (
      <div style={{ padding: 12, fontSize: 11, color: 'var(--text-muted)' }}>
        Collecting live ticks for {ticker}...
      </div>
    );
  }

  const prices = ticks.map((t) => t.yesPrice);
  const spreads = ticks.map((t) => t.spread * 100);
  const edges = ticks.map((t) => t.netEdge * 100);
  const vol = computeVolatility(prices);
  const chg = priceChangePct(ticks);
  const pnlSeries = position
    ? unrealizedPnlSeries(ticks, position.entryPrice, position.contracts, position.side, position.fees)
    : [];

  return (
    <div style={{ padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{ticker}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
        {formatCents(prices[prices.length - 1])} · vol {vol.toFixed(2)}% · {chg >= 0 ? '+' : ''}{chg.toFixed(2)}%
      </div>

      <ChartPanel
        title="Price"
        subtitle={formatCents(prices[prices.length - 1])}
        path={buildLinePath(prices, width, height)}
        color={chg >= 0 ? 'var(--success)' : 'var(--danger)'}
        width={width}
        height={height}
      />

      <ChartPanel
        title="Spread"
        subtitle={`${spreads[spreads.length - 1]?.toFixed(1)}¢`}
        path={buildLinePath(spreads, width, height)}
        color="var(--warning)"
        width={width}
        height={height}
      />

      <ChartPanel
        title="Net Edge"
        subtitle={`${edges[edges.length - 1]?.toFixed(1)}¢`}
        path={buildLinePath(edges, width, height)}
        color="var(--accent)"
        width={width}
        height={height}
        baseline={0}
      />

      {position && pnlSeries.length > 0 && (
        <ChartPanel
          title="Unrealized P&L"
          subtitle={`$${pnlSeries[pnlSeries.length - 1]?.toFixed(2)}`}
          path={buildLinePath(pnlSeries, width, height)}
          color={pnlSeries[pnlSeries.length - 1] >= 0 ? 'var(--success)' : 'var(--danger)'}
          width={width}
          height={height}
          baseline={0}
        />
      )}
    </div>
  );
});
