export interface AuditEntry {
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

export class AuditLog {
  private entries: AuditEntry[] = [];

  append(entry: Omit<AuditEntry, 't'>) {
    this.entries.push({ ...entry, t: Date.now() });
    if (this.entries.length > 5000) this.entries.shift();
  }

  list(): AuditEntry[] {
    return [...this.entries];
  }

  exportJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }

  load(entries: AuditEntry[]) {
    this.entries = entries;
  }
}
