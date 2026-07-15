import { describe, expect, it } from 'vitest';
import {
  MAX_RETAINED_NOTIFICATION_IDS,
  NOTIFICATION_ID_TTL_MS,
  pruneFiredNotificationIds,
} from './Notifications.js';

describe('notification retention', () => {
  it('expires notification IDs after 24 hours', () => {
    const fired = new Map([['old', 0], ['current', 1]]);
    pruneFiredNotificationIds(fired, NOTIFICATION_ID_TTL_MS);
    expect([...fired.keys()]).toEqual(['current']);
  });

  it('caps retained notification IDs at 2,000 newest entries', () => {
    const fired = new Map<string, number>();
    for (let index = 0; index < MAX_RETAINED_NOTIFICATION_IDS + 10; index += 1) {
      fired.set(`id-${index}`, index);
    }
    pruneFiredNotificationIds(fired, MAX_RETAINED_NOTIFICATION_IDS + 10);
    expect(fired.size).toBe(MAX_RETAINED_NOTIFICATION_IDS);
    expect(fired.has('id-0')).toBe(false);
    expect(fired.has(`id-${MAX_RETAINED_NOTIFICATION_IDS + 9}`)).toBe(true);
  });
});
