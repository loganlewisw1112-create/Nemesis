import { describe, expect, it } from 'vitest';
import {
  parseTemperatureStrike,
  parseBtcStrike,
  parseCpiStrike,
  parseWeatherCoords,
  isWeatherMarket,
} from '../src/parseMarket.js';
import { minutesToNextCpiRelease } from '../src/feeds.js';

describe('parseMarket', () => {
  it('parses temperature strike', () => {
    expect(parseTemperatureStrike('NYC High Temp above 92°F')).toBe(92);
    expect(parseTemperatureStrike('Will it hit 88F')).toBe(88);
  });

  it('parses BTC strike', () => {
    expect(parseBtcStrike('BTC above $98k')).toBe(98000);
    expect(parseBtcStrike('Bitcoin over $100,000')).toBe(100000);
  });

  it('parses CPI strike', () => {
    expect(parseCpiStrike('CPI above 3.2%')).toBe(3.2);
  });

  it('resolves weather coords from title', () => {
    expect(parseWeatherCoords('Chicago high temperature')).toEqual({ lat: 41.8781, lon: -87.6298 });
  });

  it('detects weather markets', () => {
    expect(isWeatherMarket({ ticker: 'WX', title: 'NYC temp', status: 'open', category: 'weather' })).toBe(true);
  });
});

describe('release calendar', () => {
  it('returns positive minutes to CPI', () => {
    expect(minutesToNextCpiRelease()).toBeGreaterThan(0);
  });
});
