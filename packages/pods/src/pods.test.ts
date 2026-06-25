import { describe, expect, it } from 'vitest';
import { weatherToThesis } from '../src/weather-wing.js';
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
