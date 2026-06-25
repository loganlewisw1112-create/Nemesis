import { useCallback, useEffect, useState } from 'react';
import type { WorldEventsPayload } from '@nemesis/core';
import { WorldMapCanvas } from './components/WorldMapCanvas';
import { WorldSidebar } from './components/WorldSidebar';

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return 'a while ago';
}

interface HeaderProps {
  data: WorldEventsPayload | null;
  selectedCountry: string | null;
  onClear: () => void;
  onPopout: () => void;
}

function WorldPageHeader({ data, selectedCountry, onClear, onPopout }: HeaderProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elevated)',
        flexShrink: 0,
      }}
    >
      <h1 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>World Events</h1>

      {data && (
        <>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            ⟳ {timeAgo(data.lastUpdated)}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {data.geoNews.length} news
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {data.geoMarkets.filter((m) => m.netEdge > 0).length} tradeable
          </span>
        </>
      )}

      {selectedCountry && (
        <button
          type="button"
          onClick={onClear}
          style={{
            background: 'var(--accent)',
            border: 'none',
            color: '#fff',
            fontSize: 10,
            padding: '3px 10px',
            borderRadius: 4,
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >
          {selectedCountry} ×
        </button>
      )}

      <button
        type="button"
        title="Pop out Globe widget"
        onClick={onPopout}
        style={{
          marginLeft: 'auto',
          background: 'none',
          border: '1px solid var(--border)',
          color: 'var(--text-muted)',
          fontSize: 10,
          padding: '2px 8px',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        ⧉ Globe
      </button>
    </div>
  );
}

export function WorldPage() {
  const [data, setData] = useState<WorldEventsPayload | null>(null);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [paperResult, setPaperResult] = useState<string | null>(null);

  const handleData = useCallback((raw: unknown) => {
    setData(raw as WorldEventsPayload);
  }, []);

  useEffect(() => {
    if (!window.nemesis) return;
    window.nemesis.getWorldEvents().then(handleData);
    window.nemesis.onWorldEventsUpdate(handleData);
  }, [handleData]);

  const filteredNews = selectedCountry
    ? (data?.geoNews.filter((n) => n.countryCode === selectedCountry) ?? [])
    : (data?.geoNews ?? []);

  const filteredMarkets = selectedCountry
    ? (data?.geoMarkets.filter((m) => m.countryCode === selectedCountry) ?? [])
    : (data?.geoMarkets ?? []);

  async function handlePaperBuy(thesisId: string) {
    const r = await window.nemesis.paperBuy(thesisId);
    if (r.ok) {
      setPaperResult(`Paper buy filled${r.fill ? ` @ ${((r.fill.fillPrice ?? 0) * 100).toFixed(1)}¢` : ''}`);
    } else {
      setPaperResult(`Failed: ${r.error ?? r.abortReason ?? 'unknown'}`);
    }
    setTimeout(() => setPaperResult(null), 4000);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <WorldPageHeader
        data={data}
        selectedCountry={selectedCountry}
        onClear={() => setSelectedCountry(null)}
        onPopout={() => window.nemesis.openWidget('world')}
      />

      {paperResult && (
        <div
          style={{
            padding: '6px 16px',
            fontSize: 11,
            background: paperResult.startsWith('Failed') ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)',
            color: paperResult.startsWith('Failed') ? 'var(--danger)' : 'var(--success)',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          {paperResult}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <WorldMapCanvas
          heatData={data?.heatData ?? {}}
          markers={data?.geoMarkets ?? []}
          selectedCountry={selectedCountry}
          onSelectCountry={setSelectedCountry}
        />
        <WorldSidebar
          news={filteredNews}
          markets={filteredMarkets}
          onPaperBuy={handlePaperBuy}
        />
      </div>
    </div>
  );
}
