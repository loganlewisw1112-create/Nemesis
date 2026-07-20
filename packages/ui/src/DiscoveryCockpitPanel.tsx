import { memo } from 'react';
import type { DiscoveryState } from '@nemesis/core';

interface Props {
  state: DiscoveryState;
  onPreset: (preset: 'conservative' | 'balanced' | 'aggressive') => void;
  onToggle: (key: 'depthVerifyEnabled' | 'signalPassEnabled', value: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onForceUniverse: () => void;
  onForceDepth: () => void;
}

const PRESET_LABELS = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
} as const;

export const DiscoveryCockpitPanel = memo(function DiscoveryCockpitPanel({
  state,
  onPreset,
  onToggle,
  onPause,
  onResume,
  onForceUniverse,
  onForceDepth,
}: Props) {
  const { settings, metrics } = state;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 560 }}>
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Discovery Cockpit</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Mode: <strong style={{ color: 'var(--text)' }}>{metrics.mode}</strong>
          {metrics.paused ? ' · paused' : ''}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
        <Stat label="Universe" value={`${metrics.trackedTickers} tracked · ${metrics.universeAgeSec}s ago`} />
        <Stat label="Depth queue" value={`${metrics.depthPending} pending · ${metrics.depthVerifiedCycle} verified`} />
        <Stat label="Tier yield" value={`${metrics.scoutCount} scout · ${metrics.solidCount} solid · ${metrics.whaleCount} whale`} />
        <Stat label="API budget" value={`${metrics.orderbooksThisCycle}/${metrics.orderbookBudget} books · ${metrics.avgBookMs}ms avg`} />
        <Stat label="Below scout" value={String(metrics.belowScout)} />
        <Stat label="Targets" value={`${settings.scoutTarget} / ${settings.solidTarget} / ${settings.whaleTarget}`} />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(['conservative', 'balanced', 'aggressive'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPreset(p)}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: `1px solid ${settings.preset === p ? 'var(--accent)' : 'var(--border)'}`,
              background: settings.preset === p ? 'var(--bg-elevated)' : 'transparent',
              color: 'var(--text)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={settings.depthVerifyEnabled}
          onChange={(e) => onToggle('depthVerifyEnabled', e.target.checked)}
        />
        Depth-verify before display
      </label>
      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={settings.signalPassEnabled}
          onChange={(e) => onToggle('signalPassEnabled', e.target.checked)}
        />
        Signal pass (pods + feeds)
      </label>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {metrics.paused ? (
          <button type="button" onClick={onResume} style={btnStyle}>Resume discovery</button>
        ) : (
          <button type="button" onClick={onPause} style={btnStyle}>Pause discovery</button>
        )}
        <button type="button" onClick={onForceUniverse} style={btnStyle}>Refresh universe</button>
        <button type="button" onClick={onForceDepth} style={btnStyle}>Run depth pass</button>
      </div>
    </div>
  );
});

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--bg-card)', padding: 10, borderRadius: 8, border: '1px solid var(--border)' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const btnStyle = {
  padding: '8px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-card)',
  color: 'var(--text)',
  fontSize: 11,
  cursor: 'pointer',
} as const;
