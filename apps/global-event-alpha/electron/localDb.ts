import type {
  KalshiMarketSnapshotRecord,
  KalshiOrderbookSnapshotRecord,
  KalshiTapeSink,
  KalshiTradePrintRecord,
  PublicDataMeshSink,
  PublicDataObservationRecord,
  PublicDataReleaseRecord,
  PublicDataSourceRecord,
} from '@nemesis/connectors';

export const GEA_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS brain_instance (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    model_version TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS brain_failover_event (
    id TEXT PRIMARY KEY,
    from_role TEXT NOT NULL,
    to_role TEXT NOT NULL,
    reason TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS brain_output_packet (
    id TEXT PRIMARY KEY,
    brain_id TEXT,
    ticker TEXT NOT NULL,
    classification TEXT NOT NULL,
    alpha_score REAL NOT NULL,
    expires_at INTEGER NOT NULL,
    packet_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kalshi_market_snapshot (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    yes_bid REAL,
    yes_ask REAL,
    yes_price REAL NOT NULL DEFAULT 0.5,
    no_bid REAL,
    no_ask REAL,
    volume REAL,
    spread REAL,
    timestamp INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'rest-market'
  )`,
  `CREATE TABLE IF NOT EXISTS kalshi_trade_print (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    yes_price REAL NOT NULL,
    count INTEGER NOT NULL,
    taker_side TEXT NOT NULL,
    created_time TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kalshi_orderbook_snapshot (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    yes_levels_json TEXT NOT NULL,
    no_levels_json TEXT NOT NULL,
    best_yes_bid REAL,
    yes_ask REAL,
    no_ask REAL,
    spread REAL,
    timestamp INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS public_data_source (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    trust_tier INTEGER NOT NULL,
    stale_after_ms INTEGER NOT NULL,
    last_success INTEGER,
    last_error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS public_data_observation (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    metadata_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS public_data_release (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    summary TEXT NOT NULL,
    trust_tier INTEGER NOT NULL,
    metadata_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS probability_tribunal_result (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    nemesis_probability REAL NOT NULL,
    confidence_band_low REAL NOT NULL,
    confidence_band_high REAL NOT NULL,
    model_agreement_score REAL NOT NULL,
    result_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS edge_estimate (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    raw_edge REAL NOT NULL,
    net_edge REAL NOT NULL,
    entry_zone_low REAL NOT NULL,
    entry_zone_high REAL NOT NULL,
    do_not_chase_level REAL NOT NULL,
    estimate_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS ticket_card (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    classification TEXT NOT NULL,
    alpha_score REAL NOT NULL,
    hold_class TEXT NOT NULL,
    target_exit REAL NOT NULL,
    status TEXT NOT NULL,
    card_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS no_trade_decision (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    block_reason TEXT NOT NULL,
    what_would_need_to_change TEXT NOT NULL,
    recheck_at INTEGER NOT NULL,
    decision_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settlement_rule (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    source TEXT NOT NULL,
    rule_text TEXT NOT NULL,
    clarity_score REAL NOT NULL,
    gate_passed INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    rule_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_graph_node (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    node_type TEXT NOT NULL,
    label TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS event_graph_edge (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    relation TEXT NOT NULL,
    weight REAL NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hold_estimate (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    hold_class TEXT NOT NULL,
    hold_window_ms INTEGER NOT NULL,
    edge_shelf_life_ms INTEGER NOT NULL,
    recheck_at INTEGER NOT NULL,
    estimate_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS profit_retention_state (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    action TEXT NOT NULL,
    current_edge REAL NOT NULL,
    captured_edge REAL NOT NULL,
    reason TEXT NOT NULL,
    state_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS alpha_intercept_signal (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    signal TEXT NOT NULL,
    strength REAL NOT NULL,
    reason TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    signal_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS replay_autopsy (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    replay_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    autopsy_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS model_tournament_result (
    id TEXT PRIMARY KEY,
    replay_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    rank INTEGER NOT NULL,
    pnl REAL NOT NULL,
    hit_rate REAL NOT NULL,
    brier_score REAL NOT NULL,
    result_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS analytics_export (
    id TEXT PRIMARY KEY,
    export_type TEXT NOT NULL,
    target TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sandbox_session (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    strategy_id TEXT,
    model_version TEXT NOT NULL,
    starting_balance REAL NOT NULL,
    status TEXT NOT NULL,
    session_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sandbox_strategy (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rules_json TEXT NOT NULL,
    risk_rules_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sandbox_simulated_fill (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    order_id TEXT,
    fill_price REAL NOT NULL,
    slippage REAL NOT NULL,
    fees REAL NOT NULL,
    fill_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sandbox_result_metric (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value REAL NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_event (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    brain_id TEXT,
    ticker TEXT,
    detail TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  )`,
];

export interface GeaDatabaseStatus {
  available: boolean;
  path: string;
  migrationsApplied: number;
  error?: string;
}

type BetterSqliteCtor = new (path: string) => { exec: (sql: string) => void };
type SqliteStatement = {
  run: (params?: unknown) => unknown;
  all: (...params: unknown[]) => unknown[];
};
type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close?: () => void;
};
type BetterSqliteStoreCtor = new (path: string) => SqliteDatabase;

export interface GeaLocalStore extends KalshiTapeSink, PublicDataMeshSink {
  listMarketSnapshots(limit?: number): KalshiMarketSnapshotRecord[];
  listTradePrints(limit?: number): KalshiTradePrintRecord[];
  listOrderbookSnapshots(limit?: number): KalshiOrderbookSnapshotRecord[];
  listPublicDataSources(): PublicDataSourceRecord[];
  listPublicDataObservations(limit?: number): PublicDataObservationRecord[];
  listPublicDataReleases(limit?: number): PublicDataReleaseRecord[];
  close(): void;
}

const KALSHI_MARKET_SNAPSHOT_COLUMNS = [
  ['yes_price', 'REAL NOT NULL DEFAULT 0.5'],
  ['no_bid', 'REAL'],
  ['no_ask', 'REAL'],
  ['spread', 'REAL'],
  ['source', "TEXT NOT NULL DEFAULT 'rest-market'"],
] as const;

export async function migrateGeaDatabase(path: string): Promise<GeaDatabaseStatus> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const mod = await dynamicImport('better-sqlite3') as { default?: BetterSqliteCtor } & BetterSqliteCtor;
    const Database = mod.default ?? mod;
    const db = new Database(path) as SqliteDatabase;
    for (const statement of GEA_SCHEMA) db.exec(statement);
    ensureMarketSnapshotColumns(db);
    db.close?.();
    return { available: true, path, migrationsApplied: GEA_SCHEMA.length };
  } catch (err) {
    return {
      available: false,
      path,
      migrationsApplied: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function createGeaLocalStore(path: string): Promise<GeaLocalStore | null> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
    const mod = await dynamicImport('better-sqlite3') as { default?: BetterSqliteStoreCtor } & BetterSqliteStoreCtor;
    const Database = mod.default ?? mod;
    const db = new Database(path);
    for (const statement of GEA_SCHEMA) db.exec(statement);
    ensureMarketSnapshotColumns(db);

    const insertMarket = db.prepare(`
      INSERT OR REPLACE INTO kalshi_market_snapshot (
        id, ticker, yes_bid, yes_ask, yes_price, no_bid, no_ask, volume, spread, timestamp, source
      ) VALUES (
        @id, @ticker, @yes_bid, @yes_ask, @yes_price, @no_bid, @no_ask, @volume, @spread, @timestamp, @source
      )
    `);
    const insertTrade = db.prepare(`
      INSERT OR REPLACE INTO kalshi_trade_print (
        id, ticker, yes_price, count, taker_side, created_time
      ) VALUES (
        @id, @ticker, @yes_price, @count, @taker_side, @created_time
      )
    `);
    const insertBook = db.prepare(`
      INSERT OR REPLACE INTO kalshi_orderbook_snapshot (
        id, ticker, yes_levels_json, no_levels_json, best_yes_bid, yes_ask, no_ask, spread, timestamp
      ) VALUES (
        @id, @ticker, @yes_levels_json, @no_levels_json, @best_yes_bid, @yes_ask, @no_ask, @spread, @timestamp
      )
    `);
    const listMarkets = db.prepare('SELECT * FROM kalshi_market_snapshot ORDER BY timestamp DESC LIMIT ?');
    const listTrades = db.prepare('SELECT * FROM kalshi_trade_print ORDER BY created_time DESC LIMIT ?');
    const listBooks = db.prepare('SELECT * FROM kalshi_orderbook_snapshot ORDER BY timestamp DESC LIMIT ?');
    const insertPublicSource = db.prepare(`
      INSERT OR REPLACE INTO public_data_source (
        id, name, category, trust_tier, stale_after_ms, last_success, last_error
      ) VALUES (
        @id, @name, @category, @trust_tier, @stale_after_ms, @last_success, @last_error
      )
    `);
    const insertPublicObservation = db.prepare(`
      INSERT OR REPLACE INTO public_data_observation (
        id, source_id, key, value, unit, timestamp, observed_at, metadata_json
      ) VALUES (
        @id, @source_id, @key, @value, @unit, @timestamp, @observed_at, @metadata_json
      )
    `);
    const insertPublicRelease = db.prepare(`
      INSERT OR REPLACE INTO public_data_release (
        id, source_id, title, url, published_at, observed_at, summary, trust_tier, metadata_json
      ) VALUES (
        @id, @source_id, @title, @url, @published_at, @observed_at, @summary, @trust_tier, @metadata_json
      )
    `);
    const listPublicSources = db.prepare('SELECT * FROM public_data_source ORDER BY trust_tier ASC, id ASC');
    const listPublicObservations = db.prepare('SELECT * FROM public_data_observation ORDER BY observed_at DESC LIMIT ?');
    const listPublicReleases = db.prepare('SELECT * FROM public_data_release ORDER BY observed_at DESC LIMIT ?');

    return {
      insertMarketSnapshot: (snapshot) => { insertMarket.run(snapshot); },
      insertTradePrint: (trade) => { insertTrade.run(trade); },
      insertOrderbookSnapshot: (book) => { insertBook.run(book); },
      insertPublicDataSource: (source) => { insertPublicSource.run(source); },
      insertPublicDataObservation: (observation) => { insertPublicObservation.run(observation); },
      insertPublicDataRelease: (release) => { insertPublicRelease.run(release); },
      listMarketSnapshots: (limit = 50) => listMarkets.all(limit) as KalshiMarketSnapshotRecord[],
      listTradePrints: (limit = 50) => listTrades.all(limit) as KalshiTradePrintRecord[],
      listOrderbookSnapshots: (limit = 50) => listBooks.all(limit) as KalshiOrderbookSnapshotRecord[],
      listPublicDataSources: () => listPublicSources.all() as PublicDataSourceRecord[],
      listPublicDataObservations: (limit = 50) => listPublicObservations.all(limit) as PublicDataObservationRecord[],
      listPublicDataReleases: (limit = 50) => listPublicReleases.all(limit) as PublicDataReleaseRecord[],
      close: () => db.close?.(),
    };
  } catch {
    return null;
  }
}

function ensureMarketSnapshotColumns(db: SqliteDatabase) {
  const columns = db.prepare('PRAGMA table_info(kalshi_market_snapshot)').all() as Array<{ name?: string }>;
  const names = new Set(columns.map((column) => column.name));
  for (const [name, ddl] of KALSHI_MARKET_SNAPSHOT_COLUMNS) {
    if (!names.has(name)) db.exec(`ALTER TABLE kalshi_market_snapshot ADD COLUMN ${name} ${ddl}`);
  }
}
