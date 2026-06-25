import type { PlaybookId } from '@nemesis/core';

export interface PlaybookStats {
  playbook: PlaybookId;
  signals: number;
  wins: number;
  losses: number;
  staleRate: number;
  disagreementRate: number;
  fillDrag: number;
}

export class StrategyQuarantine {
  private frozen = new Set<PlaybookId>();

  evaluate(stats: PlaybookStats): boolean {
    const winRate = stats.signals > 0 ? stats.wins / stats.signals : 0;
    if (stats.signals >= 20 && winRate < 0.35) {
      this.frozen.add(stats.playbook);
      return true;
    }
    if (stats.staleRate > 0.4 || stats.disagreementRate > 0.5) {
      this.frozen.add(stats.playbook);
      return true;
    }
    return false;
  }

  isFrozen(playbook: PlaybookId): boolean {
    return this.frozen.has(playbook);
  }

  release(playbook: PlaybookId) {
    this.frozen.delete(playbook);
  }

  listFrozen(): PlaybookId[] {
    return [...this.frozen];
  }
}
