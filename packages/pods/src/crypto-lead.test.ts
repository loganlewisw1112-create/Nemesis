import { describe, expect, it } from 'vitest';
import { cryptoToThesis, type CryptoLeadInput } from './crypto-lead.js';

type BinanceContextInput = CryptoLeadInput & {
  binanceQuote: {
    symbol: string;
    price: number;
    lagMs: number;
    fetchedAt: number;
    momentumBps: number;
    volatilityBps: number;
    sampleCount: number;
    windowMs: number;
  };
};

const baseInput: CryptoLeadInput = {
  ticker: 'KXBTC-100K',
  title: 'Bitcoin above $100,000',
  spotPrice: 100_200,
  strike: 100_000,
  marketPrice: 0.54,
  spread: 0.02,
  depthUsd: 600,
  lagMs: 80,
  kalshiImpliedSpot: 99_800,
  closeTime: new Date(Date.now() + 60 * 60_000).toISOString(),
};

function withBinanceContext(
  overrides: Partial<BinanceContextInput['binanceQuote']>,
  input: CryptoLeadInput = baseInput,
): BinanceContextInput {
  return {
    ...input,
    binanceQuote: {
      symbol: 'BTCUSDT',
      price: input.spotPrice,
      lagMs: input.lagMs,
      fetchedAt: Date.now(),
      momentumBps: 0,
      volatilityBps: 12,
      sampleCount: 12,
      windowMs: 45_000,
      ...overrides,
    },
  };
}

