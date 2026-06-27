import { describe, expect, it } from 'vitest';
import {
  validateBridgeMessage,
  validateExitRecommendation,
  validateNoTradeWarning,
  validateRecommendationPacket,
} from './validation.js';
import type { ExitRecommendation, NoTradeWarning, RecommendationPacket } from './recommendations.js';
import type { NemesisBridgeMessage } from './bridge.js';

function packet(overrides: Partial<RecommendationPacket> = {}): RecommendationPacket {
  return {
    id: 'rec-1',
    brain_role: 'primary',
    model_version: 'alpha-v1',
    ticker: 'KXTEST-26',
    classification: 'elite',
    alpha_score: 91,
    nemesis_probability: 0.61,
    confidence_band_low: 0.55,
    confidence_band_high: 0.67,
    net_ev: 0.08,
    raw_edge: 0.12,
    entry_zone_low: 0.42,
    entry_zone_high: 0.48,
    do_not_chase_level: 0.53,
    target_exit: 0.64,
    settlement_clarity_score: 0.82,
    hold_class: 'intraday',
    expires_at: Date.now() + 60_000,
    created_at: Date.now(),
    ...overrides,
  };
}

function exitPacket(overrides: Partial<ExitRecommendation> = {}): ExitRecommendation {
  const now = Date.now();
  return {
    ticker: 'KXTEST-26',
    action: 'trim',
    current_edge: 0.03,
    captured_edge: 0.07,
    executable_close_price: 0.46,
    book_timestamp: now,
    book_depth: 3,
    price_source: 'kalshi-orderbook',
    expires_at: now + 500,
    reason: 'edge decayed',
    issued_by: 'emergency',
    issued_at: now,
    ...overrides,
  };
}

describe('bridge validation', () => {
  it('accepts primary recommendation packets with required fields', () => {
    const result = validateRecommendationPacket(packet(), { now: Date.now() });
    expect(result.ok).toBe(true);
  });

  it('rejects expired recommendation packets fail-closed', () => {
    const result = validateRecommendationPacket(packet({ expires_at: 100 }), { now: 200 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('rejects shadow and replay recommendations', () => {
    expect(validateRecommendationPacket(packet({ brain_role: 'shadow' })).reason).toBe('forbidden role');
    expect(validateRecommendationPacket(packet({ brain_role: 'replay' })).reason).toBe('forbidden role');
  });

  it('rejects high score recommendations without settlement clarity', () => {
    const result = validateRecommendationPacket(packet({ alpha_score: 90, settlement_clarity_score: 0.5 }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('settlement clarity too low');
  });

  it('rejects missing model version and malformed schemas', () => {
    const missingModel = { ...packet(), model_version: '' };
    const badScore = { ...packet(), alpha_score: 101 };
    expect(validateRecommendationPacket(missingModel).reason).toBe('missing model version');
    expect(validateRecommendationPacket(badScore).reason).toBe('invalid alpha score');
  });

  it('validates bridge message envelopes by payload type', () => {
    const msg: NemesisBridgeMessage = { type: 'brain:recommendation', payload: packet(), seq: 1 };
    expect(validateBridgeMessage(msg).ok).toBe(true);
    expect(validateBridgeMessage({ ...msg, payload: packet({ brain_role: 'replay' }) }).ok).toBe(false);
  });

  it('validates no-trade and exit packets with role restrictions', () => {
    const warning: NoTradeWarning = {
      ticker: 'KXTEST-26',
      block_reason: 'spread too wide',
      what_would_need_to_change: 'spread below 4pp',
      recheck_at: Date.now() + 30_000,
      issued_by: 'standby-a',
      issued_at: Date.now(),
    };
    const exit = exitPacket();
    expect(validateNoTradeWarning(warning).ok).toBe(true);
    expect(validateExitRecommendation(exit).ok).toBe(true);
    expect(validateNoTradeWarning({ ...warning, issued_by: 'shadow' }).reason).toBe('forbidden role');
    expect(validateExitRecommendation({ ...exit, issued_by: 'replay' }).reason).toBe('forbidden role');
  });

  it('rejects expired and stale exit packets fail-closed', () => {
    const now = Date.now();
    expect(validateExitRecommendation(exitPacket({ expires_at: now - 1 }), { now }).reason).toBe('expired exit packet');
    expect(validateExitRecommendation(exitPacket({ book_timestamp: now - 2_001 }), { now }).reason).toBe('stale exit book');
    expect(validateBridgeMessage({
      type: 'brain:exit',
      seq: 9,
      payload: exitPacket({ book_timestamp: now - 501, expires_at: now + 500 }),
    }, { now, maxExitBookAgeMs: 500 }).reason).toBe('stale exit book');
  });

  it('requires executable close context on exit packets', () => {
    const exit = exitPacket();
    expect(validateExitRecommendation({ ...exit, executable_close_price: 1.2 }).reason).toBe('invalid executable close price');
    expect(validateExitRecommendation({ ...exit, book_depth: 0 }).reason).toBe('invalid book depth');
    expect(validateExitRecommendation({ ...exit, price_source: 'model-midpoint' }).reason).toBe('invalid price source');
  });
  it('validates NEMESIS close-result packets for GEA feedback', () => {
    const msg: NemesisBridgeMessage = {
      type: 'nemesis:close-result',
      seq: 2,
      payload: {
        ticker: 'KXTEST-26',
        action: 'trim',
        contracts: 3,
        pnl: 1.25,
        was_profit: true,
        peak_pnl_usd: 2,
        close_regret_usd: 0.25,
        closed_at: Date.now(),
        reason: 'quick-profit trim',
        tier: 'scalp',
      },
    };

    expect(validateBridgeMessage(msg).ok).toBe(true);
    expect(validateBridgeMessage({ ...msg, payload: { ...msg.payload, tier: 'invalid' } }).ok).toBe(false);
  });
});
