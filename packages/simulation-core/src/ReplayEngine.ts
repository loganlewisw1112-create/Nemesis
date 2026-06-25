import type { ReplayEvent } from './types.js';

export class ReplayEngine {
  private readonly events: ReplayEvent[];
  private cursor = 0;
  private currentTime = 0;

  constructor(events: ReplayEvent[]) {
    this.events = [...events].sort((a, b) => a.timestamp - b.timestamp);
    this.currentTime = this.events[0]?.timestamp ?? 0;
  }

  seek(timestamp: number): ReplayEvent[] {
    this.cursor = this.events.findIndex((event) => event.timestamp > timestamp);
    if (this.cursor < 0) this.cursor = this.events.length;
    this.currentTime = timestamp;
    return this.events.filter((event) => event.timestamp <= timestamp);
  }

  step(speed: number, elapsedMs: number): ReplayEvent[] {
    this.currentTime += speed * elapsedMs;
    const emitted: ReplayEvent[] = [];
    while (this.cursor < this.events.length && this.events[this.cursor].timestamp <= this.currentTime) {
      emitted.push(this.events[this.cursor]);
      this.cursor += 1;
    }
    return emitted;
  }

  window(startTimestamp: number, endTimestamp: number): ReplayEvent[] {
    return this.events.filter((event) => event.timestamp >= startTimestamp && event.timestamp <= endTimestamp);
  }
}
