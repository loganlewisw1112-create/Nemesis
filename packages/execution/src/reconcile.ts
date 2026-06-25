export interface LocalPosition {
  ticker: string;
  side: 'yes' | 'no';
  contracts: number;
  avgPrice: number;
}

export interface RemotePosition {
  ticker: string;
  position: number;
  market_exposure: number;
}

export interface ReconcileMismatch {
  ticker: string;
  local: number;
  remote: number;
  detail: string;
}

export function reconcilePositions(
  local: LocalPosition[],
  remote: RemotePosition[],
): ReconcileMismatch[] {
  const mismatches: ReconcileMismatch[] = [];
  const remoteMap = new Map(remote.map((r) => [r.ticker, r.position]));
  for (const l of local) {
    const remotePos = remoteMap.get(l.ticker) ?? 0;
    const localSigned = l.side === 'yes' ? l.contracts : -l.contracts;
    if (localSigned !== remotePos) {
      mismatches.push({
        ticker: l.ticker,
        local: localSigned,
        remote: remotePos,
        detail: 'position mismatch',
      });
    }
  }
  return mismatches;
}
