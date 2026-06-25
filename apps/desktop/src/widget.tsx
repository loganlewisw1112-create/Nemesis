import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../packages/ui/src/styles/tokens.css';
import { PnlWidget } from './widgets/PnlWidget';
import { RiskWidget } from './widgets/RiskWidget';
import { TickerWidget } from './widgets/TickerWidget';
import { GatesWidget } from './widgets/GatesWidget';
import { ScoutWidget } from './widgets/ScoutWidget';
import { WorldWidget } from './widgets/WorldWidget';

const type = new URLSearchParams(window.location.search).get('widget') ?? 'pnl';

const WIDGETS: Record<string, React.ComponentType> = {
  pnl: PnlWidget,
  risk: RiskWidget,
  ticker: TickerWidget,
  gates: GatesWidget,
  scout: ScoutWidget,
  world: WorldWidget,
};

const Widget = WIDGETS[type] ?? PnlWidget;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
