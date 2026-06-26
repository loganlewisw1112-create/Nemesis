import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GEA_SCHEMA } from './localDb.js';

describe('GEA local database schema', () => {
  it('includes durable Kalshi orderbook snapshots for tape replay', () => {
    const schema = GEA_SCHEMA.join('\n');

    expect(schema).toContain('kalshi_orderbook_snapshot');
    expect(schema).toContain('yes_levels_json');
    expect(schema).toContain('no_levels_json');
  });

  it('includes public world data source, observation, and release tables', () => {
    const schema = GEA_SCHEMA.join('\n');

    expect(schema).toContain('public_data_source');
    expect(schema).toContain('public_data_observation');
    expect(schema).toContain('public_data_release');
    expect(schema).toContain('trust_tier');
  });

  it('includes settlement, event graph, retention, replay, and analytics tables', () => {
    const schema = GEA_SCHEMA.join('\n');

    for (const table of [
      'settlement_rule',
      'event_graph_node',
      'event_graph_edge',
      'hold_estimate',
      'profit_retention_state',
      'alpha_intercept_signal',
      'replay_autopsy',
      'model_tournament_result',
      'analytics_export',
    ]) {
      expect(schema).toContain(table);
    }
  });
  it('declares better-sqlite3 so GEA persistence is installed with the app workspace', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.['better-sqlite3']).toMatch(/^\^?\d+\.\d+\.\d+/);
  });
  it('rebuilds better-sqlite3 for Electron after installs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['rebuild:sqlite']).toContain('electron-rebuild');
    expect(pkg.scripts?.postinstall).toContain('rebuild:sqlite');
  });
});
