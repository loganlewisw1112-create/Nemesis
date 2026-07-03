import { describe, expect, it } from 'vitest';
import { weatherToThesis } from '../src/weather-wing.js';
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
