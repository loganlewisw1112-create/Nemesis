import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRealtimeSeries } from './useRealtimeSeries';

function Probe({
  scopeKey,
  sampleKey,
  values,
  maxPoints = 3,
  staleAfterMs = 1000,
}: {
  scopeKey: string;
  sampleKey: string | number;
  values: Record<string, number | null | undefined>;
  maxPoints?: number;
  staleAfterMs?: number;
}) {
  const state = useRealtimeSeries({ scopeKey, sampleKey, values, maxPoints, staleAfterMs });

  return (
    <output>
      {JSON.stringify({
        series: state.series,
        stale: state.stale,
        lastUpdatedAt: state.lastUpdatedAt,
      })}
    </output>
  );
}

function readState() {
  return JSON.parse(screen.getByRole('status').textContent ?? '{}') as {
    series: Record<string, number[]>;
    stale: boolean;
    lastUpdatedAt: number | null;
  };
}

describe('useRealtimeSeries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  it('caps each metric series at maxPoints', () => {
    const { rerender } = render(<Probe scopeKey="KXTEST" sampleKey={1} values={{ probability: 0.51 }} />);

    rerender(<Probe scopeKey="KXTEST" sampleKey={2} values={{ probability: 0.52 }} />);
    rerender(<Probe scopeKey="KXTEST" sampleKey={3} values={{ probability: 0.53 }} />);
    rerender(<Probe scopeKey="KXTEST" sampleKey={4} values={{ probability: 0.54 }} />);

    expect(readState().series.probability).toEqual([0.52, 0.53, 0.54]);
  });

  it('ignores invalid values without dropping valid metrics from the same sample', () => {
    render(<Probe scopeKey="KXTEST" sampleKey="sample-1" values={{ probability: Number.NaN, edge: 0.08, spread: Infinity }} />);

    expect(readState().series).toEqual({ edge: [0.08] });
  });

  it('resets collected series when the scope key changes', () => {
    const { rerender } = render(<Probe scopeKey="KXOLD" sampleKey={1} values={{ probability: 0.51 }} />);

    rerender(<Probe scopeKey="KXOLD" sampleKey={2} values={{ probability: 0.52 }} />);
    rerender(<Probe scopeKey="KXNEW" sampleKey={3} values={{ probability: 0.61, edge: 0.04 }} />);

    expect(readState().series).toEqual({ probability: [0.61], edge: [0.04] });
  });

  it('marks the series stale when updates stop past staleAfterMs', () => {
    render(<Probe scopeKey="KXTEST" sampleKey={1} values={{ probability: 0.51 }} staleAfterMs={500} />);

    expect(readState().stale).toBe(false);

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(readState().stale).toBe(true);
  });
});
