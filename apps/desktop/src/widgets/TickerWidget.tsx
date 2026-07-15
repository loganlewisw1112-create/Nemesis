import { useEffect, useRef, useState } from 'react';
import type { PriceTick } from '@nemesis/core';
import { TicketLiveCharts } from '@nemesis/ui';
import { WidgetShell } from './WidgetShell';

export function TickerWidget() {
  const [ticker, setTicker] = useState('');
  const [activeTicker, setActiveTicker] = useState('');
  const [ticks, setTicks] = useState<PriceTick[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return window.nemesis.onTicksUpdate((d) => {
      const data = d as { ticker: string; ticks: PriceTick[] };
      if (data.ticker === activeTicker) setTicks(data.ticks);
    });
  }, [activeTicker]);

  function watchTicker(t: string) {
    const clean = t.trim().toUpperCase();
    if (!clean) return;
    setActiveTicker(clean);
    setTicks([]);
    window.nemesis.watchTicker(clean);
    window.nemesis.getTickHistory(clean).then((h) => setTicks(h as PriceTick[]));
  }

  const tickerInput = (
    <input
      ref={inputRef}
      type="text"
      placeholder="TICKER"
      value={ticker}
      onChange={(e) => setTicker(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { watchTicker(ticker); inputRef.current?.blur(); } }}
      onBlur={() => { if (ticker.trim()) watchTicker(ticker); }}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        color: 'var(--text)',
        fontSize: 9,
        padding: '2px 6px',
        borderRadius: 4,
        width: 90,
        textTransform: 'uppercase',
        // @ts-expect-error electron css property
        WebkitAppRegion: 'no-drag',
      }}
    />
  );

  return (
    <WidgetShell title="Live Ticker" headerExtra={tickerInput}>
      <div style={{ overflow: 'auto', flex: 1 }}>
        {activeTicker ? (
          <TicketLiveCharts ticker={activeTicker} ticks={ticks} />
        ) : (
          <div style={{ padding: 16, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
            Type a ticker above and press Enter
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
