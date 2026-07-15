import type {
  KalshiEvent,
  KalshiMarket,
  KalshiMarketsResponse,
  KalshiOrderbook,
  KalshiSeries,
  KalshiTrade,
  KalshiTradesResponse,
  KalshiEndpointClass,
  KalshiEndpointPolicy,
  KalshiEnvironment,
  KalshiFailureClass,
  OrderbookLevel,
} from '../types.js';
import { resilientFetch, sleep } from '../http/resilientFetch.js';

export const KALSHI_ENDPOINT_POLICIES: Readonly<Record<KalshiEnvironment, KalshiEndpointPolicy>> = {
  production: {
    environment: 'production',
    restBaseUrls: [
      'https://external-api.kalshi.com/trade-api/v2',
      'https://api.elections.kalshi.com/trade-api/v2',
    ],
    websocketUrls: [
      'wss://external-api-ws.kalshi.com/trade-api/ws/v2',
      'wss://api.elections.kalshi.com/trade-api/ws/v2',
    ],
  },
  demo: {
    environment: 'demo',
    restBaseUrls: [
      'https://external-api.demo.kalshi.co/trade-api/v2',
      'https://demo-api.kalshi.co/trade-api/v2',
    ],
    websocketUrls: [
      'wss://external-api-ws.demo.kalshi.co/trade-api/ws/v2',
      'wss://demo-api.kalshi.co/trade-api/ws/v2',
    ],
  },
};

export const KALSHI_API_BASE = KALSHI_ENDPOINT_POLICIES.production.restBaseUrls[0];
export const KALSHI_API_BASES = KALSHI_ENDPOINT_POLICIES.production.restBaseUrls;

export function getKalshiEndpointPolicy(environment: KalshiEnvironment = 'production'): KalshiEndpointPolicy {
  return KALSHI_ENDPOINT_POLICIES[environment];
}

export function getKalshiWebSocketUrl(environment: KalshiEnvironment = 'production'): string {
  return getKalshiEndpointPolicy(environment).websocketUrls[0];
}

export interface FetchOptions {
  baseUrl?: string;
  environment?: KalshiEnvironment;
  endpointClass?: KalshiEndpointClass;
  fetchFn?: typeof fetch;
  limit?: number;
  status?: string;
  cursor?: string;
  authHeaders?: Record<string, string>;
  signal?: AbortSignal;
}

function centsToProb(v: number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  return v / 100;
}

function dollarToProb(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

export function isExecutablePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
}

function executableCentsToProb(v: number | undefined): number | undefined {
  const p = centsToProb(v);
  return isExecutablePrice(p) ? p : undefined;
}

function executableDollarToProb(v: string | undefined): number | undefined {
  const p = dollarToProb(v);
  return isExecutablePrice(p) ? p : undefined;
}

export function normalizeExecutablePrice(market: KalshiMarket, side: 'yes' | 'no' = 'yes'): number | null {
  const price = side === 'yes'
    ? (
      executableDollarToProb(market.yes_ask_dollars) ??
      executableCentsToProb(market.yes_ask) ??
      executableDollarToProb(market.yes_bid_dollars) ??
      executableCentsToProb(market.yes_bid)
    )
    : (
      executableDollarToProb(market.no_ask_dollars) ??
      executableCentsToProb(market.no_ask) ??
      executableDollarToProb(market.no_bid_dollars) ??
      executableCentsToProb(market.no_bid)
    );
  return price ?? null;
}

export function normalizeMarketPrice(market: KalshiMarket, side: 'yes' | 'no' = 'yes'): number {
  if (side === 'yes') {
    return (
      dollarToProb(market.yes_ask_dollars) ??
      centsToProb(market.yes_ask) ??
      dollarToProb(market.yes_bid_dollars) ??
      centsToProb(market.yes_bid) ??
      0.5
    );
  }
  return (
    dollarToProb(market.no_ask_dollars) ??
    centsToProb(market.no_ask) ??
    dollarToProb(market.no_bid_dollars) ??
    centsToProb(market.no_bid) ??
    0.5
  );
}

/**
 * Convert Kalshi's current fixed-point liquidity strings into the legacy numeric
 * fields used internally. Keeping this at the REST boundary prevents callers
 * from silently ranking every current-schema market as zero-volume.
 */
