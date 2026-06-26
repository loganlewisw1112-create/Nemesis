import { useEffect, useMemo, useRef, useState } from 'react';

export type RealtimeSeriesValue = number | null | undefined;

export interface RealtimeSeriesOptions {
  scopeKey: string;
  sampleKey: string | number;
  values: Record<string, RealtimeSeriesValue>;
  maxPoints?: number;
  staleAfterMs?: number;
  now?: () => number;
}

export interface RealtimeSeriesState {
  series: Record<string, number[]>;
  stale: boolean;
  lastUpdatedAt: number | null;
}

export function useRealtimeSeries({
  scopeKey,
  sampleKey,
  values,
  maxPoints = 60,
  staleAfterMs = 10_000,
  now = Date.now,
}: RealtimeSeriesOptions): RealtimeSeriesState {
  const [series, setSeries] = useState<Record<string, number[]>>({});
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => now());
  const previousScope = useRef(scopeKey);
  const previousSample = useRef<string | number | null>(null);

  const finiteValues = useMemo(
    () => Object.entries(values).filter((entry): entry is [string, number] => Number.isFinite(entry[1])),
    [values],
  );

  useEffect(() => {
    const intervalMs = Math.max(100, Math.min(staleAfterMs, 1_000));
    const interval = window.setInterval(() => setClock(now()), intervalMs);
    return () => window.clearInterval(interval);
  }, [now, staleAfterMs]);

  useEffect(() => {
    const scopeChanged = previousScope.current !== scopeKey;
    if (!scopeChanged && previousSample.current === sampleKey) return;

    previousScope.current = scopeKey;
    previousSample.current = sampleKey;
    if (finiteValues.length === 0) {
      if (scopeChanged) setSeries({});
      return;
    }

    const updatedAt = now();
    const pointLimit = Math.max(1, Math.floor(maxPoints));
    setSeries((current) => {
      const next: Record<string, number[]> = scopeChanged ? {} : { ...current };
      for (const [metric, value] of finiteValues) {
        next[metric] = [...(next[metric] ?? []), value].slice(-pointLimit);
      }
      return next;
    });
    setLastUpdatedAt(updatedAt);
    setClock(updatedAt);
  }, [finiteValues, maxPoints, now, sampleKey, scopeKey]);

  return {
    series,
    stale: lastUpdatedAt === null ? true : clock - lastUpdatedAt >= staleAfterMs,
    lastUpdatedAt,
  };
}
