import { useEffect, useState } from 'react';
import type { DiscoveryState } from '@nemesis/core';
import { WidgetShell } from './WidgetShell';

export function ScoutWidget() {
  const [state, setState] = useState<DiscoveryState | null>(null);

  useEffect(() => {
    window.nemesis.getDiscoveryState().then((d) => setState(d as DiscoveryState));
    window.nemesis.onDiscoveryUpdate((d) => setState(d as DiscoveryState));
  }, []);

  const m = state?.metrics;

  return (
    <WidgetShell title="Universe Scout">
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, overflow: 'auto' }}>
        {m ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <StatCard label="Universe" value={m.trackedTickers} unit="markets" />
              <StatCard label="Depth Queue" value={m.depthPending} unit="pending" />
            </div>

            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Tier Yields
            </div>

            <TierBar label="Scout" count={m.scoutCount} max={Math.max(1, m.trackedTickers)} color="var(--success)" />
            <TierBar label="Solid" count={m.solidCount} max={Math.max(1, m.trackedTickers)} color="var(--accent)" />
            <TierBar label="Whale" count={m.whaleCount} max={Math.max(1, m.trackedTickers)} color="var(--warning)" />

            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              Mode: <span style={{ color: m.paused ? 'var(--warning)' : 'var(--success)', fontWeight: 600 }}>{m.mode}</span>
              {' · '}Avg book {m.avgBookMs}ms
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading discovery…</div>
        )}
      </div>
    </WidgetShell>
  );
}

function StatCard({ label, value, unit }: { label: string; value: number; unit: string }) {
  return (
    <div style={{ background: 'var(--bg)', borderRadius: 6, padding: '6px 8px' }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 'clamp(16px, 4vw, 24px)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{unit}</div>
    </div>
  );
}

function TierBar({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  const pct = Math.min(100, (count / max) * 100);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
        <span style={{ color: 'var(--text-muted)' }}>{label}</span>
        <span style={{ color, fontWeight: 600 }}>{count}</span>
      </div>
      <div style={{ height: 5, background: 'var(--border)', borderRadius: 3 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}
