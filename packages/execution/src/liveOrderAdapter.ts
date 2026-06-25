import {
  createKalshiOrder,
  cancelKalshiOrder,
  fetchOpenKalshiOrders,
  fetchPortfolioPositions,
  type GuardrailSettings,
  type ThesisCard,
} from '@nemesis/core';
import { authHeaders } from './signer.js';
import { reconcilePositions } from './reconcile.js';
import type { LocalPosition } from './reconcile.js';

export interface LiveOrderRequest {
  ticker: string;
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
    side: card.side,
    contracts,
    limitPrice,
    clientOrderId: `nem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  const yesPrice = req.side === 'yes' ? Math.round(req.limitPrice * 100) : undefined;
  const noPrice = req.side === 'no' ? Math.round(req.limitPrice * 100) : undefined;
  try {
    const res = await createKalshiOrder(
      {
        ticker: req.ticker,
        action: 'buy',
        side: req.side,
        count: req.contracts,
        type: 'limit',
        yes_price: yesPrice,
        no_price: noPrice,
        client_order_id: req.clientOrderId,
      },
      signedOpts(creds, 'POST', path),
    );
    return { ok: true, orderId: res.order.order_id };
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
