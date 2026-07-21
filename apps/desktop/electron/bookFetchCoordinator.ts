export type BookFetchFailureKind = 'no-depth' | 'rate-limit' | 'transient' | 'other';

export type BookFetchFailureBackoffMs = Record<BookFetchFailureKind, number>;

export interface BookFetchCoordinatorOptions {
  successTtlMs: number;
  maxFailureBackoffMs?: number;
  failureBackoffMs?: Partial<BookFetchFailureBackoffMs>;
  /**
   * Per-kind ceilings on the exponential backoff. A rate-limited market must be
   * retried before its production provenance expires (90s TTL); left uncapped,
   * the exponential 'rate-limit' backoff (30s → 60s → 120s …) overshoots the TTL
   * on the third strike, so the market drops out of the tracked set and the
   * orderbook coverage decays below 25. Capping 'rate-limit' below the TTL keeps
   * every market eligible for re-verification while it is still backing off.
   */
  maxFailureBackoffMsByKind?: Partial<BookFetchFailureBackoffMs>;
  now?: () => number;
}

export interface BookFetchOptions {
  allowCachedSuccess?: boolean;
}

interface SuccessEntry<T> {
  value: T;
  fetchedAt: number;
}

interface FailureEntry {
  kind: BookFetchFailureKind;
  reason: string;
  failureCount: number;
  retryAt: number;
}

const DEFAULT_FAILURE_BACKOFF_MS: BookFetchFailureBackoffMs = {
  'no-depth': 15_000,
  'rate-limit': 30_000,
  transient: 5_000,
  other: 10_000,
};

// Bound the rate-limit backoff below the 90s production-provenance TTL so a
// rate-limited market always gets at least one more re-verification attempt
// before its proof lapses and it falls out of the tracked orderbook set.
const DEFAULT_MAX_FAILURE_BACKOFF_MS_BY_KIND: Partial<BookFetchFailureBackoffMs> = {
  'rate-limit': 60_000,
};

export class BookFetchBackoffError extends Error {
  readonly name = 'BookFetchBackoffError';

  constructor(
    readonly ticker: string,
    readonly kind: BookFetchFailureKind,
    readonly reason: string,
    readonly failureCount: number,
    readonly retryAt: number,
  ) {
    super(`book fetch backoff active for ${ticker}: ${reason}`);
  }
}

export function isBookFetchBackoffError(error: unknown): error is BookFetchBackoffError {
  return error instanceof BookFetchBackoffError;
}

export function classifyBookFetchFailure(error: unknown): BookFetchFailureKind {
  const reason = error instanceof Error ? error.message : String(error);
  if (/no executable depth/i.test(reason)) return 'no-depth';
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(reason)) return 'rate-limit';
  if (/fetch failed|abort|time[ -]?out|network|econn|enotfound|eai_again|socket/i.test(reason)) return 'transient';
  return 'other';
}

export class BookFetchCoordinator<T> {
  private readonly successful = new Map<string, SuccessEntry<T>>();
  private readonly failures = new Map<string, FailureEntry>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly now: () => number;
  private readonly failureBackoffMs: BookFetchFailureBackoffMs;
  private readonly maxFailureBackoffMs: number;
  private readonly maxFailureBackoffMsByKind: Partial<BookFetchFailureBackoffMs>;

  constructor(
    private readonly load: (ticker: string) => Promise<T>,
    private readonly options: BookFetchCoordinatorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.failureBackoffMs = { ...DEFAULT_FAILURE_BACKOFF_MS, ...options.failureBackoffMs };
    this.maxFailureBackoffMs = options.maxFailureBackoffMs ?? 5 * 60_000;
    this.maxFailureBackoffMsByKind = {
      ...DEFAULT_MAX_FAILURE_BACKOFF_MS_BY_KIND,
      ...options.maxFailureBackoffMsByKind,
    };
  }

  peek(ticker: string): T | null {
    const cached = this.successful.get(ticker);
    if (!cached || this.now() - cached.fetchedAt > this.options.successTtlMs) return null;
    return cached.value;
  }

  fetch(ticker: string, options: BookFetchOptions = {}): Promise<T> {
    if (options.allowCachedSuccess !== false) {
      const cached = this.peek(ticker);
      if (cached) return Promise.resolve(cached);
    }

    const active = this.inFlight.get(ticker);
    if (active) return active;

    const failed = this.failures.get(ticker);
    if (failed && this.now() < failed.retryAt) {
      return Promise.reject(new BookFetchBackoffError(
        ticker,
        failed.kind,
        failed.reason,
        failed.failureCount,
        failed.retryAt,
      ));
    }

    const task = Promise.resolve()
      .then(() => this.load(ticker))
      .then((value) => {
        this.successful.set(ticker, { value, fetchedAt: this.now() });
        this.failures.delete(ticker);
        return value;
      })
      .catch((error: unknown) => {
        this.successful.delete(ticker);
        const kind = classifyBookFetchFailure(error);
        const reason = error instanceof Error ? error.message : String(error);
        const previous = this.failures.get(ticker);
        const failureCount = previous?.kind === kind ? previous.failureCount + 1 : 1;
        const kindCeilingMs = this.maxFailureBackoffMsByKind[kind] ?? this.maxFailureBackoffMs;
        const delayMs = Math.min(
          this.maxFailureBackoffMs,
          kindCeilingMs,
          this.failureBackoffMs[kind] * (2 ** (failureCount - 1)),
        );
        this.failures.set(ticker, {
          kind,
          reason,
          failureCount,
          retryAt: this.now() + delayMs,
        });
        throw error;
      })
      .finally(() => {
        if (this.inFlight.get(ticker) === task) this.inFlight.delete(ticker);
      });

    this.inFlight.set(ticker, task);
    return task;
  }
}
