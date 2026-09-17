import { memo } from 'react';
import type { GuardrailSettings } from '@nemesis/core';

interface Props {
  settings: GuardrailSettings;
}

export const GuardrailBanner = memo(function GuardrailBanner({ settings }: Props) {
  const modes = [
    settings.demoMode ? 'DEMO' : 'PRODUCTION',
    settings.dryRun ? 'DRY-RUN' : 'LIVE ORDERS',
    settings.killSwitchActive ? 'KILL-SWITCH ACTIVE' : null,
  ].filter(Boolean);

  return (
    <div
      style={{
        background: 'var(--demo-banner)',
        color: '#fed7aa',
        padding: '6px 16px',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '0.08em',
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        borderBottom: '1px solid #9a3412',
      }}
    >
      <span>NEMESIS GUARDRAILS</span>
      {modes.map((m) => (
        <span key={m} style={{ background: 'rgba(0,0,0,0.3)', padding: '2px 8px', borderRadius: 4 }}>
          {m}
        </span>
      ))}
      {!settings.liveEnabled && (
        <span style={{ marginLeft: 'auto', opacity: 0.8 }}>Live trading locked</span>
      )}
    </div>
  );
});
