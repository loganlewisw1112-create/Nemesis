export interface AuditEntry {
  /**
   * Epoch ms. NOTE: this field is `t`, not `at` -- unlike every JSONL ledger in
   * `nemesis-data`. Analysis that filters audit rows on `e.at` silently returns
   * zero rows (this cost a full post-run analysis on 2026-07-27). Do not rename:
   * existing readers, including `audit-log.json` on disk, depend on `t`.
   */
  t: number;
  action: 'paper_buy' | 'paper_close' | 'paper_abort' | 'gate_block' | 'live_order' | 'kill_switch' | 'backtest';
  thesisId?: string;
  ticker?: string;
  detail: string;
  ok: boolean;
  code?: string;
  severity?: 'info' | 'warning' | 'error';
  blocksLiveUnlock?: boolean;
}

export interface AuditLogOptions {
  /** In-memory retention cap. Defaults to 5000 -- the historical, on-disk-compatible value. */
  maxEntries?: number;
  /**
   * Sink for entries leaving the in-memory ring, batched oldest-first. Supply
   * one (e.g. an append-only `audit-log.jsonl` writer) to make the log lossless;
   * without it, overflow is dropped exactly as it always was, but is now at
   * least counted by `evictedCount()`.
   */
  onEvict?: (evicted: AuditEntry[]) => void;
}

const DEFAULT_MAX_ENTRIES = 5000;

/**
 * A capped ring of audit entries.
 *
 * The 8-hour run of 2026-07-26 produced far more than 5000 entries, and the cap
 * silently discarded the last 2.6 hours -- the window that mattered -- with no
 * record that anything had been dropped. Eviction is now observable
 * (`evictedCount()`) and interceptable (`onEvict`), so a caller can persist what
 * leaves memory instead of losing it.
 */
export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly maxEntries: number;
  private readonly onEvict?: (evicted: AuditEntry[]) => void;
  private evicted = 0;

  constructor(options: AuditLogOptions = {}) {
    const requested = options.maxEntries;
    this.maxEntries =
      typeof requested === 'number' && Number.isFinite(requested) && requested > 0
        ? Math.floor(requested)
        : DEFAULT_MAX_ENTRIES;
    this.onEvict = options.onEvict;
  }

  append(entry: Omit<AuditEntry, 't'>) {
    this.entries.push({ ...entry, t: Date.now() });
    this.enforceCap();
  }

  list(): AuditEntry[] {
    return [...this.entries];
  }

  exportJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }

  load(entries: AuditEntry[]) {
    // Copy: the caller's array (typically a freshly parsed audit-log.json) must
    // not stay aliased to internal state.
    this.entries = [...entries];
    // An over-cap file is exactly the case that produced silent loss before, so
    // it goes through the same observable eviction path as a runtime overflow.
    this.enforceCap();
  }

  /** Total entries dropped from memory since construction, across append and load. */
  evictedCount(): number {
    return this.evicted;
  }

  private enforceCap() {
    const overflow = this.entries.length - this.maxEntries;
    if (overflow <= 0) return;
    const evicted = this.entries.slice(0, overflow);
    try {
      this.onEvict?.(evicted);
    } catch {
      // A failing sink must never corrupt the live log or propagate into a
      // trading path: the entries still leave memory, and the count still rises.
    }
    this.entries.splice(0, overflow);
    this.evicted += evicted.length;
  }
}
