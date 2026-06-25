import type { CSSProperties } from 'react';
import type { KalshiOrderbookSnapshotRecord } from '@nemesis/connectors';

interface OrderbookHeatViewProps {
  snapshots: KalshiOrderbookSnapshotRecord[];
}

type HeatLevel = {
  price: number;
  quantity: number;
};

export function OrderbookHeatView({ snapshots }: OrderbookHeatViewProps) {
  const latest = snapshots[0] ?? null;
  const yes = parseLevels(latest?.yes_levels_json);
  const no = parseLevels(latest?.no_levels_json);
  const maxQty = Math.max(1, ...yes.map((l) => l.quantity), ...no.map((l) => l.quantity));

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <h2 style={titleStyle}>Orderbook Heat</h2>
        <span style={metaStyle}>{latest ? latest.ticker : 'No tape'}</span>
      </div>
      {!latest ? (
        <div style={emptyStyle}>Waiting for orderbook snapshots.</div>
      ) : (
        <div style={gridStyle}>
          <HeatColumn label="YES" levels={yes} maxQty={maxQty} tint="rgba(74, 222, 128," />
          <HeatColumn label="NO" levels={no} maxQty={maxQty} tint="rgba(96, 165, 250," />
        </div>
      )}
    </div>
  );
}

function HeatColumn({
  label,
  levels,
  maxQty,
  tint,
}: {
  label: string;
  levels: HeatLevel[];
  maxQty: number;
  tint: string;
}) {
  return (
    <div>
      <div style={columnLabelStyle}>{label}</div>
      {levels.slice(0, 8).map((level) => {
        const intensity = Math.max(0.12, Math.min(0.85, level.quantity / maxQty));
        return (
          <div key={`${label}-${level.price}-${level.quantity}`} style={{
            ...rowStyle,
            background: `${tint} ${intensity})`,
          }}>
            <span>{level.price.toFixed(2)}</span>
            <strong>{level.quantity}</strong>
          </div>
        );
      })}
    </div>
  );
}

function parseLevels(raw: string | undefined): HeatLevel[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const level = row as Partial<HeatLevel>;
        if (typeof level.price !== 'number' || typeof level.quantity !== 'number') return null;
        return { price: level.price, quantity: level.quantity };
      })
      .filter((level): level is HeatLevel => level !== null);
  } catch {
    return [];
  }
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
const gridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const columnLabelStyle: CSSProperties = { fontSize: 10, color: 'var(--text-muted)', letterSpacing: 1, marginBottom: 6 };
const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '6px 8px',
  marginBottom: 4,
  borderRadius: 4,
  color: '#f8fafc',
  fontSize: 12,
};
const emptyStyle: CSSProperties = { color: 'var(--text-muted)', fontSize: 12 };