describe('cryptoToThesis Binance scoring', () => {
  it('keeps momentum out of the binary probability model', () => {
    const supportive = cryptoToThesis(withBinanceContext({ momentumBps: 42, volatilityBps: 14 }));
    const fading = cryptoToThesis(withBinanceContext({ momentumBps: -42, volatilityBps: 14 }));

    expect(supportive.impliedPrice).toBeCloseTo(fading.impliedPrice, 6);
    expect(supportive.impliedPrice).not.toBe(0.72);
    expect(supportive.predictability).toBeGreaterThan(fading.predictability);
    expect(supportive.externalSummary).toContain('momentum +42.0 bps');
    expect(supportive.drivers.map((d) => d.label)).toContain('Binance momentum');
    expect(supportive.drivers.find((d) => d.label === 'Binance momentum')?.detail).toContain('display-only');
    expect(supportive.cryptoContext).toMatchObject({
      symbol: 'BTCUSDT',
      momentumBps: 42,
      volatilityBps: 14,
      sampleCount: 12,
    });
  });

  it('prices at-the-money binaries near 50/50 and deep OTM binaries low', () => {
    const atMoney = cryptoToThesis(withBinanceContext(
      { price: 100_000, volatilityBps: 10, sampleCount: 12, windowMs: 55_000 },
      { ...baseInput, spotPrice: 100_000, strike: 100_000, marketPrice: 0.5, kalshiImpliedSpot: undefined },
    ));
    const deepOtm = cryptoToThesis(withBinanceContext(
      { price: 98_000, volatilityBps: 10, sampleCount: 12, windowMs: 55_000 },
      { ...baseInput, spotPrice: 98_000, strike: 100_000, marketPrice: 0.2, kalshiImpliedSpot: undefined },
    ));

    expect(atMoney.impliedPrice).toBeGreaterThan(0.47);
    expect(atMoney.impliedPrice).toBeLessThan(0.52);
    expect(deepOtm.impliedPrice).toBeLessThan(0.3);
  });

  it('compresses fair value toward 50/50 when horizon volatility is elevated', () => {
    const calm = cryptoToThesis(withBinanceContext(
      { price: 102_000, momentumBps: 36, volatilityBps: 5, sampleCount: 12, windowMs: 55_000 },
      { ...baseInput, spotPrice: 102_000, strike: 100_000, marketPrice: 0.6, kalshiImpliedSpot: undefined },
    ));
    const choppy = cryptoToThesis(withBinanceContext(
      { price: 102_000, momentumBps: 36, volatilityBps: 160, sampleCount: 12, windowMs: 55_000 },
      { ...baseInput, spotPrice: 102_000, strike: 100_000, marketPrice: 0.6, kalshiImpliedSpot: undefined },
    ));

    expect(choppy.impliedPrice).toBeLessThan(calm.impliedPrice);
    expect(Math.abs(choppy.impliedPrice - 0.5)).toBeLessThan(Math.abs(calm.impliedPrice - 0.5));
    expect(choppy.predictability).toBeLessThan(calm.predictability - 20);
    expect(choppy.drivers.some((d) => d.label === 'Volatility horizon' && d.impact < 0)).toBe(true);
    expect(choppy.cryptoContext?.sigmaT).toBeGreaterThan(calm.cryptoContext?.sigmaT ?? 0);
  });

  it('keeps ETH-style Binance context compatible with the normal thesis card shape', () => {
    const eth = cryptoToThesis(withBinanceContext(
      {
        symbol: 'ETHUSDT',
        price: 5_050,
        momentumBps: -25,
        volatilityBps: 18,
        sampleCount: 9,
      },
      {
        ...baseInput,
        ticker: 'KXETH-5K',
        title: 'Ethereum above $5,000',
        spotPrice: 5_050,
        strike: 5_000,
        marketPrice: 0.61,
      },
    ));

    expect(eth.playbook).toBe('crypto-lead');
    expect(eth.category).toBe('crypto');
    expect(eth.cryptoContext?.symbol).toBe('ETHUSDT');
    expect(eth.externalSummary).toContain('ETHUSDT');
    expect(eth.signalReason).toContain('vol 18.0 bps');
    expect(eth.invalidations).not.toContain('eth-daily-quarantine');
  });

  it('fails closed until Binance has enough samples for volatility', () => {
    const firstSample = cryptoToThesis(withBinanceContext(
      { sampleCount: 1, lagMs: 120 },
      { ...baseInput, kalshiImpliedSpot: undefined },
    ));

    expect(firstSample.status).toBe('uncertain');
    expect(firstSample.sourceMove).toBe('microstructure-only');
    expect(firstSample.invalidations).toContain('crypto-binance-samples-insufficient');
  });

  it('keeps sub-tenth-bps Binance volatility usable for the horizon model', () => {
    const card = cryptoToThesis(withBinanceContext(
      { price: 102_000, sampleCount: 120, volatilityBps: 0.04, windowMs: 60_000 },
      { ...baseInput, marketPrice: 0.35, kalshiImpliedSpot: undefined },
    ));

    expect(card.invalidations).not.toContain('crypto-volatility-unavailable');
    expect(card.invalidations).not.toContain('crypto-sigma-unusable');
    expect(card.cryptoContext?.volatilityBps).toBeGreaterThan(0);
    expect(card.cryptoContext?.sigmaT).toBeGreaterThan(0);
    expect(card.cryptoContext?.floorSigmaT).toBeGreaterThan(0);
    expect(card.cryptoContext?.sigmaT).toBeGreaterThanOrEqual(card.cryptoContext?.floorSigmaT ?? 0);
  });

  it('uses the annual floor for flat sampled windows but fails closed without a window or expiry', () => {
    const flatWindow = cryptoToThesis(withBinanceContext(
      { sampleCount: 12, volatilityBps: 0, windowMs: 45_000 },
      { ...baseInput, kalshiImpliedSpot: undefined },
    ));
    const missingWindow = cryptoToThesis(withBinanceContext(
      { sampleCount: 12, volatilityBps: 0, windowMs: 0 },
      { ...baseInput, kalshiImpliedSpot: undefined },
    ));
    const expired = cryptoToThesis(withBinanceContext(
      { sampleCount: 12, volatilityBps: 10 },
      { ...baseInput, closeTime: new Date(Date.now() - 1_000).toISOString(), kalshiImpliedSpot: undefined },
    ));
    const missingQuote = cryptoToThesis({ ...baseInput, kalshiImpliedSpot: undefined });

    expect(flatWindow.invalidations).not.toContain('crypto-volatility-unavailable');
    expect(flatWindow.invalidations).not.toContain('crypto-sigma-unusable');
    expect(flatWindow.cryptoContext?.observedSigmaT).toBe(0);
    expect(flatWindow.cryptoContext?.sigmaT).toBe(flatWindow.cryptoContext?.floorSigmaT);
    expect(missingWindow.status).toBe('uncertain');
    expect(missingWindow.invalidations).toContain('crypto-binance-window-missing');
    expect(expired.invalidations).toContain('crypto-expiry-unavailable');
    expect(missingQuote.invalidations).toContain('crypto-binance-quote-missing');
  });

  it('does not invent a source-conflict from marketPrice*strike when Kalshi implied spot is absent', () => {
    const withoutKalshiSpot = cryptoToThesis(withBinanceContext(
      { sampleCount: 12, momentumBps: 30, volatilityBps: 12 },
      {
        ...baseInput,
        kalshiImpliedSpot: undefined,
        marketPrice: 0.42,
        spotPrice: 110_000,
        strike: 100_000,
      },
    ));
    expect(withoutKalshiSpot.invalidations).not.toContain('source-conflict');
    expect(withoutKalshiSpot.status).not.toBe('uncertain');
    expect(withoutKalshiSpot.sourceMove).toBe('flow-driven');
  });

  it('keeps genuine model-vs-market gaps entry eligible', () => {
    const discounted = cryptoToThesis(withBinanceContext(
      { price: 102_000, sampleCount: 12, momentumBps: 30, volatilityBps: 5, windowMs: 55_000 },
      {
        ...baseInput,
        kalshiImpliedSpot: undefined,
        marketPrice: 0.55,
        spotPrice: 102_000,
        strike: 100_000,
        spread: 0.01,
        depthUsd: 1_000,
      },
    ));

    expect(discounted.status).toBe('tradeable');
    expect(discounted.side).toBe('yes');
    expect(discounted.netEdge).toBeGreaterThan(0.02);
    expect(discounted.sourceMove).toBe('flow-driven');
  });

  it('still flags a real Kalshi-implied spot that disagrees with Binance', () => {
    const conflicted = cryptoToThesis(withBinanceContext(
      { sampleCount: 12 },
      {
        ...baseInput,
        spotPrice: 110_000,
        strike: 100_000,
        kalshiImpliedSpot: 70_000,
      },
    ));
    expect(conflicted.status).toBe('uncertain');
    expect(conflicted.invalidations).toContain('source-conflict');
  });
});
