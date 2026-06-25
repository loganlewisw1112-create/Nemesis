import type { KalshiMarket } from '@nemesis/core';

interface GeoPoint {
  lat: number;
  lon: number;
  countryCode: string;
}

const CITY_COORDS_EXTENDED: Record<string, { lat: number; lon: number }> = {
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
  'san francisco': { lat: 37.7749, lon: -122.4194 },
  'las vegas': { lat: 36.1699, lon: -115.1398 },
  minneapolis: { lat: 44.9778, lon: -93.265 },
  detroit: { lat: 42.3314, lon: -83.0458 },
  portland: { lat: 45.5051, lon: -122.675 },
  nashville: { lat: 36.1627, lon: -86.7816 },
  philadelphia: { lat: 39.9526, lon: -75.1652 },
};

const COUNTRY_GEO: Record<string, GeoPoint> = {
  usa: { lat: 38, lon: -97, countryCode: 'USA' },
  'united states': { lat: 38, lon: -97, countryCode: 'USA' },
  american: { lat: 38, lon: -97, countryCode: 'USA' },
  uk: { lat: 51.5, lon: -0.12, countryCode: 'GBR' },
  britain: { lat: 51.5, lon: -0.12, countryCode: 'GBR' },
  england: { lat: 51.5, lon: -1.5, countryCode: 'GBR' },
  'united kingdom': { lat: 51.5, lon: -0.12, countryCode: 'GBR' },
  germany: { lat: 51.1, lon: 10.4, countryCode: 'DEU' },
  german: { lat: 51.1, lon: 10.4, countryCode: 'DEU' },
  france: { lat: 46.2, lon: 2.2, countryCode: 'FRA' },
  french: { lat: 46.2, lon: 2.2, countryCode: 'FRA' },
  china: { lat: 35.9, lon: 104.2, countryCode: 'CHN' },
  chinese: { lat: 35.9, lon: 104.2, countryCode: 'CHN' },
  beijing: { lat: 39.9, lon: 116.4, countryCode: 'CHN' },
  japan: { lat: 36.2, lon: 138.3, countryCode: 'JPN' },
  japanese: { lat: 36.2, lon: 138.3, countryCode: 'JPN' },
  russia: { lat: 61.5, lon: 105.3, countryCode: 'RUS' },
  russian: { lat: 61.5, lon: 105.3, countryCode: 'RUS' },
  india: { lat: 20.6, lon: 78.9, countryCode: 'IND' },
  indian: { lat: 20.6, lon: 78.9, countryCode: 'IND' },
  brazil: { lat: -14.2, lon: -51.9, countryCode: 'BRA' },
  brazilian: { lat: -14.2, lon: -51.9, countryCode: 'BRA' },
  canada: { lat: 56.1, lon: -106.3, countryCode: 'CAN' },
  canadian: { lat: 56.1, lon: -106.3, countryCode: 'CAN' },
  australia: { lat: -25.3, lon: 133.8, countryCode: 'AUS' },
  australian: { lat: -25.3, lon: 133.8, countryCode: 'AUS' },
  israel: { lat: 31.1, lon: 35.0, countryCode: 'ISR' },
  israeli: { lat: 31.1, lon: 35.0, countryCode: 'ISR' },
  iran: { lat: 32.4, lon: 53.7, countryCode: 'IRN' },
  iranian: { lat: 32.4, lon: 53.7, countryCode: 'IRN' },
  ukraine: { lat: 48.4, lon: 31.2, countryCode: 'UKR' },
  ukrainian: { lat: 48.4, lon: 31.2, countryCode: 'UKR' },
  mexico: { lat: 23.6, lon: -102.6, countryCode: 'MEX' },
  mexican: { lat: 23.6, lon: -102.6, countryCode: 'MEX' },
  turkey: { lat: 38.9, lon: 35.2, countryCode: 'TUR' },
  turkish: { lat: 38.9, lon: 35.2, countryCode: 'TUR' },
  korea: { lat: 35.9, lon: 127.8, countryCode: 'KOR' },
  korean: { lat: 35.9, lon: 127.8, countryCode: 'KOR' },
  'south korea': { lat: 35.9, lon: 127.8, countryCode: 'KOR' },
  taiwan: { lat: 23.7, lon: 120.9, countryCode: 'TWN' },
  'saudi arabia': { lat: 23.9, lon: 45.1, countryCode: 'SAU' },
  saudi: { lat: 23.9, lon: 45.1, countryCode: 'SAU' },
  egypt: { lat: 26.8, lon: 30.8, countryCode: 'EGY' },
  'south africa': { lat: -30.6, lon: 22.9, countryCode: 'ZAF' },
  nigeria: { lat: 9.1, lon: 8.7, countryCode: 'NGA' },
  argentina: { lat: -38.4, lon: -63.6, countryCode: 'ARG' },
  europe: { lat: 54.5, lon: 15.3, countryCode: 'DEU' },
  european: { lat: 54.5, lon: 15.3, countryCode: 'DEU' },
  'middle east': { lat: 26.8, lon: 41.5, countryCode: 'SAU' },
  asia: { lat: 34.0, lon: 100.6, countryCode: 'CHN' },
};

const REGION_DEFAULTS: Record<string, GeoPoint> = {
  federal: { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  'fed funds': { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  cpi: { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  gdp: { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  unemployment: { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  nfl: { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  nba: { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  mlb: { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  nhl: { lat: 38.9, lon: -77.0, countryCode: 'USA' },
  bitcoin: { lat: 20, lon: 0, countryCode: 'GLB' },
  btc: { lat: 20, lon: 0, countryCode: 'GLB' },
  ethereum: { lat: 20, lon: 0, countryCode: 'GLB' },
  eth: { lat: 20, lon: 0, countryCode: 'GLB' },
  crypto: { lat: 20, lon: 0, countryCode: 'GLB' },
  oil: { lat: 25, lon: 45, countryCode: 'SAU' },
  opec: { lat: 25, lon: 45, countryCode: 'SAU' },
  ecb: { lat: 50.1, lon: 8.7, countryCode: 'DEU' },
  'bank of england': { lat: 51.5, lon: -0.1, countryCode: 'GBR' },
  'bank of japan': { lat: 35.7, lon: 139.7, countryCode: 'JPN' },
};

export function inferMarketGeo(market: KalshiMarket): GeoPoint | null {
  const txt = `${market.title} ${market.subtitle ?? ''} ${market.category ?? ''}`.toLowerCase();

  // 1. City-level match (US cities)
  for (const [city, coords] of Object.entries(CITY_COORDS_EXTENDED)) {
    if (txt.includes(city)) return { ...coords, countryCode: 'USA' };
  }

  // 2. Country-level match
  for (const [keyword, geo] of Object.entries(COUNTRY_GEO)) {
    if (txt.includes(keyword)) return geo;
  }

  // 3. Keyword defaults
  for (const [keyword, geo] of Object.entries(REGION_DEFAULTS)) {
    if (txt.includes(keyword)) return geo;
  }

  // 4. Category fallback
  const cat = (market.category ?? '').toLowerCase();
  if (cat.includes('weather') || cat.includes('climate')) return { lat: 38, lon: -97, countryCode: 'USA' };
  if (cat.includes('crypto')) return { lat: 20, lon: 0, countryCode: 'GLB' };
  if (cat.includes('sport') || cat.includes('nfl') || cat.includes('nba')) return { lat: 38.9, lon: -77.0, countryCode: 'USA' };
  if (cat.includes('econ') || cat.includes('macro') || cat.includes('politic')) return { lat: 38.9, lon: -77.0, countryCode: 'USA' };

  return null;
}
