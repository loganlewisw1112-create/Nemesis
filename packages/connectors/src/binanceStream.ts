import type { ConnectorRegistry } from './registry.js';

const REST_URL = 'https://data-api.binance.vision/api/v3/ticker/bookTicker';
const QUOTE_WINDOW_MS = 60_000;

interface BinanceSample {
  price: number;
  fetchedAt: number;
}

/**
 * Consecutive samples closer together than this carry more bid-ask bounce than
 * diffusion, and dividing a bounce by a tiny interval inflates the variance
 * estimate without bound. Sparse-sampling onto a >= 1s grid is the standard
 * defence, and 1s still leaves the 5s REST poll every interval it produces.
 */
const MIN_RETURN_GAP_MS = 1_000;

export interface BinanceQuote {
  symbol: string;
  price: number;
  lagMs: number;
  fetchedAt: number;
  momentumBps: number;
  /**
   * Dispersion of per-sample returns, in bps. Display and confidence-scoring
   * only: it is a per-sample number with no time unit, so it means nothing
   * without knowing the spacing that produced it. The model uses
   * `sigmaPerRootSec`.
   */
  volatilityBps: number;
  /**
   * Volatility per square-root second, estimated from the actual gaps between
   * samples. Scale by sqrt(seconds) to get total volatility over any horizon.
   * Zero when the window cannot support an estimate.
   */
  sigmaPerRootSec: number;
  sampleCount: number;
  windowMs: number;
}

function roundBps(value: number, decimals = 1): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

function rollingVolatilityBps(samples: BinanceSample[]): number {
  if (samples.length < 3) return 0;
  const returns: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prior = samples[i - 1].price;
    const next = samples[i].price;
    if (prior > 0 && Number.isFinite(next)) returns.push(((next - prior) / prior) * 10_000);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / returns.length;
  return Math.sqrt(variance);
}

/**
 * Volatility per square-root second from irregularly spaced samples.
 *
 * The window is fed by two sources at once — a sub-second websocket and a 5s
 * REST poll (`recordQuote` is called from both) — so the spacing between
 * consecutive samples varies by more than an order of magnitude. Treating that
 * series as uniformly spaced, then rescaling by the *average* gap, produces a
 * number that corresponds to no interval actually observed; it was the input
 * that priced a 3-cent contract at 16.5 cents.
 *
 * Under a diffusion each log return has variance sigma^2 * dt over its own gap,
 * so total realised variance divided by the wall time it accrued over is an
 * unbiased, spacing-independent estimate of sigma^2. Long gaps contribute in
 * proportion to their length, which is exactly right.
 */
export function realizedVolPerRootSec(samples: BinanceSample[]): number {
  const sparse: BinanceSample[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.price) || sample.price <= 0) continue;
    if (!Number.isFinite(sample.fetchedAt)) continue;
    const last = sparse[sparse.length - 1];
    if (!last) {
      sparse.push(sample);
      continue;
    }
    if (sample.fetchedAt - last.fetchedAt >= MIN_RETURN_GAP_MS) sparse.push(sample);
  }
  if (sparse.length < 3) return 0;

  let realizedVariance = 0;
  let elapsedSec = 0;
  for (let i = 1; i < sparse.length; i += 1) {
    const dtSec = (sparse[i]!.fetchedAt - sparse[i - 1]!.fetchedAt) / 1000;
    if (!(dtSec > 0)) continue;
    const logReturn = Math.log(sparse[i]!.price / sparse[i - 1]!.price);
    if (!Number.isFinite(logReturn)) continue;
    realizedVariance += logReturn * logReturn;
    elapsedSec += dtSec;
  }
  if (elapsedSec <= 0) return 0;
  return Math.sqrt(realizedVariance / elapsedSec);
}