export function normalizeKalshiMarket(market: KalshiMarket): KalshiMarket {
  const volume = finiteNumber(market.volume_fp ?? market.volume);
  const volume24h = finiteNumber(market.volume_24h_fp ?? market.volume_24h);
  const openInterest = finiteNumber(market.open_interest_fp ?? market.open_interest);

  return {
    ...market,
    volume: volume ?? market.volume,
    volume_24h: volume24h ?? market.volume_24h,
    open_interest: openInterest ?? market.open_interest,
  };
}

export function parseOrderbook(ticker: string, raw: Record<string, unknown>): KalshiOrderbook {
  const books = [raw.orderbook, raw.orderbook_fp, raw]
    .filter((book): book is Record<string, unknown> => typeof book === 'object' && book !== null);

  const parseNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const parseLevels = (side: unknown, quotedInDollars: boolean): OrderbookLevel[] => {
    if (!Array.isArray(side)) return [];
    return side
      .map((row: unknown) => {
        if (Array.isArray(row) && row.length >= 2) {
          const rawPrice = parseNumber(row[0]);
          const quantity = parseNumber(row[1]);
          if (rawPrice === null || quantity === null) return null;
          const price = quotedInDollars ? rawPrice : (rawPrice > 1 ? rawPrice / 100 : rawPrice);
          return { price, quantity };
        }
        return null;
      })
      .filter((x): x is OrderbookLevel => x !== null)
      .sort((a, b) => b.price - a.price);
  };

  const collectLevels = (centsKey: 'yes' | 'no', dollarsKey: 'yes_dollars' | 'no_dollars') => {
    const cents = books.flatMap((book) => parseLevels(book[centsKey], false));
    if (cents.length > 0) return cents.sort((a, b) => b.price - a.price);
    return books.flatMap((book) => parseLevels(book[dollarsKey], true)).sort((a, b) => b.price - a.price);
  };

  const yes = collectLevels('yes', 'yes_dollars');
  const no = collectLevels('no', 'no_dollars');
  const bestYesBid = yes[0]?.price;
  const bestNoBid = no[0]?.price;
  const yesAsk = bestNoBid !== undefined ? 1 - bestNoBid : undefined;
  const noAsk = bestYesBid !== undefined ? 1 - bestYesBid : undefined;
  const spread = yesAsk !== undefined && bestYesBid !== undefined ? yesAsk - bestYesBid : undefined;

  const firstMetadataValue = (...keys: string[]): unknown => {
    for (const book of books) {
      for (const key of keys) {
        if (book[key] !== undefined) return book[key];
      }
    }
    return undefined;
  };
  const parseTimestamp = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1_000_000_000_000) return value;
      if (value > 1_000_000_000) return value * 1_000;
    }
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return parseTimestamp(numeric);
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const sourceTimestamp = parseTimestamp(firstMetadataValue('ts_ms', 'timestamp_ms', 'ts', 'timestamp'));
  const rawSequence = parseNumber(firstMetadataValue('seq', 'sequence'));
  const sequence = rawSequence == null ? undefined : Math.trunc(rawSequence);

  return { ticker, yes, no, yesAsk, noAsk, spread, sourceTimestamp, sequence };
}

export function sanitizeExecutableBook(book: KalshiOrderbook): KalshiOrderbook {
  const cleanLevels = (levels: OrderbookLevel[]) => levels
    .filter((level) => isExecutablePrice(level.price) && Number.isFinite(level.quantity) && level.quantity > 0)
    .map((level) => ({ price: level.price, quantity: level.quantity }))
    .sort((a, b) => b.price - a.price);

  const yes = cleanLevels(book.yes);
  const no = cleanLevels(book.no);
  const yesAsk = isExecutablePrice(book.yesAsk) ? book.yesAsk : undefined;
  const noAsk = isExecutablePrice(book.noAsk) ? book.noAsk : undefined;
  const spread = Number.isFinite(book.spread) && book.spread !== undefined && book.spread >= 0
    ? book.spread
    : undefined;

  return {
    ticker: book.ticker,
    yes,
    no,
    yesAsk,
    noAsk,
    spread,
    sourceTimestamp: book.sourceTimestamp,
    sequence: book.sequence,
    receivedAt: book.receivedAt,
    priceLevelStructure: book.priceLevelStructure,
    feePolicy: book.feePolicy,
  };
}

const workingBases = new Map<string, string>();
const KALSHI_READ_REQUEST_INTERVAL_MS = 125;
const KALSHI_DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;
const KALSHI_MAX_RATE_LIMIT_BACKOFF_MS = 30_000;

