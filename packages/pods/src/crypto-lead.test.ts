import { describe, expect, it } from 'vitest';
import { normalCdf } from '@nemesis/core';
import { cryptoToThesis, type CryptoLeadInput } from './crypto-lead.js';

type BinanceContextInput = CryptoLeadInput & {
  binanceQuote: {
    symbol: string;
    price: number;
    lagMs: number;
    fetchedAt: number;
    momentumBps: number;
    volatilityBps: number;
    sigmaPerRootSec: number;
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

/**
 * The per-second volatility a window of `volatilityBps` per-sample moves at this
 * spacing corresponds to. Lets the cases below keep expressing themselves in the
 * bps terms they were written in while the model reads the time-weighted number
 * the connector now supplies.
 */
function sigmaPerRootSecFor(volatilityBps: number, sampleCount: number, windowMs: number): number {
  const dtSec = windowMs > 0 && sampleCount > 1 ? (windowMs / 1000) / (sampleCount - 1) : Number.NaN;
  if (!Number.isFinite(dtSec) || dtSec <= 0) return 0;
  return (volatilityBps / 10_000) / Math.sqrt(dtSec);
}

function withBinanceContext(
  overrides: Partial<BinanceContextInput['binanceQuote']>,
  input: CryptoLeadInput = baseInput,
): BinanceContextInput {
  const volatilityBps = overrides.volatilityBps ?? 12;
  const sampleCount = overrides.sampleCount ?? 12;
  const windowMs = overrides.windowMs ?? 45_000;
  return {
    ...input,
    binanceQuote: {
      symbol: 'BTCUSDT',
      price: input.spotPrice,
      lagMs: input.lagMs,
      fetchedAt: Date.now(),
      momentumBps: 0,
      volatilityBps,
      sigmaPerRootSec: sigmaPerRootSecFor(volatilityBps, sampleCount, windowMs),
      sampleCount,
      windowMs,
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
    expect(card.cryptoContext?.sigmaPerRootSec).toBeGreaterThan(0);
  });

  it('scales the observed volatility to the horizon with no floor underneath it', () => {
    // The 0.35 annual floor this replaces won 57% of the time and exceeded
    // market-implied volatility in 34% of snapshots, which is how a 3-cent
    // contract came to be priced at 16.5 cents. sigmaT is now exactly what was
    // measured, scaled by sqrt(t) and nothing else.
    const sigmaPerRootSec = 0.00002;
    const closeTime = new Date(Date.now() + 3_600_000).toISOString();
    const card = cryptoToThesis(withBinanceContext(
      { sigmaPerRootSec, sampleCount: 60, windowMs: 60_000 },
      { ...baseInput, closeTime, kalshiImpliedSpot: undefined },
    ));

    const timeToExpirySec = card.cryptoContext?.timeToExpirySec ?? 0;
    expect(timeToExpirySec).toBeGreaterThan(3_500);
    expect(card.cryptoContext?.sigmaT)
      .toBeCloseTo(sigmaPerRootSec * Math.sqrt(timeToExpirySec), 6);
    // Well under the annual floor's own contribution at this horizon, which is
    // what the old code would have substituted instead.
    expect(card.cryptoContext?.sigmaT).toBeLessThan(0.35 * Math.sqrt(timeToExpirySec / (365 * 24 * 3600)));
  });

  it('fails closed on a flat window instead of substituting a floor', () => {
    const flatWindow = cryptoToThesis(withBinanceContext(
      { sampleCount: 12, volatilityBps: 0, sigmaPerRootSec: 0, windowMs: 45_000 },
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

    // No measurement means no signal, rather than a manufactured one.
    expect(flatWindow.status).toBe('uncertain');
    expect(flatWindow.invalidations).toContain('crypto-sigma-unusable');
    expect(flatWindow.impliedPrice).toBeCloseTo(flatWindow.marketPrice, 6);
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

  it('invalidates a card whose model volatility disagrees with the ladder the market is quoting', () => {
    // The ladder is the market's own volatility, readable every snapshot at
    // R-squared 0.997. A model far from it is not finding a mispriced contract,
    // it is mispricing one -- which is exactly how a 3-cent contract came to be
    // priced at 16.5 cents.
    const spot = 100_000;
    const closeTime = new Date(Date.now() + 3_600_000).toISOString();
    const timeToExpirySec = 3_600;
    const ladderSigmaT = 0.02;
    const ladder = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((k) => {
      const strike = spot * Math.exp(k * ladderSigmaT);
      const d = (Math.log(spot / strike) - 0.5 * ladderSigmaT * ladderSigmaT) / ladderSigmaT;
      return { strike, marketPrice: normalCdf(d) };
    });

    const cardAt = (ratio: number) => cryptoToThesis(withBinanceContext(
      {
        price: spot,
        sigmaPerRootSec: (ladderSigmaT * ratio) / Math.sqrt(timeToExpirySec),
        sampleCount: 60,
        windowMs: 60_000,
      },
      {
        ...baseInput,
        spotPrice: spot,
        strike: spot,
        marketPrice: 0.5,
        closeTime,
        kalshiImpliedSpot: undefined,
        strikeLadder: ladder,
      },
    ));

    for (const ratio of [0.2, 0.45, 1.8, 4]) {
      const card = cardAt(ratio);
      expect(card.invalidations).toContain('crypto-sigma-uncalibrated');
      expect(card.status).toBe('uncertain');
      // An invalidated card must not produce a signal: it falls back to the
      // market price, so there is no edge to act on.
      expect(card.impliedPrice).toBeCloseTo(card.marketPrice, 6);
    }

    for (const ratio of [0.6, 1, 1.4]) {
      const card = cardAt(ratio);
      expect(card.invalidations).not.toContain('crypto-sigma-uncalibrated');
      expect(card.cryptoContext?.ladderSigmaRatio).toBeCloseTo(ratio, 2);
      expect(card.cryptoContext?.ladderSigmaT).toBeCloseTo(ladderSigmaT, 4);
      expect(card.cryptoContext?.ladderPoints).toBe(ladder.length);
      expect(card.cryptoContext?.ladderRSquared).toBeGreaterThan(0.99);
    }
  });

  it('leaves the calibration check dormant when no ladder can be fitted', () => {
    const noLadder = cryptoToThesis(withBinanceContext(
      { sampleCount: 12, volatilityBps: 12 },
      { ...baseInput, kalshiImpliedSpot: undefined },
    ));
    // Two strikes cannot support a fit, and the same quote at every strike has no slope.
    const thinLadder = cryptoToThesis(withBinanceContext(
      { sampleCount: 12, volatilityBps: 12 },
      {
        ...baseInput,
        kalshiImpliedSpot: undefined,
        strikeLadder: [{ strike: 99_000, marketPrice: 0.6 }, { strike: 101_000, marketPrice: 0.4 }],
      },
    ));

    for (const card of [noLadder, thinLadder]) {
      expect(card.invalidations).not.toContain('crypto-sigma-uncalibrated');
      expect(card.cryptoContext?.ladderSigmaT).toBeUndefined();
      expect(card.cryptoContext?.ladderSigmaRatio).toBeUndefined();
    }
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