export function deriveBinanceQuote(
  symbol: string,
  price: number,
  lagMs: number,
  fetchedAt: number,
  samples: BinanceSample[],
): BinanceQuote {
  const windowed = samples.filter((sample) => fetchedAt - sample.fetchedAt <= QUOTE_WINDOW_MS);
  const first = windowed[0];
  const momentumBps = first?.price && first.price > 0 ? ((price - first.price) / first.price) * 10_000 : 0;
  const windowMs = first ? Math.max(0, fetchedAt - first.fetchedAt) : 0;
  return {
    symbol: symbol.toUpperCase(),
    price,
    lagMs,
    fetchedAt,
    momentumBps: roundBps(momentumBps),
    volatilityBps: roundBps(rollingVolatilityBps(windowed), 4),
    sigmaPerRootSec: realizedVolPerRootSec(windowed),
    sampleCount: windowed.length,
    windowMs,
  };
}

export class BinanceStream {
  private quotes = new Map<string, BinanceQuote>();
  private samples = new Map<string, BinanceSample[]>();
  private ws: WebSocket | null = null;
  private symbols = new Set<string>(['BTCUSDT']);
  private reconnectMs = 1000;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private registry: ConnectorRegistry) {}

  getQuote(symbol: string): BinanceQuote | undefined {
    return this.quotes.get(symbol.toUpperCase());
  }

  track(symbol: string) {
    const s = symbol.toUpperCase();
    if (this.symbols.has(s)) return;
    this.symbols.add(s);
    if (this.started) this.reconnect();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
    this.pollTimer = setInterval(() => void this.restPoll(), 5_000);
  }

  stop() {
    this.started = false;
    this.ws?.close();
    this.ws = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private reconnect() {
    this.ws?.close();
    this.ws = null;
    if (this.started) setTimeout(() => this.connect(), 300);
  }

  private wsUrl(): string {
    const streams = [...this.symbols].map((s) => `${s.toLowerCase()}@bookTicker`);
    if (streams.length === 1) {
      return `wss://data-stream.binance.vision/ws/${streams[0]}`;
    }
    return `wss://data-stream.binance.vision/stream?streams=${streams.join('/')}`;
  }

  private recordQuote(symbol: string, price: number, lagMs: number, fetchedAt: number) {
    const s = symbol.toUpperCase();
    const history = [...(this.samples.get(s) ?? []), { price, fetchedAt }]
      .filter((sample) => fetchedAt - sample.fetchedAt <= QUOTE_WINDOW_MS);
    this.samples.set(s, history);
    this.quotes.set(s, deriveBinanceQuote(s, price, lagMs, fetchedAt, history));
  }

  private connect() {
    if (typeof WebSocket === 'undefined' || this.symbols.size === 0) return;

    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectMs = 1000;
      this.registry.recordSuccess('binance-ws', 0);
    };

    ws.onmessage = (ev) => {
      try {
        const raw = JSON.parse(String(ev.data)) as {
          data?: { s?: string; b?: string; a?: string };
          s?: string;
          b?: string;
          a?: string;
        };
        const data = raw.data ?? raw;
        const symbol = data.s;
        const bid = parseFloat(data.b ?? '');
        const ask = parseFloat(data.a ?? '');
        if (!symbol || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
        this.recordQuote(symbol, (bid + ask) / 2, 0, Date.now());
        this.registry.recordSuccess('binance-ws', 0);
      } catch {
        /* ignore malformed tick */
      }
    };

    ws.onclose = () => {
      if (!this.started) return;
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(30_000, this.reconnectMs * 2);
    };

    ws.onerror = () => ws.close();
  }

  private async restPoll() {
    for (const symbol of this.symbols) {
      const start = Date.now();
      try {
        const res = await fetch(`${REST_URL}?symbol=${symbol}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'NEMESIS/1.0' },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) continue;
        const data = await res.json() as { bidPrice?: string; askPrice?: string };
        const bid = parseFloat(data.bidPrice ?? '');
        const ask = parseFloat(data.askPrice ?? '');
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) continue;
        const fetchedAt = Date.now();
        this.recordQuote(symbol, (bid + ask) / 2, fetchedAt - start, fetchedAt);
        this.registry.recordSuccess('binance-ws', Date.now() - start);
      } catch {
        /* REST backup */
      }
    }
  }
}
