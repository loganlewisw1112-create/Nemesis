import { describe, expect, it } from 'vitest';
import { weatherToThesis } from '../src/weather-wing.js';
import { cryptoToThesis } from '../src/crypto-lead.js';
import { macroToThesis } from '../src/macro-pulse.js';
import { sportsToThesis } from '../src/sports-live.js';
import { globalToThesis } from '../src/global-pulse.js';
import { infraToThesis } from '../src/infra-watch.js';
import { StrategyQuarantine } from '@nemesis/capital';

describe('pods', () => {
  it('creates weather thesis', () => {
    const t = weatherToThesis({
      ticker: 'WX-1',
      title: 'NYC High > 90',
      strike: 90,
      nwsForecast: 92,
      openMeteoForecast: 91,
      marketPrice: 0.34,
      spread: 0.04,
      depthUsd: 300,
      hoursToSettle: 4,
    });
    expect(t.playbook).toBe('weather-wing');
    expect(t.ticker).toBe('WX-1');
  });

  it('keeps every dynamic NO thesis in selected-contract price terms', () => {
    const weather = weatherToThesis({
      ticker: 'WX-NO', title: 'High above 90', strike: 90, nwsForecast: 80,
      openMeteoForecast: 80, marketPrice: 0.7, spread: 0.02, depthUsd: 300, hoursToSettle: 4,
    });
    const macro = macroToThesis({
      ticker: 'MACRO-NO', title: 'Release beats', releaseName: 'Test release', consensus: 1,
      actual: 0, marketPrice: 0.7, spread: 0.02, depthUsd: 300, minutesToRelease: 30,
    });
    const sports = sportsToThesis({
      ticker: 'SPORT-NO', title: 'Home wins', homeScore: 1, awayScore: 2,
      impliedWinProb: 0.3, marketPrice: 0.6, spread: 0.02, depthUsd: 300,
    });
    const crypto = cryptoToThesis({
      ticker: 'CRYPTO-NO', title: 'Bitcoin above strike', spotPrice: 90_000, strike: 100_000,
      marketPrice: 0.7, spread: 0.02, depthUsd: 300, lagMs: 10,
    });

    for (const thesis of [weather, macro, sports, crypto]) {
      expect(thesis.side).toBe('no');
      expect(thesis.marketPrice).toBeLessThan(0.5);
      expect(thesis.impliedPrice).toBeGreaterThan(thesis.marketPrice);
      expect(thesis.grossEdge).toBeGreaterThan(0);
    }
  });

  it('keeps heuristic global pulse cards out of direct execution', () => {
    const t = globalToThesis({
      ticker: 'GLOBAL-1',
      marketTitle: 'Will a generic global event happen?',
      news: { title: 'Generic global headline', url: 'https://example.test', category: 'world', severity: 0.4 },
      marketPrice: 0.35,
      spread: 0.02,
      depthUsd: 300,
    });

    expect(t.playbook).toBe('global-pulse');
    expect(t.status).not.toBe('tradeable');
    expect(t.invalidations).toContain('heuristic source requires execution certificate');
  });

  it('rejects irrelevant infra alerts instead of attaching them to every market', () => {
    const t = infraToThesis(
      'KXNBA-GAME',
      'Will the Knicks win tonight?',
      { provider: 'AWS', status: 'outage', summary: 'AWS outage' },
      0.4,
      0.02,
      300,
    );

    expect(t).toBeNull();
  });
});

describe('quarantine', () => {
  it('freezes underperforming playbook', () => {
    const q = new StrategyQuarantine();
    q.evaluate({
      playbook: 'flow-hunter',
      signals: 30,
      wins: 5,
      losses: 25,
      staleRate: 0.1,
      disagreementRate: 0.1,
      fillDrag: 0.05,
    });
    expect(q.isFrozen('flow-hunter')).toBe(true);
  });
});
