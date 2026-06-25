import type { GateStatus } from '@nemesis/core';

interface Props {
  gates: GateStatus[];
}

export function GuardrailCockpit({ gates }: Props) {
  return (
    <div style={{ padding: 12 }}>
      <h3 style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
        Guardrail Cockpit
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {gates.map((g) => (
          <div
            key={g.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              background: 'var(--bg-card)',
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            <span style={{ color: g.passed ? 'var(--success)' : 'var(--danger)' }}>
              {g.passed ? '✓' : '○'}
            </span>
            <span style={{ fontWeight: 600, minWidth: 110 }}>{g.name}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{g.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
