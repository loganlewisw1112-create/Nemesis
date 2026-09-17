import { useCallback, useEffect, useState } from 'react';
import { ComposableMap, Geographies, Geography } from 'react-simple-maps';
import type { WorldEventsPayload } from '@nemesis/core';
import { WidgetShell } from './WidgetShell';
import { WORLD_MAP_PROJECTION } from '../worldMapProjection';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

const COUNTRY_ID_TO_CODE: Record<number, string> = {
  840: 'USA', 826: 'GBR', 276: 'DEU', 250: 'FRA', 156: 'CHN',
  392: 'JPN', 643: 'RUS', 356: 'IND',  76: 'BRA', 124: 'CAN',
   36: 'AUS', 376: 'ISR', 364: 'IRN', 804: 'UKR', 484: 'MEX',
  792: 'TUR', 410: 'KOR', 682: 'SAU', 818: 'EGY', 710: 'ZAF',
};

function heatColor(score: number): string {
  if (score <= 0) return '#1a1d27';
  if (score < 0.3) return '#1e2e20';
  if (score < 0.5) return '#2e2a12';
  if (score < 0.7) return '#2e1e12';
  return '#2e1212';
}

export function WorldWidget() {
  const [data, setData] = useState<WorldEventsPayload | null>(null);

  const handleData = useCallback((raw: unknown) => {
    setData(raw as WorldEventsPayload);
  }, []);

  useEffect(() => {
    if (!window.nemesis) return;
    window.nemesis.getWorldEvents().then(handleData);
    return window.nemesis.onWorldEventsUpdate(handleData);
  }, [handleData]);

  const heatData = data?.heatData ?? {};
  const tradeable = data?.geoMarkets.filter((m) => m.netEdge > 0).length ?? 0;

  return (
    <WidgetShell title="Globe">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, overflow: 'hidden', background: '#0e111a' }}>
          <ComposableMap
            projection={WORLD_MAP_PROJECTION}
            projectionConfig={{ scale: 130 }}
            style={{ width: '100%', height: '100%' }}
          >
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map((geo) => {
                  const numId = geo.id as number;
                  const code = COUNTRY_ID_TO_CODE[numId] ?? '';
                  const heat = code ? (heatData[code] ?? 0) : 0;
                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      fill={heatColor(heat)}
                      stroke="#2a2d3d"
                      strokeWidth={0.4}
                      style={{ default: { outline: 'none' }, hover: { outline: 'none' }, pressed: { outline: 'none' } }}
                    />
                  );
                })
              }
            </Geographies>
          </ComposableMap>
        </div>
        <div style={{ padding: '4px 10px', fontSize: 9, color: 'var(--text-muted)', borderTop: '1px solid var(--border)', display: 'flex', gap: 12 }}>
          <span>{data?.geoNews.length ?? 0} news events</span>
          <span style={{ color: tradeable > 0 ? 'var(--success)' : 'var(--text-muted)' }}>{tradeable} tradeable</span>
        </div>
      </div>
    </WidgetShell>
  );
}
