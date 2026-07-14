import type { ThesisCard } from '@nemesis/core';
import {
  qualifyThesis,
  computeNetEdge,
  detectSourceDisagreement,
  kalshiFeePerContract,
  sigmoidProbability,
  clampProbability,
  selectedSidePricing,
} from '@nemesis/core';

export interface WeatherInput {
  ticker: string;
  title: string;
  strike: number;
  nwsForecast: number;
  openMeteoForecast: number;
  marketPrice: number;
  spread: number;
  depthUsd: number;
  hoursToSettle: number;
}

export async function fetchNwsForecast(lat: number, lon: number): Promise<number | null> {
  try {
    const points = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
    if (!points.ok) return null;
    const data = await points.json() as { properties?: { forecast?: string } };
    const forecastUrl = data.properties?.forecast;
    if (!forecastUrl) return null;
    const forecast = await fetch(forecastUrl);
    if (!forecast.ok) return null;
    const fdata = await forecast.json() as { properties?: { periods?: { temperature: number }[] } };
    return fdata.properties?.periods?.[0]?.temperature ?? null;
  } catch {
    return null;
  }
}

export async function fetchOpenMeteo(lat: number, lon: number): Promise<number | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json() as { daily?: { temperature_2m_max?: number[] } };
    return data.daily?.temperature_2m_max?.[0] ?? null;
  } catch {
    return null;
  }
}

export function weatherToThesis(input: WeatherInput): ThesisCard {
  const { agreement, disagree } = detectSourceDisagreement(
    [{ value: input.nwsForecast }, { value: input.openMeteoForecast }],
    3,
  );
  // Same-day NWS high-temp forecasts run ~1.5°F of error; error grows with
  // lead time. Scale the forecast-vs-strike distance by that lead-time-aware
  // error band instead of collapsing every distance into the same bucket.
  const distance = input.nwsForecast - input.strike;
  const sigma = 1.5 * Math.sqrt(Math.max(1, input.hoursToSettle) / 12);
  const implied = clampProbability(sigmoidProbability(distance, sigma));
  const pricing = selectedSidePricing(input.marketPrice, implied);
  const breakdown = computeNetEdge(pricing.impliedPrice, pricing.marketPrice, input.spread);
  const qual = qualifyThesis({
    impliedPrice: pricing.impliedPrice,
    marketPrice: pricing.marketPrice,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: disagree ? 40 : 75,
    freshnessMs: 5000,
    sourceAgreement: agreement,
    regimeBlocked: false,
    concentrationBlocked: false,
    executionHealthy: true,
  });
  const now = Date.now();
  return {
    id: `wx-${input.ticker}`,
    ticker: input.ticker,
    title: input.title,
    category: 'weather',
    playbook: 'weather-wing',
    status: disagree ? 'uncertain' : qual.status,
    side: pricing.side,
    marketPrice: pricing.marketPrice,
    impliedPrice: pricing.impliedPrice,
    grossEdge: breakdown.grossEdge,
    netEdge: breakdown.netEdge,
    spread: input.spread,
    depthUsd: input.depthUsd,
    predictability: disagree ? 40 : 75,
    feeEstimate: kalshiFeePerContract(pricing.marketPrice),
    signalReason: `NWS ${input.nwsForecast}°F vs strike ${input.strike}°F`,
    externalSummary: `Open-Meteo ${input.openMeteoForecast}°F`,
    createdAt: now,
    updatedAt: now,
    freshnessMs: 5000,
    edgeHistory: [breakdown.netEdge],
    drivers: [
      { label: 'NWS forecast', impact: 0.6, detail: `${input.nwsForecast}°F` },
      { label: 'Revision', impact: 0.3, detail: `${input.hoursToSettle}h to settle` },
    ],
    invalidations: disagree ? ['source-conflict'] : qual.failedGates,
    sourceMove: 'forecast-driven',
  };
}
