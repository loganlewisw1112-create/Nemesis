import type { ThesisCard, ThesisDriver } from '@nemesis/core';

interface Props {
  card: ThesisCard | null;
}

export function ExplainMovePanel({ card }: Props) {
  if (!card) {
    return (
      <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>
        Select a thesis to see why the market is moving.
      </div>
    );
  }

  return (
    <div style={{ padding: 12 }}>
      <h3 style={{ fontSize: 13, marginBottom: 8, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
        Explain Move
      </h3>
      <div style={{ fontSize: 12, marginBottom: 8 }}>
        Source: <strong>{card.sourceMove ?? 'unknown'}</strong>
      </div>
      <div style={{ fontSize: 12, marginBottom: 8 }}>{card.signalReason}</div>
      <DriverStack drivers={card.drivers} />
      {card.invalidations.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 600 }}>Invalidations</div>
          {card.invalidations.map((i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--text-muted)' }}>• {i}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DriverStack({ drivers }: { drivers: ThesisDriver[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {drivers.map((d) => (
        <div key={d.label} style={{ display: 'flex', gap: 8, fontSize: 11 }}>
          <div
            style={{
              width: `${d.impact * 100}%`,
              maxWidth: 80,
              height: 4,
              background: 'var(--accent)',
              borderRadius: 2,
              marginTop: 5,
            }}
          />
          <span style={{ fontWeight: 600 }}>{d.label}</span>
          <span style={{ color: 'var(--text-muted)' }}>{d.detail}</span>
        </div>
      ))}
    </div>
  );
}

export function RegimeBanner({ regimes }: { regimes: string[] }) {
  if (regimes.length === 0) return null;
  return (
    <div
      style={{
        background: 'rgba(239,68,68,0.15)',
        border: '1px solid var(--danger)',
        color: '#fca5a5',
        padding: '8px 16px',
        fontSize: 12,
      }}
    >
      No-trade regimes: {regimes.join(', ')}
    </div>
  );
}
