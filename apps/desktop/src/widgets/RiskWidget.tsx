import { useEffect, useState } from 'react';
import { RiskCockpit } from '@nemesis/ui';
import { WidgetShell } from './WidgetShell';

interface PaperState {
  equity: number;
  dailyPnl?: number;
  portfolio: { positions: { entryPrice: number; contracts: number }[] };
}
interface AppState { settings: { dailyLossCapUsd: number } }

export function RiskWidget() {
  const [paper, setPaper] = useState<PaperState | null>(null);
  const [settings, setSettings] = useState<AppState['settings'] | null>(null);

  useEffect(() => {
    window.nemesis.getPaperPortfolio().then((p) => setPaper(p as PaperState));
    window.nemesis.getState().then((s) => setSettings((s as AppState).settings));
    const unsubscribePaper = window.nemesis.onPaperUpdate((d) => setPaper(d as PaperState));
    const unsubscribeSettings = window.nemesis.onSettingsUpdate((s) => setSettings((s as AppState['settings'])));
    return () => {
      unsubscribePaper();
      unsubscribeSettings();
    };
  }, []);

  const deployed = paper?.portfolio.positions.reduce((s, p) => s + p.entryPrice * p.contracts, 0) ?? 0;
  const heatPct = paper && paper.equity > 0 ? (deployed / paper.equity) * 100 : 0;
  const dailyPnl = paper?.dailyPnl ?? 0;
  const dailyLossCap = settings?.dailyLossCapUsd ?? 500;

  return (
    <WidgetShell title="Risk Cockpit">
      <div style={{ overflow: 'auto', flex: 1 }}>
        <RiskCockpit
          deployedPct={heatPct}
          dailyPnl={dailyPnl}
          dailyLossCap={dailyLossCap}
          concentrationWarnings={[]}
          playbookDrawdowns={[]}
        />
      </div>
    </WidgetShell>
  );
}