interface KalshiReadThrottleState {
  nextRequestAt: number;
  blockedUntil: number;
  consecutiveRateLimits: number;
  tail: Promise<void>;
}

const readThrottleByEnvironment = new Map<KalshiEnvironment, KalshiReadThrottleState>();

function readThrottle(environment: KalshiEnvironment): KalshiReadThrottleState {
  let state = readThrottleByEnvironment.get(environment);
  if (!state) {
    state = {
      nextRequestAt: 0,
      blockedUntil: 0,
      consecutiveRateLimits: 0,
      tail: Promise.resolve(),
    };
    readThrottleByEnvironment.set(environment, state);
  }
  return state;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Kalshi request aborted');
}

async function awaitAbortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function acquireReadRequestSlot(environment: KalshiEnvironment, signal?: AbortSignal): Promise<void> {
  const state = readThrottle(environment);
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const previous = state.tail;
  state.tail = previous.then(() => turn);
  try {
    await awaitAbortable(previous, signal);
  } catch (error) {
    release();
    throw error;
  }
  try {
    if (signal?.aborted) throw abortReason(signal);
    const waitMs = Math.max(0, state.nextRequestAt - Date.now(), state.blockedUntil - Date.now());
    if (waitMs > 0) await awaitAbortable(sleep(waitMs), signal);
    if (signal?.aborted) throw abortReason(signal);
    state.nextRequestAt = Date.now() + KALSHI_READ_REQUEST_INTERVAL_MS;
  } finally {
    release();
  }
}

function applyReadRateLimit(environment: KalshiEnvironment, serverRetryAfterMs: number | null, now = Date.now()): number {
  const state = readThrottle(environment);
  state.consecutiveRateLimits += 1;
  const exponentialBackoffMs = Math.min(
    KALSHI_MAX_RATE_LIMIT_BACKOFF_MS,
    KALSHI_DEFAULT_RATE_LIMIT_BACKOFF_MS * (2 ** Math.max(0, state.consecutiveRateLimits - 1)),
  );
  const backoffMs = Math.max(exponentialBackoffMs, serverRetryAfterMs ?? 0);
  state.blockedUntil = Math.max(state.blockedUntil, now + backoffMs);
  return Math.max(0, state.blockedUntil - now);
}

function recordReadSuccess(environment: KalshiEnvironment): void {
  const state = readThrottle(environment);
  if (Date.now() < state.blockedUntil) return;
  state.consecutiveRateLimits = 0;
  state.blockedUntil = 0;
}

export interface KalshiHostHealth {
  environment: KalshiEnvironment;
  endpointClass: KalshiEndpointClass;
  baseUrl: string;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failureCount: number;
  failureClass: KalshiFailureClass | null;
}
const hostHealth = new Map<string, Map<string, KalshiHostHealth>>();

/** Clears learned host affinity; primarily useful for deterministic process restart and tests. */
export function resetKalshiHostCache(): void {
  workingBases.clear();
  hostHealth.clear();
  readThrottleByEnvironment.clear();
}

export function getKalshiHostHealth(): KalshiHostHealth[] {
  return [...hostHealth.values()].flatMap((byHost) => [...byHost.values()].map((health) => ({ ...health })));
}

function recordHostResult(
  environment: KalshiEnvironment,
  endpointClass: KalshiEndpointClass,
  baseUrl: string,
  failureClass: KalshiFailureClass | null,
): void {
  const key = cacheKey(environment, endpointClass);
  let byHost = hostHealth.get(key);
  if (!byHost) {
    byHost = new Map();
    hostHealth.set(key, byHost);
  }
  const previous = byHost.get(baseUrl);
  byHost.set(baseUrl, {
    environment,
    endpointClass,
    baseUrl,
    lastSuccessAt: failureClass === null ? Date.now() : previous?.lastSuccessAt ?? null,
    lastFailureAt: failureClass === null ? previous?.lastFailureAt ?? null : Date.now(),
    failureCount: failureClass === null ? 0 : (previous?.failureCount ?? 0) + 1,
    failureClass,
  });
}

function endpointClassFor(path: string, explicit?: KalshiEndpointClass): KalshiEndpointClass {
  if (explicit) return explicit;
  if (path.startsWith('/portfolio/orders')) return 'orders';
  if (path.startsWith('/portfolio/')) return 'portfolio';
  return 'market-data';
}

function cacheKey(environment: KalshiEnvironment, endpointClass: KalshiEndpointClass): string {
  return `${environment}:${endpointClass}`;
}

