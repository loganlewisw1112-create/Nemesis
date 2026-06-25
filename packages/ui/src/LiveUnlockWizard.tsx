import { useState } from 'react';
import type { GateStatus } from '@nemesis/core';

interface Props {
  gates: GateStatus[];
  canLive: boolean;
  onUnlock: (confirmText: string) => Promise<{ ok: boolean; error?: string }>;
}

export function LiveUnlockWizard({ gates, canLive, onUnlock }: Props) {
  const [step, setStep] = useState(0);
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<string | null>(null);

  if (!canLive) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Complete all 8 gates before live unlock is available.
        <ul style={{ marginTop: 8, paddingLeft: 16 }}>
          {gates.filter((g) => !g.passed).map((g) => (
            <li key={g.id}>{g.name}: {g.detail}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div style={{ fontSize: 12, border: '1px solid var(--warning)', borderRadius: 8, padding: 12 }}>
      <div style={{ fontWeight: 700, color: 'var(--warning)', marginBottom: 8 }}>Live unlock wizard</div>
      {step === 0 && (
        <>
          <p>All gates passed. Live trading uses real money on Kalshi.</p>
          <button type="button" style={btnStyle} onClick={() => setStep(1)}>Continue</button>
        </>
      )}
      {step === 1 && (
        <>
          <p>Type <strong>ENABLE LIVE</strong> to confirm:</p>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
          <button
            type="button"
            style={{ ...btnStyle, marginLeft: 8 }}
            onClick={async () => {
              const res = await onUnlock(confirm);
              setResult(res.ok ? 'Live mode enabled.' : res.error ?? 'Failed');
            }}
          >
            Unlock live
          </button>
          {result && <div style={{ marginTop: 8 }}>{result}</div>}
        </>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'var(--danger)',
  border: 'none',
  color: '#fff',
  padding: '6px 12px',
  borderRadius: 6,
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: 6,
  borderRadius: 4,
};
