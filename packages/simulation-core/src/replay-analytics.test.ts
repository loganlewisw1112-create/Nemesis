import { describe, expect, it } from 'vitest';
import {
  AnalyticsExporter,
  ModelTournament,
  ReplayEngine,
  TicketAutopsy,
  type ReplayEvent,
} from './index.js';

const events: ReplayEvent[] = [
  { id: 's1', timestamp: 100, type: 'snapshot', payload: { ticker: 'KXTEST', price: 0.42 } },
  { id: 'p1', timestamp: 150, type: 'public-data', payload: { source: 'eia', value: 82 } },
  { id: 'b1', timestamp: 200, type: 'brain-output', payload: { ticker: 'KXTEST', probability: 0.58 } },
  { id: 'd1', timestamp: 250, type: 'decision', payload: { ticker: 'KXTEST', action: 'watch' } },
];

describe('historical replay analytics', () => {
  it('builds ticket autopsy decision paths from replay events', () => {
    const autopsy = TicketAutopsy.fromEvents('KXTEST', events);

    expect(autopsy.ticker).toBe('KXTEST');
    expect(autopsy.decision_path.map((step) => step.event_type)).toEqual(['snapshot', 'brain-output', 'decision']);
    expect(autopsy.summary).toContain('3 decision events');
  });

  it('runs model tournaments and ranks model versions by metrics', () => {
    const tournament = ModelTournament.run({
      replay_id: 'replay-1',
      models: [
        { model_version: 'alpha-v1', predictions: [0.6, 0.4], actuals: [1, 0], pnl: [12, 4] },
        { model_version: 'alpha-v0', predictions: [0.4, 0.7], actuals: [1, 0], pnl: [-5, -7] },
      ],
    });

    expect(tournament.results[0]).toMatchObject({ model_version: 'alpha-v1', rank: 1 });
    expect(tournament.results[0].metrics.pnl).toBe(16);
  });

  it('exports replay analytics to JSON and CSV', () => {
    const autopsy = TicketAutopsy.fromEvents('KXTEST', events);

    expect(JSON.parse(AnalyticsExporter.toJson(autopsy))).toMatchObject({ ticker: 'KXTEST' });
    expect(AnalyticsExporter.toCsv([{ ticker: 'KXTEST', pnl: 12, hit_rate: 0.8 }])).toContain('ticker,pnl,hit_rate');
  });

  it('supports bounded timeline windows for scrubbers', () => {
    const engine = new ReplayEngine(events);

    expect(engine.window(100, 210).map((event) => event.id)).toEqual(['s1', 'p1', 'b1']);
  });
});
