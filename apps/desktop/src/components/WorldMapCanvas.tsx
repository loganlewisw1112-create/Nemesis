import { useState } from 'react';
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps';
import type { GeoMarket, WorldEventsPayload } from '@nemesis/core';

const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

// ISO 3166-1 numeric → our alpha-3 country code
const COUNTRY_ID_TO_CODE: Record<number, string> = {
  840: 'USA', 826: 'GBR', 276: 'DEU', 250: 'FRA', 156: 'CHN',
  392: 'JPN', 643: 'RUS', 356: 'IND',  76: 'BRA', 124: 'CAN',
   36: 'AUS', 376: 'ISR', 364: 'IRN', 804: 'UKR', 484: 'MEX',
  792: 'TUR', 410: 'KOR', 158: 'TWN', 682: 'SAU', 818: 'EGY',
  710: 'ZAF', 566: 'NGA',  32: 'ARG', 724: 'ESP', 380: 'ITA',
  528: 'NLD',  56: 'BEL',  40: 'AUT', 620: 'PRT', 442: 'LUX',
  203: 'CZE', 616: 'POL', 752: 'SWE', 578: 'NOR', 208: 'DNK',
  246: 'FIN', 756: 'CHE', 300: 'GRC', 348: 'HUN', 703: 'SVK',
};

function heatColor(score: number): string {
  if (score <= 0) return '#1a1d27';
  if (score < 0.3) return '#1e2e20';
  if (score < 0.5) return '#2e2a12';
  if (score < 0.7) return '#2e1e12';
  return '#2e1212';
}

function markerColor(status: string, netEdge: number): string {
  if (netEdge > 0 && (status === 'tradeable' || status === 'qualified')) return 'var(--success)';
  if (status === 'watch-only') return 'var(--warning)';
  return '#555';
}

interface Props {
  heatData: WorldEventsPayload['heatData'];
  markers: GeoMarket[];
  selectedCountry: string | null;
  onSelectCountry: (code: string | null) => void;
}

interface Tooltip { text: string; x: number; y: number }

export function WorldMapCanvas({ heatData, markers, selectedCountry, onSelectCountry }: Props) {
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  return (
    <div style={{ flex: 1, position: 'relative', background: '#0e111a', overflow: 'hidden' }}>
      <ComposableMap
        projection="geoNaturalEarth1"
        projectionConfig={{ scale: 160 }}
        style={{ width: '100%', height: '100%' }}
      >
        <Geographies geography={GEO_URL}>
          {({ geographies }) =>
            geographies.map((geo) => {
              const numId = geo.id as number;
              const code = COUNTRY_ID_TO_CODE[numId] ?? '';
              const heat = code ? (heatData[code] ?? 0) : 0;
              const isSelected = selectedCountry !== null && selectedCountry === code;
              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  fill={isSelected ? 'rgba(99,102,241,0.5)' : heatColor(heat)}
                  stroke="#2a2d3d"
                  strokeWidth={0.4}
                  style={{
                    default: { outline: 'none' },
                    hover: { fill: code ? 'rgba(99,102,241,0.3)' : '#1a1d27', cursor: code ? 'pointer' : 'default', outline: 'none' },
                    pressed: { outline: 'none' },
                  }}
                  onClick={() => {
                    if (!code) return;
                    onSelectCountry(isSelected ? null : code);
                  }}
                  onMouseEnter={(e) => {
                    if (!code) return;
                    const heatPct = Math.round(heat * 100);
                    setTooltip({ text: `${code}${heatPct > 0 ? ` · intensity ${heatPct}%` : ''}`, x: e.clientX, y: e.clientY });
                  }}
                  onMouseLeave={() => setTooltip(null)}
                />
              );
            })
          }
        </Geographies>

        {markers.map((m) => (
          <Marker key={m.ticker} coordinates={[m.lon, m.lat]}>
            <circle
              r={3.5}
              fill={markerColor(m.status, m.netEdge)}
              stroke="rgba(0,0,0,0.6)"
              strokeWidth={0.8}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) =>
                setTooltip({ text: `${m.ticker} · ${(m.netEdge * 100).toFixed(1)}¢ edge`, x: e.clientX, y: e.clientY })
              }
              onMouseLeave={() => setTooltip(null)}
              onClick={() => onSelectCountry(m.countryCode)}
            />
            {m.netEdge > 0.04 && (
              <circle
                r={7}
                fill="none"
                stroke={markerColor(m.status, m.netEdge)}
                strokeWidth={0.8}
                opacity={0.35}
                style={{ animation: 'chartPulse 2s infinite', pointerEvents: 'none' }}
              />
            )}
          </Marker>
        ))}
      </ComposableMap>

      {tooltip && (
        <div
          style={{
            position: 'fixed',
            top: tooltip.y - 36,
            left: tooltip.x + 12,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            pointerEvents: 'none',
            zIndex: 9999,
            whiteSpace: 'nowrap',
            color: 'var(--text)',
          }}
        >
          {tooltip.text}
        </div>
      )}

      <div style={{ position: 'absolute', bottom: 10, left: 12, fontSize: 9, color: 'var(--text-muted)', display: 'flex', gap: 12, userSelect: 'none' }}>
        <span>
          <span style={{ color: 'var(--success)' }}>●</span> Tradeable
          {' '}
          <span style={{ color: 'var(--warning)' }}>●</span> Watch
          {' '}
          <span style={{ color: '#555' }}>●</span> No edge
        </span>
        <span>Fill = event intensity · Click country to filter</span>
      </div>
    </div>
  );
}
