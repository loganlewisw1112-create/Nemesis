import type { CSSProperties } from 'react';
import type { PublicDataMeshState } from '@nemesis/connectors';

interface DataFreshnessBoardProps {
  state: PublicDataMeshState | null;
}

export function DataFreshnessBoard({ state }: DataFreshnessBoardProps) {
  const rows = state?.freshness ?? [];
  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <h2 style={titleStyle}>DATA FRESHNESS</h2>
        <span style={metaStyle}>{rows.length} sources</span>
      </div>
      {rows.length === 0 ? (
        <div style={emptyStyle}>Waiting for public data sources.</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.slice(0, 10).map((row) => (
            <div key={row.source_id} style={rowStyle}>
              <div>
                <div style={nameStyle}>{row.name}</div>
                <div style={subStyle}>Tier {row.trust_tier} / {formatAge(row.age_ms)}</div>
              </div>
              <span style={{
                ...badgeStyle,
                color: row.stale ? '#fbbf24' : 'var(--success)',
                borderColor: row.stale ? '#fbbf24' : 'var(--success)',
                background: row.stale ? 'rgba(251, 191, 36, 0.1)' : 'rgba(74, 222, 128, 0.1)',
              }}>
                {row.stale ? 'STALE' : 'FRESH'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'never';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m`;
  return `${Math.round(ageMs / 3_600_000)}h`;
}

const panelStyle: CSSProperties = {
  padding: 16,
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 8,
};
const headerStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 };
const titleStyle: CSSProperties = { fontSize: 13, margin: 0, textTransform: 'uppercase', letterSpacing: 1 };
const metaStyle: CSSProperties = { fontSize: 11, color: 'var(--text-muted)' };
const emptyStyle: CSSProperties = { color: 'var(--text-muted)', fontSize: 12 };
const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  padding: '8px 0',
  borderTop: '1px solid var(--border)',
};
const nameStyle: CSSProperties = { fontSize: 12, fontWeight: 700 };
const subStyle: CSSProperties = { fontSize: 10, color: 'var(--text-muted)', marginTop: 2 };
const badgeStyle: CSSProperties = {
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1,
  flexShrink: 0,
};
