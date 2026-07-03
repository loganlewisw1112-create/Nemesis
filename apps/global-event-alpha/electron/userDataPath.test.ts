import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveGeaUserDataPath } from './userDataPath.js';

describe('GEA user data path', () => {
  it('uses the product AppData path outside e2e runs', () => {
    expect(resolveGeaUserDataPath({}, 'C:\\Users\\logan\\AppData\\Roaming'))
      .toBe(path.join('C:\\Users\\logan\\AppData\\Roaming', '@nemesis', 'global-event-alpha'));
  });

  it('respects the GEA e2e user-data override', () => {
    expect(resolveGeaUserDataPath(
      { GEA_E2E_USER_DATA: 'D:\\tmp\\gea-e2e' },
      'C:\\Users\\logan\\AppData\\Roaming',
    )).toBe('D:\\tmp\\gea-e2e');
  });
});
