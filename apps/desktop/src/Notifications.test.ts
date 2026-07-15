import { describe, expect, it } from 'vitest';
import {
  MAX_RETAINED_NOTIFICATION_IDS,
  MAX_NEW_OPPORTUNITY_NOTIFICATIONS_PER_UPDATE,
  NOTIFICATION_ID_TTL_MS,
  pruneFiredNotificationIds,
  selectNewOpportunityNotifications,
} from './Notifications.js';
import type { ThesisCard } from '@nemesis/core';

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

  it('bounds each new-opportunity burst and keeps the highest executable edges', () => {
    const cards = Array.from({ length: 10 }, (_, index) => ({
      id: `card-${index}`,
      netEdge: 0.03 + index / 1_000,
      status: 'tradeable',
    })) as ThesisCard[];
    const selected = selectNewOpportunityNotifications(cards, new Set(['card-9']));

    expect(selected).toHaveLength(MAX_NEW_OPPORTUNITY_NOTIFICATIONS_PER_UPDATE);
    expect(selected.map((card) => card.id)).toEqual(['card-8', 'card-7', 'card-6']);
  });
});
