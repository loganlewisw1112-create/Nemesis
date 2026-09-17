export interface StateEnvelopeV2<T> {
  schemaVersion: 2;
  stream: string;
  revision: number;
  generatedAt: number;
  full?: readonly T[];
  upserts?: readonly T[];
  removals?: readonly string[];
}

export interface StateStreamStats {
  revision: number;
  itemCount: number;
  inFlight: number;
  pending: number;
  sent: number;
  failed: number;
}

function mapsEqual<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || right.get(key) !== value) return false;
  }
  return true;
}

/**
 * Maintains one in-flight message and one implicit, replaceable pending state.
 * The pending state is recomputed against the last delivered snapshot, so
 * overwritten bursts cannot lose a keyed removal or the newest value.
 */
export class VersionedStateStream<T> {
  private current = new Map<string, T>();
  private delivered = new Map<string, T>();
  private revision = 0;
  private hasDelivered = false;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSendAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private sent = 0;
  private failed = 0;

  constructor(
    private readonly stream: string,
    private readonly keyOf: (item: T) => string,
    private readonly send: (envelope: StateEnvelopeV2<T>) => void | Promise<void>,
    private readonly minIntervalMs = 0,
  ) {}

  replace(items: readonly T[], now = Date.now()): void {
    if (this.stopped) return;
    this.current = new Map(items.map((item) => [this.keyOf(item), item]));
    this.requestFlush(now);
  }

  update(upserts: readonly T[], removals: readonly string[] = [], now = Date.now()): void {
    if (this.stopped) return;
    for (const key of removals) this.current.delete(key);
    for (const item of upserts) this.current.set(this.keyOf(item), item);
    this.requestFlush(now);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current.clear();
    this.delivered.clear();
  }

  stats(): StateStreamStats {
    return {
      revision: this.revision,
      itemCount: this.current.size,
      inFlight: this.inFlight ? 1 : 0,
      pending: !mapsEqual(this.current, this.delivered) ? 1 : 0,
      sent: this.sent,
      failed: this.failed,
    };
  }

  private requestFlush(now: number): void {
    if (this.stopped || this.inFlight || this.timer || mapsEqual(this.current, this.delivered)) return;
    const elapsed = now - this.lastSendAt;
    const delay = Number.isFinite(elapsed) ? Math.max(0, this.minIntervalMs - elapsed) : 0;
    if (delay === 0) {
      this.flush(now);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush(Date.now());
    }, delay);
  }

  private flush(now: number): void {
    if (this.stopped || this.inFlight || mapsEqual(this.current, this.delivered)) return;
    const snapshot = new Map(this.current);
    const isInitial = !this.hasDelivered;
    const upserts = isInitial
      ? []
      : [...snapshot].filter(([key, value]) => !this.delivered.has(key) || this.delivered.get(key) !== value).map(([, value]) => value);
    const removals = isInitial ? [] : [...this.delivered.keys()].filter((key) => !snapshot.has(key));
    const envelope: StateEnvelopeV2<T> = {
      schemaVersion: 2,
      stream: this.stream,
      revision: ++this.revision,
      generatedAt: now,
      ...(isInitial ? { full: [...snapshot.values()] } : { upserts, removals }),
    };
    this.inFlight = true;
    this.lastSendAt = now;
    Promise.resolve(this.send(envelope)).then(() => {
      this.sent += 1;
      if (!this.stopped) {
        this.delivered = snapshot;
        this.hasDelivered = true;
      }
    }).catch(() => {
      this.failed += 1;
    }).finally(() => {
      this.inFlight = false;
      this.requestFlush(Date.now());
    });
  }
}