function validatedBases(opts: FetchOptions): readonly string[] {
  const environment = opts.environment ?? 'production';
  const policy = getKalshiEndpointPolicy(environment);
  if (!opts.baseUrl) return policy.restBaseUrls;
  if (!policy.restBaseUrls.includes(opts.baseUrl)) {
    throw new KalshiRequestFailure('Kalshi base URL is outside the selected environment policy', {
      classification: 'authorization',
      environment,
      endpointClass: opts.endpointClass ?? 'market-data',
      path: '(endpoint-policy)',
      baseUrl: opts.baseUrl,
    });
  }
  return [opts.baseUrl];
}

function retryAfterMs(response: Response, now = Date.now()): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function httpFailureClass(status: number): KalshiFailureClass {
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'invalid_response';
}

export class KalshiRequestFailure extends Error {
  readonly status: number | null;
  readonly classification: KalshiFailureClass;
  readonly environment: KalshiEnvironment;
  readonly endpointClass: KalshiEndpointClass;
  readonly path: string;
  readonly baseUrl: string | null;
  readonly retryAfterMs: number | null;

  constructor(message: string, details: {
    status?: number | null;
    classification: KalshiFailureClass;
    environment: KalshiEnvironment;
    endpointClass: KalshiEndpointClass;
    path: string;
    baseUrl?: string | null;
    retryAfterMs?: number | null;
    cause?: unknown;
  }) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'KalshiRequestFailure';
    this.status = details.status ?? null;
    this.classification = details.classification;
    this.environment = details.environment;
    this.endpointClass = details.endpointClass;
    this.path = details.path;
    this.baseUrl = details.baseUrl ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

function normalizeFailure(
  error: unknown,
  context: {
    environment: KalshiEnvironment;
    endpointClass: KalshiEndpointClass;
    path: string;
    baseUrl: string;
  },
): KalshiRequestFailure {
  if (error instanceof KalshiRequestFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const classification: KalshiFailureClass = name === 'AbortError'
    ? 'aborted'
    : name === 'SyntaxError'
      ? 'invalid_response'
      : /timeout|timed out/i.test(message)
        ? 'timeout'
        : /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|SSL/i.test(message)
          ? 'network'
          : 'unknown';
  return new KalshiRequestFailure(message, { ...context, classification, cause: error });
}

async function kalshiFetch<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<T> {
  const environment = opts.environment ?? 'production';
  const endpointClass = endpointClassFor(path, opts.endpointClass);
  const key = cacheKey(environment, endpointClass);
  const defaultBases = validatedBases({ ...opts, endpointClass });
  const workingBase = workingBases.get(key);
  const bases = workingBase && !opts.baseUrl
    ? [workingBase, ...defaultBases.filter((base) => base !== workingBase)]
    : defaultBases;

  const fetchFn = opts.fetchFn ?? fetch;
  let lastError: KalshiRequestFailure | null = null;

  for (const base of bases) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (opts.signal?.aborted) {
          throw opts.signal.reason instanceof Error
            ? opts.signal.reason
            : new Error(`Kalshi ${path} aborted`);
        }
        const url = `${base}${path}`;
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'User-Agent': 'NEMESIS/1.0',
          ...opts.authHeaders,
        };
        await acquireReadRequestSlot(environment, opts.signal);
        const res = opts.fetchFn
          ? await fetchFn(url, { headers, signal: opts.signal })
          // retries:0 → one attempt per outer loop iteration, 10 s abort.
          // Worst case: 3 bases × 3 outer attempts × 10 s = 90 s (was 180 s with
          // retries:1).  App-level timeouts in main.ts cap real blocking to ≤20 s.
          : await resilientFetch(url, { headers, signal: opts.signal, label: `Kalshi ${path}`, retries: 0, timeoutMs: 10_000 });
        if (!res.ok) {
          if (workingBases.get(key) === base) workingBases.delete(key);
          recordHostResult(environment, endpointClass, base, httpFailureClass(res.status));
          const serverRetryAfterMs = retryAfterMs(res);
          const appliedRetryAfterMs = res.status === 429
            ? applyReadRateLimit(environment, serverRetryAfterMs)
            : serverRetryAfterMs;
          lastError = new KalshiRequestFailure(`Kalshi API ${res.status}: ${path}`, {
            status: res.status,
            classification: httpFailureClass(res.status),
            environment,
            endpointClass,
            path,
            baseUrl: base,
            retryAfterMs: appliedRetryAfterMs,
          });
          // A 4xx applies to the request, not to one hostname. In particular,
          // rotating a 429 through all fallback bases multiplies the rate-limit
          // storm and defeats FeedHub backoff.
          if (res.status >= 400 && res.status < 500) throw lastError;
          if (res.status >= 500 && attempt < 2) {
            await sleep(300 * (attempt + 1));
            continue;
          }
          break;
        }
        const payload = await res.json() as T;
        recordReadSuccess(environment);
        workingBases.set(key, base);
        recordHostResult(environment, endpointClass, base, null);
        return payload;
      } catch (e) {
        lastError = normalizeFailure(e, { environment, endpointClass, path, baseUrl: base });
        if (!(e instanceof KalshiRequestFailure)) {
          recordHostResult(environment, endpointClass, base, lastError.classification);
        }
        if (opts.signal?.aborted) throw lastError;
        if (lastError.status !== null && lastError.status >= 400 && lastError.status < 500) {
          throw lastError;
        }
        const moveToAlias = lastError.classification === 'network'
          || lastError.classification === 'timeout'
          || lastError.classification === 'aborted'
          || lastError.classification === 'invalid_response';
        if (!moveToAlias && attempt < 2) await sleep(300 * (attempt + 1));
        if (moveToAlias) break;
      }
    }
    if (workingBases.get(key) === base) workingBases.delete(key);
  }

  throw lastError ?? new KalshiRequestFailure(`Kalshi API failed: ${path}`, {
    classification: 'unknown',
    environment,
    endpointClass,
    path,
  });
}

