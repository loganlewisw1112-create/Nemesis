import { describe, expect, it } from 'vitest';
import { WORLD_MAP_PROJECTION } from './worldMapProjection';

describe('world map projection', () => {
  it('uses a projection supported by the bundled react-simple-maps version', () => {
    expect(WORLD_MAP_PROJECTION).toBe('geoEqualEarth');
    expect(WORLD_MAP_PROJECTION).not.toBe('geoNaturalEarth1');
  });
});
