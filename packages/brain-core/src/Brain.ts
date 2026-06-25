import type { BrainInstance, BrainOutputDraft } from './types.js';

export abstract class Brain {
  protected readonly instance: BrainInstance;

  protected constructor(instance: BrainInstance) {
    this.instance = instance;
  }

  get health(): BrainInstance {
    return { ...this.instance };
  }

  heartbeat(now = Date.now()): BrainInstance {
    this.instance.last_heartbeat = now;
    this.instance.missed_heartbeats = 0;
    return this.health;
  }

  abstract evaluate(event: unknown): BrainOutputDraft | null;
}