export async function fetchMarkets(opts: FetchOptions = {}): Promise<KalshiMarketsResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 50));
  if (opts.status) params.set('status', opts.status);
  if (opts.cursor) params.set('cursor', opts.cursor);
  const raw = await kalshiFetch<KalshiMarketsResponse>(`/markets?${params}`, opts);
  return {
    ...raw,
    markets: (raw.markets ?? []).map(normalizeKalshiMarket),
  };
}

export async function fetchOrderbook(
  ticker: string,
  opts: FetchOptions = {},
): Promise<KalshiOrderbook> {
  const raw = await kalshiFetch<Record<string, unknown>>(
    `/markets/${encodeURIComponent(ticker)}/orderbook`,
    opts,
  );
  return parseOrderbook(ticker, raw);
}

export async function fetchMarket(
  ticker: string,
  opts: FetchOptions = {},
): Promise<KalshiMarket> {
  const raw = await kalshiFetch<{ market: KalshiMarket }>(
    `/markets/${encodeURIComponent(ticker)}`,
    opts,
  );
  return normalizeKalshiMarket(raw.market);
}

export async function fetchEvent(
  eventTicker: string,
  opts: FetchOptions = {},
): Promise<KalshiEvent> {
  const raw = await kalshiFetch<{ event: KalshiEvent }>(
    `/events/${encodeURIComponent(eventTicker)}`,
    opts,
  );
  if (!raw.event?.event_ticker || !raw.event.series_ticker) {
    throw new Error('Kalshi event payload missing event or series ticker');
  }
  return raw.event;
}

export async function fetchSeries(
  seriesTicker: string,
  opts: FetchOptions = {},
): Promise<KalshiSeries> {
  const raw = await kalshiFetch<{ series: KalshiSeries }>(
    `/series/${encodeURIComponent(seriesTicker)}`,
    opts,
  );
  if (!raw.series?.ticker) throw new Error('Kalshi series payload missing series');
  return raw.series;
}

export async function fetchTrades(
  opts: FetchOptions & { ticker?: string; limit?: number } = {},
): Promise<KalshiTradesResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 50));
  if (opts.ticker) params.set('ticker', opts.ticker);
  if (opts.cursor) params.set('cursor', opts.cursor);
  const raw = await kalshiFetch<{ trades?: unknown; cursor?: unknown }>(
    `/markets/trades?${params}`,
    opts,
  );
  if (!Array.isArray(raw.trades)) {
    throw new Error('Kalshi trade payload missing trades array');
  }

  const trades = raw.trades
    .map(normalizeKalshiTrade)
    .filter((trade): trade is KalshiTrade => trade !== null);
  if (raw.trades.length > 0 && trades.length === 0) {
    throw new Error('Kalshi trade payload contained no valid records');
  }

  return {
    trades,
    cursor: typeof raw.cursor === 'string' ? raw.cursor : undefined,
  };
}

