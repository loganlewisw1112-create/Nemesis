import {
  createKalshiOrder,
  cancelKalshiOrder,
  fetchOpenKalshiOrders,
  fetchPortfolioPositions,
  type GuardrailSettings,
  type LatencyMetrics,
  type ThesisCard,
  isSupportedQualificationFeeOrder,
} from '@nemesis/core';
import { authHeaders } from './signer.js';
import { reconcilePositions } from './reconcile.js';
import type { LocalPosition } from './reconcile.js';
import { measureExchangeRoundTrip } from './exchangeLatency.js';

export interface LiveOrderRequest {
  ticker: string;
  action?: 'buy' | 'sell';
  side: 'yes' | 'no';
  contracts: number;
  limitPrice: number;
  clientOrderId: string;
}

export interface LiveOrderResult {
  ok: boolean;
  orderId?: string;
  error?: string;
  simulated?: boolean;
  latencyMetrics?: LatencyMetrics;
}

export function fixedPointKalshiOrder(req: LiveOrderRequest) {
  if (!isSupportedQualificationFeeOrder(req.limitPrice, req.contracts)) {
    throw new Error('live order requires a four-decimal price and two-decimal quantity');
  }
  const countFp = req.contracts.toFixed(2);
  const priceDollars = req.limitPrice.toFixed(4);
  return {
    ticker: req.ticker,
    action: req.action ?? 'buy',
    side: req.side,
    count_fp: countFp,
    type: 'limit' as const,
    yes_price_dollars: req.side === 'yes' ? priceDollars : undefined,
    no_price_dollars: req.side === 'no' ? priceDollars : undefined,
    client_order_id: req.clientOrderId,
  };
}

export interface LiveCredentials {
  apiKeyId: string;
  privateKeyPem: string;
}

export function createLiveOrderRequest(
  card: ThesisCard,
  contracts: number,
  limitPrice: number,
): LiveOrderRequest {
  return {
    ticker: card.ticker,
    action: 'buy',
    side: card.side,
    contracts,
    limitPrice,
    clientOrderId: `nem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

export function createLiveCloseOrderRequest(
  position: Pick<LiveOrderRequest, 'ticker' | 'side' | 'contracts'>,
  limitPrice: number,
): LiveOrderRequest {
  return {
    ticker: position.ticker,
    action: 'sell',
    side: position.side,
    contracts: position.contracts,
    limitPrice,
    clientOrderId: `nem-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function signedOpts(creds: LiveCredentials, method: string, path: string) {
  return { authHeaders: authHeaders(creds.apiKeyId, creds.privateKeyPem, method, path) };
}

export async function submitLiveOrder(
  req: LiveOrderRequest,
  creds: LiveCredentials | null,
  settings: GuardrailSettings,
): Promise<LiveOrderResult> {
  if (!settings.liveEnabled) return { ok: false, error: 'live trading not enabled' };
  if (settings.killSwitchActive) return { ok: false, error: 'kill switch active' };
  if (!creds?.apiKeyId || !creds.privateKeyPem) {
    return { ok: false, error: 'Kalshi credentials not configured' };
  }

  const path = '/portfolio/orders';
  try {
    const measured = await measureExchangeRoundTrip({
      send: () => createKalshiOrder(
        fixedPointKalshiOrder(req),
        signedOpts(creds, 'POST', path),
      ),
    });
    return {
      ok: true,
      orderId: measured.result.order.order_id,
      latencyMetrics: measured.metrics,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function cancelAllLiveOrders(
  creds: LiveCredentials | null,
  settings: GuardrailSettings,
): Promise<{ cancelled: number }> {
  if (!settings.liveEnabled || !creds) return { cancelled: 0 };
  const path = '/portfolio/orders?status=resting';
  const signed = signedOpts(creds, 'GET', path);
  let orders: Awaited<ReturnType<typeof fetchOpenKalshiOrders>>;
  try {
    orders = await fetchOpenKalshiOrders(signed);
  } catch {
    return { cancelled: 0 };
  }
  let cancelled = 0;
  for (const order of orders) {
    if (!order.order_id) continue;
    const ok = await cancelLiveOrder(order.order_id, creds);
    if (ok) cancelled += 1;
  }
  return { cancelled };
}

export async function cancelLiveOrder(
  orderId: string,
  creds: LiveCredentials | null,
): Promise<boolean> {
  if (!creds) return false;
  const path = `/portfolio/orders/${orderId}`;
  try {
    await cancelKalshiOrder(orderId, signedOpts(creds, 'DELETE', path));
    return true;
  } catch {
    return false;
  }
}

export async function reconcileLiveBook(
  local: LocalPosition[],
  creds: LiveCredentials | null,
) {
  if (!creds) return { ok: true, mismatches: [] as ReturnType<typeof reconcilePositions> };
  const path = '/portfolio/positions';
  const remote = await fetchPortfolioPositions(signedOpts(creds, 'GET', path));
  const mismatches = reconcilePositions(local, remote);
  return { ok: mismatches.length === 0, mismatches };
}
