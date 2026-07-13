import { describe, expect, it } from 'vitest';
import type { KalshiMarket, KalshiTrade } from '@nemesis/core';
import {
  hasExecutableOrderbook,
  selectExecutableMarkets,
  selectKalshiTapeTickers,
} from './kalshiLiquidity.js';

const markets: KalshiMarket[] = [
  {
    ticker: 'KXMVECROSSCATEGORY-DEAD',
    title: 'Unquoted combination',
    status: 'active',
    yes_bid_dollars: '0.0000',
    yes_ask_dollars: '0.0000',
    volume: 0,
    volume_24h: 0,
  },
  {
    ticker: 'KXLIQUID-LOW',
    title: 'Lower-volume quoted market',
    status: 'active',
    yes_bid_dollars: '0.4000',
    yes_ask_dollars: '0.4100',
    volume: 500,
    volume_24h: 100,
  },
  {
    ticker: 'KXLIQUID-HIGH',
    title: 'Higher-volume quoted market',
    status: 'active',
    yes_bid_dollars: '0.6200',
    yes_ask_dollars: '0.6300',
    volume: 5_000,
    volume_24h: 2_000,
  },
];

describe('Kalshi liquidity selection', () => {
  it('drops zero-volume or unquoted markets before an orderbook request', () => {
    expect(selectExecutableMarkets(markets).map((market) => market.ticker)).toEqual([
      'KXLIQUID-HIGH',
      'KXLIQUID-LOW',
    ]);
  });

  it('prioritizes large recent trade tickers even when they are absent from the market page', () => {
    const trades: KalshiTrade[] = [
      {
        trade_id: 'small',
        ticker: 'KXSMALL',
        yes_price: 50,
        no_price: 50,
        count: 10,
        taker_side: 'yes',
        created_time: '2026-07-13T23:00:00Z',
      },
      {
        trade_id: 'btc-whale',
        ticker: 'KXBTC15M-ACTIVE',
        yes_price: 95,
        no_price: 5,
        count: 600,
        taker_side: 'yes',
        created_time: '2026-07-13T23:01:00Z',
      },
      {
        trade_id: 'sports-whale',
        ticker: 'KXSPORTS-ACTIVE',
        yes_price: 40,
        no_price: 60,
        count: 150,
        taker_side: 'no',
        created_time: '2026-07-13T23:02:00Z',
      },
    ];

    expect(selectKalshiTapeTickers(markets, trades, {
      trackLimit: 4,
      orderbookLimit: 3,
      minTradeNotionalUsd: 50,
    })).toEqual({
      trackedTickers: [
        'KXBTC15M-ACTIVE',
        'KXSPORTS-ACTIVE',
        'KXLIQUID-HIGH',
        'KXLIQUID-LOW',
      ],
      orderbookTickers: ['KXBTC15M-ACTIVE', 'KXSPORTS-ACTIVE', 'KXLIQUID-HIGH'],
    });
  });

  it('does not classify empty or invalid books as executable depth', () => {
    expect(hasExecutableOrderbook({ ticker: 'EMPTY', yes: [], no: [] })).toBe(false);
    expect(hasExecutableOrderbook({
      ticker: 'VALID',
      yes: [{ price: 0.63, quantity: 20 }],
      no: [],
    })).toBe(true);
  });
});
