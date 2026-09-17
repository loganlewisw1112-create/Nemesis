import { useEffect, useState } from 'react';
import { buildLinePath } from '@nemesis/charts';
import { ChartPanel } from '@nemesis/ui';
import { WidgetShell } from './WidgetShell';
import { useContainerSize } from './useContainerSize';

interface EquityPoint { t: number; equity: number; deployed: number; cash: number; }

interface PaperState {
  equity: number;
  dailyPnl?: number;
  equityHistory: EquityPoint[];
}

export function PnlWidget() {
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [chartRef, chartSize] = useContainerSize(220, 50);

  useEffect(() => {
    window.nemesis.getPaperPortfolio().then((p) => setPaper(p as PaperState));
    return window.nemesis.onPaperUpdate((d) => setPaper(d as PaperState));
  }, []);

  const pnl = paper?.dailyPnl ?? 0;
  const equity = paper?.equity ?? 0;
  const history = paper?.equityHistory ?? [];
  const equitySeries = history.map((p) => p.equity);
  const path = equitySeries.length >= 2 ? buildLinePath(equitySeries, chartSize.w, chartSize.h) : '';
  const chartColor = pnl >= 0 ? 'var(--success)' : 'var(--danger)';

  return (
    <WidgetShell title="P&L Monitor">
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: 'clamp(18px, 4vw, 28px)', fontWeight: 800, color: pnl >= 0 ? 'var(--success)' : 'var(--danger)', fontVariantNumeric: 'tabular-nums' }}>
            {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>today</span>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Equity <span style={{ color: 'var(--text)', fontWeight: 600 }}>${equity.toFixed(2)}</span>
        </div>

        {/* Sparkline */}
        <div ref={chartRef} style={{ flex: 1, minHeight: 40 }}>
          {path && (
            <ChartPanel
              title=""
              path={path}
              color={chartColor}
              width={chartSize.w}
              height={chartSize.h}
              marginBottom={0}
            />
          )}
          {!path && (
            <div style={{ fontSize: 10, color: 'var(--border)', paddingTop: 8, textAlign: 'center' }}>
              Waiting for equity history…
            </div>
          )}
        </div>
      </div>
    </WidgetShell>
  );
}
