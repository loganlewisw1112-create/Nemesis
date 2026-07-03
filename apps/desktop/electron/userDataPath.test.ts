import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveNemesisUserDataPath } from './userDataPath.js';

describe('NEMESIS user data path', () => {
  it('uses the product AppData path outside e2e runs', () => {
    expect(resolveNemesisUserDataPath({}, 'C:\\Users\\logan\\AppData\\Roaming'))
      .toBe(path.join('C:\\Users\\logan\\AppData\\Roaming', '@nemesis', 'desktop'));
  });

  it('respects the e2e user-data override', () => {
    expect(resolveNemesisUserDataPath(
      { NEMESIS_E2E_USER_DATA: 'D:\\tmp\\nemesis-e2e' },
      'C:\\Users\\logan\\AppData\\Roaming',
    )).toBe('D:\\tmp\\nemesis-e2e');
  });
});
