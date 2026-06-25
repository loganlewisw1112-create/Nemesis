import type { KalshiMarket } from '@nemesis/core';

const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  nyc: { lat: 40.7128, lon: -74.006 },
  'new york': { lat: 40.7128, lon: -74.006 },
  chicago: { lat: 41.8781, lon: -87.6298 },
  miami: { lat: 25.7617, lon: -80.1918 },
  la: { lat: 34.0522, lon: -118.2437 },
  'los angeles': { lat: 34.0522, lon: -118.2437 },
  dallas: { lat: 32.7767, lon: -96.797 },
  houston: { lat: 29.7604, lon: -95.3698 },
  phoenix: { lat: 33.4484, lon: -112.074 },
  denver: { lat: 39.7392, lon: -104.9903 },
  seattle: { lat: 47.6062, lon: -122.3321 },
  boston: { lat: 42.3601, lon: -71.0589 },
  atlanta: { lat: 33.749, lon: -84.388 },
};

export function parseTemperatureStrike(title: string): number {
  const m = title.match(/(?:above|over|>|≥)\s*(\d+)\s*°?\s*F/i)
    ?? title.match(/(\d+)\s*°?\s*F/i);
  return m ? parseInt(m[1], 10) : 90;
}

export function parseWeatherCoords(title: string): { lat: number; lon: number } {
  const lower = title.toLowerCase();
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (lower.includes(city)) return coords;
  }
  return CITY_COORDS.nyc;
}

export function parseBtcStrike(title: string): number {
  const kMatch = title.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*k\b/i);
  if (kMatch) return parseFloat(kMatch[1].replace(/,/g, '')) * 1000;
  const m = title.match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  return m ? parseFloat(m[1].replace(/,/g, '')) : 100_000;
}

export function parseCpiStrike(title: string): number {
  const m = title.match(/([\d.]+)\s*%/);
  return m ? parseFloat(m[1]) : 3.0;
}

export function parseCryptoSymbol(title: string, ticker: string): string {
  const combined = `${title} ${ticker}`.toUpperCase();
  if (combined.includes('ETH')) return 'ETHUSDT';
  if (combined.includes('SOL')) return 'SOLUSDT';
  return 'BTCUSDT';
}

export function isWeatherMarket(m: KalshiMarket): boolean {
  const c = (m.category ?? '').toLowerCase();
  const t = m.title.toLowerCase();
  return c.includes('weather') || c.includes('climate') || t.includes('temp') || t.includes('°');
}

export function isCryptoMarket(m: KalshiMarket): boolean {
  const c = (m.category ?? '').toLowerCase();
  const combined = `${m.title} ${m.ticker}`.toLowerCase();
  return c.includes('crypto') || combined.includes('btc') || combined.includes('bitcoin') || combined.includes('eth');
}

export function isMacroMarket(m: KalshiMarket): boolean {
  const c = (m.category ?? '').toLowerCase();
  const t = m.title.toLowerCase();
  return c.includes('econ') || c.includes('macro') || t.includes('cpi') || t.includes('inflation') || t.includes('fed') || t.includes('jobs');
}

export function isSportsMarket(m: KalshiMarket): boolean {
  const c = (m.category ?? '').toLowerCase();
  return c.includes('sport') || c.includes('nfl') || c.includes('nba') || c.includes('mlb');
}

export function hoursToSettle(m: KalshiMarket): number {
  if (!m.close_time) return 24;
  const close = new Date(m.close_time).getTime();
  return Math.max(1, Math.round((close - Date.now()) / 3_600_000));
}

export function gdeltQueryFromTitle(title: string): string {
  const words = title
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !/^(will|the|above|below|before|after|this|that|with|from)$/i.test(w))
    .slice(0, 4);
  return words.join(' ') || 'economy united states';
}