function normalizeKalshiTrade(value: unknown): KalshiTrade | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const tradeId = nonEmptyString(raw.trade_id);
  const ticker = nonEmptyString(raw.ticker);
  const createdTime = nonEmptyString(raw.created_time);
  const yesPrice = tradePriceCents(raw.yes_price_dollars, raw.yes_price);
  const noPrice = tradePriceCents(raw.no_price_dollars, raw.no_price);
  const count = finiteNumber(raw.count_fp ?? raw.count);
  const takerSide = tradeTakerSide(raw);

  if (
    tradeId === null
    || ticker === null
    || createdTime === null
    || yesPrice === null
    || noPrice === null
    || count === null
    || count <= 0
    || takerSide === null
  ) return null;

  return {
    trade_id: tradeId,
    ticker,
    yes_price: yesPrice,
    no_price: noPrice,
    count,
    taker_side: takerSide,
    created_time: createdTime,
  };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function tradePriceCents(dollars: unknown, legacyCents: unknown): number | null {
  const dollarValue = finiteNumber(dollars);
  if (dollarValue !== null && dollarValue >= 0 && dollarValue <= 1) {
    return Number((dollarValue * 100).toFixed(6));
  }
  const cents = finiteNumber(legacyCents);
  return cents !== null && cents >= 0 && cents <= 100 ? cents : null;
}

function tradeTakerSide(raw: Record<string, unknown>): 'yes' | 'no' | null {
  const outcomeSide = raw.taker_outcome_side ?? raw.taker_side;
  if (outcomeSide === 'yes' || outcomeSide === 'no') return outcomeSide;
  if (raw.taker_book_side === 'bid') return 'yes';
  if (raw.taker_book_side === 'ask') return 'no';
  return null;
}

export interface KalshiBalance {
  balance: number;
  payout: number;
}

export interface KalshiPortfolioPosition {
  ticker: string;
  position: number;
  market_exposure: number;
  realized_pnl?: number;
}

export interface KalshiOrderRequest {
  ticker: string;
  action: 'buy' | 'sell';
  side: 'yes' | 'no';
  count?: number;
  count_fp?: string;
  type: 'limit' | 'market';
  yes_price?: number;
  no_price?: number;
  yes_price_dollars?: string;
  no_price_dollars?: string;
  client_order_id?: string;
}

export interface KalshiOrderResponse {
  order: {
    order_id: string;
    status: string;
    fill_count?: number;
    fill_count_fp?: string;
  };
}

export async function fetchBalance(opts: FetchOptions = {}): Promise<KalshiBalance> {
  const raw = await kalshiFetch<{ balance: number; payout?: number }>('/portfolio/balance', opts);
  return { balance: raw.balance / 100, payout: (raw.payout ?? 0) / 100 };
}

export async function fetchPortfolioPositions(opts: FetchOptions = {}): Promise<KalshiPortfolioPosition[]> {
  const raw = await kalshiFetch<{ market_positions: KalshiPortfolioPosition[] }>(
    '/portfolio/positions',
    opts,
  );
  return raw.market_positions ?? [];
}

export async function createKalshiOrder(
  order: KalshiOrderRequest,
  opts: FetchOptions = {},
): Promise<KalshiOrderResponse> {
  return kalshiFetch<KalshiOrderResponse>('/portfolio/orders', {
    ...opts,
    fetchFn: async (url, init) => {
      const fetchFn = opts.fetchFn ?? fetch;
      return fetchFn(url, {
        ...init,
        method: 'POST',
        headers: {
          ...init?.headers as Record<string, string>,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(order),
      });
    },
  });
}

export interface KalshiOpenOrder {
  order_id: string;
  status: string;
  ticker?: string;
  side?: 'yes' | 'no';
  remaining_count?: number;
}

export async function fetchOpenKalshiOrders(opts: FetchOptions = {}): Promise<KalshiOpenOrder[]> {
  const raw = await kalshiFetch<{ orders?: KalshiOpenOrder[] }>(
    '/portfolio/orders?status=resting',
    opts,
  );
  return raw.orders ?? [];
}

export async function cancelKalshiOrder(orderId: string, opts: FetchOptions = {}): Promise<void> {
  await kalshiFetch<unknown>(`/portfolio/orders/${encodeURIComponent(orderId)}`, {
    ...opts,
    fetchFn: async (url, init) => {
      const fetchFn = opts.fetchFn ?? fetch;
      return fetchFn(url, { ...init, method: 'DELETE' });
    },
  });
}
