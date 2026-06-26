import { useState, type CSSProperties } from 'react';
import type { GateStatus, LiveUnlockEvaluation } from '@nemesis/core';

interface Props {
  gates: GateStatus[];
  canLive: boolean;
  liveUnlock?: Pick<LiveUnlockEvaluation, 'targetStage' | 'blockers'>;
  onUnlock: (confirmText: string) => Promise<{ ok: boolean; error?: string }>;
}

export function LiveUnlockWizard({ gates, canLive, liveUnlock, onUnlock }: Props) {
  const [step, setStep] = useState(0);
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const targetStage = liveUnlock?.targetStage ?? 'manual-live';
  const confirmPhrase = targetStage === 'auto-live' ? 'ENABLE LIVE AUTO' : 'ENABLE LIVE MANUAL';
  const stageLabel = targetStage === 'auto-live' ? 'live auto trading' : 'live manual trading';
  const blockers = (liveUnlock?.blockers ?? [])
    .filter((blocker) => !blocker.startsWith('Type ENABLE LIVE'));

  if (!canLive) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Complete staged requirements before {stageLabel} unlock is available.
        <ul style={{ marginTop: 8, paddingLeft: 16 }}>
          {(blockers.length > 0 ? blockers : gates.filter((g) => !g.passed).map((g) => `${g.name}: ${g.detail}`)).map((blocker) => (
            <li key={blocker}>{blocker}</li>
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
          <p>{targetStage === 'auto-live' ? 'Manual live, shadow auto, and tiny pilot checks passed.' : 'Paper evaluation certificate passed.'} This unlocks {stageLabel}.</p>
          <button type="button" style={btnStyle} onClick={() => setStep(1)}>Continue</button>
        </>
      )}
      {step === 1 && (
        <>
          <p>Type <strong>{confirmPhrase}</strong> to confirm:</p>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
          <button
            type="button"
            style={{ ...btnStyle, marginLeft: 8 }}
            onClick={async () => {
              const res = await onUnlock(confirm);
              setResult(res.ok ? `${stageLabel} enabled.` : res.error ?? 'Failed');
            }}
          >
            Unlock {stageLabel}
          </button>
          {result && <div style={{ marginTop: 8 }}>{result}</div>}
        </>
      )}
    </div>
  );
}

const btnStyle: CSSProperties = {
  background: 'var(--danger)',
  border: 'none',
  color: '#fff',
  padding: '6px 12px',
  borderRadius: 6,
  cursor: 'pointer',
};

const inputStyle: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: 6,
  borderRadius: 4,
};