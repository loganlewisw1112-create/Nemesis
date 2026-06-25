import type { JournalEntry, ThesisCard } from '@nemesis/core';

export class JournalStore {
  private entries: JournalEntry[] = [];

  addFromThesis(card: ThesisCard, notes = ''): JournalEntry {
    const entry: JournalEntry = {
      id: `j-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      ticker: card.ticker,
      marketTitle: card.title,
      module: card.playbook,
      signalReason: card.signalReason,
      side: card.side,
      entryPrice: card.marketPrice,
      spread: card.spread,
      feeEstimate: card.feeEstimate,
      exitRule: 'time-stop',
      result: 'pending',
      notes,
      mistakeTags: [],
    };
    this.entries.unshift(entry);
    return entry;
  }

  list(): JournalEntry[] {
    return [...this.entries];
  }

  count(): number {
    return this.entries.length;
  }

  load(entries: JournalEntry[]) {
    this.entries = entries;
  }

  exportCsv(): string {
    const headers = [
      'timestamp', 'ticker', 'market', 'module', 'signal', 'side', 'entry',
      'spread', 'fee', 'exit', 'result', 'net', 'notes', 'mistakes',
    ];
    const rows = this.entries.map((e) =>
      [
        new Date(e.timestamp).toISOString(),
        e.ticker,
        e.marketTitle,
        e.module,
        e.signalReason,
        e.side,
        e.entryPrice,
        e.spread,
        e.feeEstimate,
        e.exitRule,
        e.result ?? '',
        e.netEstimate ?? '',
        e.notes,
        e.mistakeTags.join(';'),
      ].join(','),
    );
    return [headers.join(','), ...rows].join('\n');
  }
}
