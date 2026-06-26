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
  it('leans into supportive short-horizon momentum instead of using a fixed above-strike probability', () => {
    const supportive = cryptoToThesis(withBinanceContext({ momentumBps: 42, volatilityBps: 14 }));
    const fading = cryptoToThesis(withBinanceContext({ momentumBps: -42, volatilityBps: 14 }));

    expect(supportive.impliedPrice).toBeGreaterThan(fading.impliedPrice + 0.04);
    expect(supportive.impliedPrice).not.toBe(0.72);
    expect(supportive.predictability).toBeGreaterThan(fading.predictability);
    expect(supportive.externalSummary).toContain('momentum +42.0 bps');
    expect(supportive.drivers.map((d) => d.label)).toContain('Binance momentum');
    expect(supportive.cryptoContext).toMatchObject({
      symbol: 'BTCUSDT',
      momentumBps: 42,
      volatilityBps: 14,
      sampleCount: 12,
    });
  });

  it('reduces confidence and compresses fair value when Binance volatility is elevated', () => {
    const calm = cryptoToThesis(withBinanceContext({ momentumBps: 36, volatilityBps: 10 }));
    const choppy = cryptoToThesis(withBinanceContext({ momentumBps: 36, volatilityBps: 240 }));

    expect(choppy.impliedPrice).toBeLessThan(calm.impliedPrice - 0.03);
    expect(Math.abs(choppy.impliedPrice - 0.5)).toBeLessThan(Math.abs(calm.impliedPrice - 0.5));
    expect(choppy.predictability).toBeLessThan(calm.predictability - 20);
    expect(choppy.drivers.some((d) => d.label === 'Binance volatility' && d.impact < 0)).toBe(true);
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
  });
});
