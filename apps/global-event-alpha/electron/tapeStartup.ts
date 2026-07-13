import type { NemesisStateMirror } from '@nemesis/bridge-contracts';

export interface TapeStartupCoordinatorOptions {
  coordinated: boolean;
  fallbackMs: number;
  startTape: () => void;
}

export class TapeStartupCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(private readonly options: TapeStartupCoordinatorOptions) {}

  begin() {
    if (this.started) return;
    if (!this.options.coordinated) {
      this.start();
      return;
    }
    this.timer = setTimeout(() => this.start(), this.options.fallbackMs);
  }

  observeNemesisState(state: NemesisStateMirror) {
    if (state.marketFeedReady === true) this.start();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private start() {
    if (this.started) return;
    this.started = true;
    this.dispose();
    this.options.startTape();
  }
}
