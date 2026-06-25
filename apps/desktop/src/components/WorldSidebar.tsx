import { useState } from 'react';
import type { GeoMarket, GeoNewsItem } from '@nemesis/core';

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function severityColor(severity: number): string {
  if (severity >= 0.7) return 'var(--danger)';
  if (severity >= 0.4) return 'var(--warning)';
  return 'var(--success)';
}

function WorldNewsItem({ item }: { item: GeoNewsItem }) {
  return (
    <div
      style={{
        padding: '7px 12px',
        borderBottom: '1px solid var(--border)',
        borderLeft: `3px solid ${severityColor(item.severity)}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div style={{ fontSize: 11, lineHeight: 1.4, color: 'var(--text)' }}>
        {item.title.length > 80 ? `${item.title.slice(0, 80)}…` : item.title}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', background: 'var(--bg)', borderRadius: 3, padding: '1px 5px', fontWeight: 600 }}>
          {item.region}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{item.category}</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>{timeAgo(item.fetchedAt)}</span>
      </div>
    </div>
  );
}

function WorldTradeRow({ market, onPaperBuy }: { market: GeoMarket; onPaperBuy: (thesisId: string) => void }) {
  const [buying, setBuying] = useState(false);

  return (
    <div
      style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', fontFamily: 'monospace' }}>{market.ticker}</div>
          <div style={{ fontSize: 11, color: 'var(--text)', lineHeight: 1.4, marginTop: 1 }}>
            {market.title.length > 55 ? `${market.title.slice(0, 55)}…` : market.title}
          </div>
        </div>
        <div
          style={{
            flexShrink: 0,
            background: market.netEdge > 0 ? 'rgba(34,197,94,0.15)' : 'var(--bg)',
            color: market.netEdge > 0 ? 'var(--success)' : 'var(--text-muted)',
            border: `1px solid ${market.netEdge > 0 ? 'var(--success)' : 'var(--border)'}`,
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 10,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          +{(market.netEdge * 100).toFixed(1)}¢
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
          {market.countryCode} · {(market.marketPrice * 100).toFixed(0)}¢ market
        </span>
        {market.thesisId && (
          <button
            type="button"
            disabled={buying}
            onClick={async () => {
              setBuying(true);
              try { await onPaperBuy(market.thesisId!); } finally { setBuying(false); }
            }}
            style={{
              background: 'var(--accent)',
              border: 'none',
              color: '#fff',
              fontSize: 9,
              padding: '2px 8px',
              borderRadius: 4,
              cursor: buying ? 'wait' : 'pointer',
              fontWeight: 700,
              opacity: buying ? 0.6 : 1,
            }}
          >
            {buying ? '…' : 'Paper Buy'}
          </button>
        )}
      </div>
    </div>
  );
}

interface Props {
  news: GeoNewsItem[];
  markets: GeoMarket[];
  onPaperBuy: (thesisId: string) => void;
}

export function WorldSidebar({ news, markets, onPaperBuy }: Props) {
  const tradeableMarkets = markets.filter((m) => m.netEdge > 0 && m.thesisId);

  return (
    <div
      style={{
        width: 300,
        minWidth: 240,
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--bg-elevated)',
      }}
    >
      {/* News Feed */}
      <div style={{ flex: '0 0 50%', overflow: 'auto', borderBottom: '1px solid var(--border)' }}>
        <div
          style={{
            padding: '7px 12px 5px',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          Live Feed ({news.length})
        </div>
        {news.length === 0 ? (
          <div style={{ padding: 14, fontSize: 11, color: 'var(--text-muted)' }}>Fetching news…</div>
        ) : (
          news.map((n, i) => <WorldNewsItem key={i} item={n} />)
        )}
      </div>

      {/* Trade Opportunities */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div
          style={{
            padding: '7px 12px 5px',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-elevated)',
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          Opportunities ({tradeableMarkets.length})
        </div>
        {tradeableMarkets.length === 0 ? (
          <div style={{ padding: 14, fontSize: 11, color: 'var(--text-muted)' }}>
            {markets.length === 0 ? 'No markets geo-tagged in this region' : 'No positive-edge signals in this region'}
          </div>
        ) : (
          tradeableMarkets.map((m) => <WorldTradeRow key={m.ticker} market={m} onPaperBuy={onPaperBuy} />)
        )}
      </div>
    </div>
  );
}
