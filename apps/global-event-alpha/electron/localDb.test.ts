import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  GEA_SCHEMA,
  copyLegacyGeaDatabaseIfMissing,
  legacyGeaDatabasePath,
  resolveGeaDatabasePath,
} from './localDb.js';

describe('GEA local database schema', () => {
  it('includes durable Kalshi orderbook snapshots for tape replay', () => {
    const schema = GEA_SCHEMA.join('\n');

    expect(schema).toContain('kalshi_orderbook_snapshot');
    expect(schema).toContain('yes_levels_json');
    expect(schema).toContain('no_levels_json');
    expect(schema).toContain('observed_at');
    expect(schema).toContain('exchange_timestamp');
    expect(schema).toContain('exchange_sequence');
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
  it('includes durable no-trade decision evidence', () => {
    const schema = GEA_SCHEMA.join('\n');

    expect(schema).toContain('no_trade_decision');
    expect(schema).toContain('block_reason');
    expect(schema).toContain('what_would_need_to_change');
    expect(schema).toContain('decision_json');
  });
  it('declares better-sqlite3 so GEA persistence is installed with the app workspace', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(pkg.dependencies?.['better-sqlite3']).toMatch(/^\^?\d+\.\d+\.\d+/);
  });
  it('rebuilds better-sqlite3 for Electron during packaging', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['rebuild:sqlite']).toContain('electron-rebuild');
    expect(pkg.scripts?.postinstall).toBeUndefined();
    expect(pkg.scripts?.package).toContain('rebuild:sqlite');
    expect(pkg.scripts?.package).toContain('electron-builder');
  });

  it('resolves the normal product SQLite path from GEA user data', () => {
    expect(resolveGeaDatabasePath('C:\\Users\\logan\\AppData\\Roaming\\@nemesis\\global-event-alpha'))
      .toBe(path.join('C:\\Users\\logan\\AppData\\Roaming\\@nemesis\\global-event-alpha', 'global-event-alpha.sqlite'));
  });

  it('copies the legacy Electron SQLite database only when the product database is missing', () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-gea-db-'));
    try {
      const appData = path.join(root, 'AppData', 'Roaming');
      const userData = path.join(appData, '@nemesis', 'global-event-alpha');
      const legacyPath = legacyGeaDatabasePath(appData);
      const productPath = resolveGeaDatabasePath(userData);

      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, 'legacy-db');

      expect(copyLegacyGeaDatabaseIfMissing(productPath, legacyPath)).toBe(true);
      expect(fs.readFileSync(productPath, 'utf8')).toBe('legacy-db');

      fs.writeFileSync(productPath, 'product-db');
      expect(copyLegacyGeaDatabaseIfMissing(productPath, legacyPath)).toBe(false);
      expect(fs.readFileSync(productPath, 'utf8')).toBe('product-db');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
