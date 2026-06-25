import { useEffect, useState } from 'react';
import type { GateStatus } from '@nemesis/core';
import { GuardrailCockpit } from '@nemesis/ui';
import { WidgetShell } from './WidgetShell';

interface AppState { gates: GateStatus[] }

export function GatesWidget() {
  const [gates, setGates] = useState<GateStatus[]>([]);

  useEffect(() => {
    window.nemesis.getState().then((s) => setGates((s as AppState).gates ?? []));
    window.nemesis.onMarketsUpdate((d) => {
      const data = d as { gates?: GateStatus[] };
      if (data.gates) setGates(data.gates);
    });
  }, []);

  return (
    <WidgetShell title="Gate Status">
      <div style={{ overflow: 'auto', flex: 1 }}>
        {gates.length > 0 ? (
          <GuardrailCockpit gates={gates} />
        ) : (
          <div style={{ padding: 16, fontSize: 11, color: 'var(--text-muted)' }}>Loading gates…</div>
        )}
      </div>
    </WidgetShell>
  );
}
