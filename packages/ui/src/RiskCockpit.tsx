interface Props {
  deployedPct: number;
  dailyPnl: number;
  dailyLossCap: number;
  concentrationWarnings: string[];
  playbookDrawdowns: { playbook: string; pnl: number }[];
}

export function RiskCockpit({
  deployedPct,
  dailyPnl,
  dailyLossCap,
  concentrationWarnings,
  playbookDrawdowns,
}: Props) {
  const dailyUsed = dailyLossCap > 0 ? Math.min(100, (Math.abs(Math.min(0, dailyPnl)) / dailyLossCap) * 100) : 0;

  return (
    <div style={{ padding: 12, borderTop: '1px solid var(--border)' }}>
      <h3 style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
        Risk Cockpit
      </h3>

      <MetricBar label="Portfolio heat" value={deployedPct} max={100} unit="%" />
      <MetricBar label="Daily loss used" value={dailyUsed} max={100} unit="%" danger={dailyUsed >= 100} />

      <div style={{ fontSize: 11, marginTop: 8, color: 'var(--text-muted)' }}>
        Daily P&L: <span style={{ color: dailyPnl >= 0 ? 'var(--success)' : 'var(--danger)' }}>${dailyPnl.toFixed(2)}</span>
        {' '}/ cap ${dailyLossCap.toFixed(2)}
      </div>

      {concentrationWarnings.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--warning)' }}>
          {concentrationWarnings.map((w) => (
            <div key={w}>⚠ {w}</div>
          ))}
        </div>
      )}

      {playbookDrawdowns.filter((p) => p.pnl < 0).slice(0, 3).map((p) => (
        <div key={p.playbook} style={{ fontSize: 11, marginTop: 4, color: 'var(--danger)' }}>
          {p.playbook}: ${p.pnl.toFixed(2)}
        </div>
      ))}
    </div>
  );
}

function MetricBar({
  label,
  value,
  max,
  unit,
  danger,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  danger?: boolean;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span>{value.toFixed(0)}{unit}</span>
      </div>
      <div style={{ height: 6, background: 'var(--border)', borderRadius: 3 }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: danger ? 'var(--danger)' : pct > 70 ? 'var(--warning)' : 'var(--accent)',
            borderRadius: 3,
          }}
        />
      </div>
    </div>
  );
}
