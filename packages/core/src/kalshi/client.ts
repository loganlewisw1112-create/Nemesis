import type {
  KalshiMarket,
  KalshiMarketsResponse,
  KalshiOrderbook,
  KalshiTradesResponse,
  OrderbookLevel,
} from '../types.js';
import { resilientFetch, sleep } from '../http/resilientFetch.js';

export const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export const KALSHI_API_BASES = [
  KALSHI_API_BASE,
  'https://trading-api.kalshi.com/trade-api/v2',
  'https://demo-api.kalshi.co/trade-api/v2',
];

export interface FetchOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  limit?: number;
  status?: string;
  cursor?: string;
  authHeaders?: Record<string, string>;
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

  return { ticker, yes, no, yesAsk, noAsk, spread };
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

  return { ticker: book.ticker, yes, no, yesAsk, noAsk, spread };
}

let _workingBase: string | null = null;

class KalshiHttpError extends Error {
  constructor(readonly status: number, path: string) {
    super(`Kalshi API ${status}: ${path}`);
    this.name = 'KalshiHttpError';
  }
}

async function kalshiFetch<T>(
  path: string,
  opts: FetchOptions = {},
): Promise<T> {
  // Build base list: cached working base first, then full list (deduped)
  const defaultBases = opts.baseUrl ? [opts.baseUrl] : KALSHI_API_BASES;
  const bases = _workingBase && !opts.baseUrl
    ? [_workingBase, ...defaultBases.filter((b) => b !== _workingBase)]
    : defaultBases;

  const fetchFn = opts.fetchFn ?? fetch;
  let lastError: Error | null = null;

  for (const base of bases) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = `${base}${path}`;
        const headers: Record<string, string> = {
          Accept: 'application/json',
          'User-Agent': 'NEMESIS/1.0',
          ...opts.authHeaders,
        };
        const res = opts.fetchFn
          ? await fetchFn(url, { headers })
          // retries:0 → one attempt per outer loop iteration, 10 s abort.
          // Worst case: 3 bases × 3 outer attempts × 10 s = 90 s (was 180 s with
          // retries:1).  App-level timeouts in main.ts cap real blocking to ≤20 s.
          : await resilientFetch(url, { headers, label: `Kalshi ${path}`, retries: 0, timeoutMs: 10_000 });
        if (!res.ok) {
          lastError = new KalshiHttpError(res.status, path);
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
        _workingBase = base;
        return res.json() as Promise<T>;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        // Don't retry SSL/connection errors — move to next base immediately
        if (lastError instanceof KalshiHttpError && lastError.status >= 400 && lastError.status < 500) {
          throw lastError;
        }
        const msg = lastError.message ?? '';
        const isFatal = msg.includes('SSL') || msg.includes('ECONNRESET') || msg.includes('fetch failed');
        if (!isFatal && attempt < 2) await sleep(300 * (attempt + 1));
        if (isFatal) break;
      }
    }
    // If the cached base just failed, clear it so we re-discover on next call
    if (base === _workingBase) _workingBase = null;
  }

  throw lastError ?? new Error(`Kalshi API failed: ${path}`);
}

export async function fetchMarkets(opts: FetchOptions = {}): Promise<KalshiMarketsResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 50));
  if (opts.status) params.set('status', opts.status);
  if (opts.cursor) params.set('cursor', opts.cursor);
  return kalshiFetch<KalshiMarketsResponse>(`/markets?${params}`, opts);
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
  return raw.market;
}

export async function fetchTrades(
  opts: FetchOptions & { ticker?: string; limit?: number } = {},
): Promise<KalshiTradesResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 50));
  if (opts.ticker) params.set('ticker', opts.ticker);
  if (opts.cursor) params.set('cursor', opts.cursor);
  return kalshiFetch<KalshiTradesResponse>(`/markets/trades?${params}`, opts);
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
  count: number;
  type: 'limit' | 'market';
  yes_price?: number;
  no_price?: number;
  client_order_id?: string;
}

export interface KalshiOrderResponse {
  order: {
    order_id: string;
    status: string;
    fill_count?: number;
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
