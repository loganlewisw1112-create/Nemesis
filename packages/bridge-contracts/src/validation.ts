import type { NemesisBridgeMessage, NemesisBridgeMessageType } from './bridge.js';
import type { BrainRole, Classification, ExitRecommendation, NemesisCloseResult, NoTradeWarning, RecommendationPacket } from './recommendations.js';

export interface ValidationOptions {
  now?: number;
  minConfidence?: number;
  minSettlementClarity?: number;
  highScoreSettlementClarity?: number;
  maxExitBookAgeMs?: number;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const ALLOWED_PUBLISHING_ROLES = new Set<BrainRole>(['primary', 'standby-a', 'standby-b', 'standby-c', 'emergency']);
const BRAIN_ROLES = new Set<BrainRole>(['primary', 'standby-a', 'standby-b', 'standby-c', 'shadow', 'replay', 'emergency']);
const CLASSIFICATIONS = new Set<Classification>([
  'institutional-prime',
  'elite',
  'strong',
  'watch-for-entry',
  'paper-research',
  'ignore',
  'blocked',
]);
const MESSAGE_TYPES = new Set<NemesisBridgeMessageType>([
  'nemesis:state',
  'brain:recommendation',
  'brain:no-trade',
  'brain:exit',
  'nemesis:close-result',
  'bridge:ping',
  'bridge:pong',
  'bridge:hello',
]);
const EXIT_PRICE_SOURCES = new Set(['kalshi-orderbook', 'kalshi-snapshot', 'nemesis-local-book']);
const DEFAULT_MAX_EXIT_BOOK_AGE_MS = 2_000;

function fail(reason: string): ValidationResult<never> {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBrainRole(value: unknown): value is BrainRole {
  return typeof value === 'string' && BRAIN_ROLES.has(value as BrainRole);
}

function canPublish(role: BrainRole): boolean {
  return ALLOWED_PUBLISHING_ROLES.has(role);
}

function validProbability(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function validScore(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 100;
}

export function validateRecommendationPacket(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<RecommendationPacket> {
  if (!isRecord(value)) return fail('invalid schema');
  if (!isNonEmptyString(value.id)) return fail('missing id');
  if (!isBrainRole(value.brain_role)) return fail('invalid brain role');
  if (!canPublish(value.brain_role)) return fail('forbidden role');
  if (!isNonEmptyString(value.model_version)) return fail('missing model version');
  if (!isNonEmptyString(value.ticker)) return fail('missing ticker');
  if (typeof value.classification !== 'string' || !CLASSIFICATIONS.has(value.classification as Classification)) {
    return fail('invalid classification');
  }
  if (!validScore(value.alpha_score)) return fail('invalid alpha score');
  if (!validProbability(value.nemesis_probability)) return fail('invalid probability');
  if (!validProbability(value.confidence_band_low) || !validProbability(value.confidence_band_high)) {
    return fail('invalid confidence band');
  }
  if ((value.confidence_band_low as number) > (value.confidence_band_high as number)) {
    return fail('invalid confidence band');
  }
  for (const field of ['net_ev', 'raw_edge', 'entry_zone_low', 'entry_zone_high', 'do_not_chase_level', 'target_exit']) {
    if (!isFiniteNumber(value[field])) return fail(`invalid ${field}`);
  }
  if (!validProbability(value.settlement_clarity_score)) return fail('invalid settlement clarity');
  if (typeof value.hold_class !== 'string') return fail('invalid hold class');
  if (!isFiniteNumber(value.expires_at) || !isFiniteNumber(value.created_at)) return fail('invalid timestamps');

  const now = options.now ?? Date.now();
  if ((value.expires_at as number) < now) return fail('expired');

  const confidence = (value.confidence_band_high as number) - (value.confidence_band_low as number);
  if (1 - confidence < (options.minConfidence ?? 0.2)) return fail('confidence too low');

  const minClarity = (value.alpha_score as number) >= 88
    ? (options.highScoreSettlementClarity ?? 0.7)
    : (options.minSettlementClarity ?? 0.55);
  if ((value.settlement_clarity_score as number) < minClarity) return fail('settlement clarity too low');

  return { ok: true, value: value as unknown as RecommendationPacket };
}

export function validateNoTradeWarning(value: unknown): ValidationResult<NoTradeWarning> {
  if (!isRecord(value)) return fail('invalid schema');
  if (!isNonEmptyString(value.ticker)) return fail('missing ticker');
  if (!isNonEmptyString(value.block_reason)) return fail('missing block reason');
  if (!isNonEmptyString(value.what_would_need_to_change)) return fail('missing recheck condition');
  if (!isFiniteNumber(value.recheck_at) || !isFiniteNumber(value.issued_at)) return fail('invalid timestamps');
  if (!isBrainRole(value.issued_by)) return fail('invalid brain role');
  if (!canPublish(value.issued_by)) return fail('forbidden role');
  return { ok: true, value: value as unknown as NoTradeWarning };
}

export function validateExitRecommendation(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<ExitRecommendation> {
  if (!isRecord(value)) return fail('invalid schema');
  if (!isNonEmptyString(value.ticker)) return fail('missing ticker');
  if (value.side !== 'yes' && value.side !== 'no') return fail('invalid side');
  if (!['hold', 'trim', 'exit', 'add-only-on-pullback'].includes(String(value.action))) return fail('invalid action');
  if (!isFiniteNumber(value.current_edge) || !isFiniteNumber(value.captured_edge)) return fail('invalid edge');
  const executableClosePrice = value.executable_close_price;
  if (!isFiniteNumber(executableClosePrice) || executableClosePrice <= 0 || executableClosePrice >= 1) {
    return fail('invalid executable close price');
  }
  if (!isFiniteNumber(value.book_timestamp) || !isFiniteNumber(value.expires_at) || !isFiniteNumber(value.issued_at)) {
    return fail('invalid timestamps');
  }
  const bookDepth = value.book_depth;
  if (!isFiniteNumber(bookDepth) || bookDepth < 1) return fail('invalid book depth');
  if (typeof value.price_source !== 'string' || !EXIT_PRICE_SOURCES.has(value.price_source)) return fail('invalid price source');
  if (!isNonEmptyString(value.reason)) return fail('missing reason');
  if (!isBrainRole(value.issued_by)) return fail('invalid brain role');
  if (!canPublish(value.issued_by)) return fail('forbidden role');
  const issuedAt = value.issued_at;
  const bookTimestamp = value.book_timestamp;
  const expiresAt = value.expires_at;
  const now = options.now ?? Date.now();
  if (expiresAt < now) return fail('expired exit packet');
  if (bookTimestamp > now + 1_000 || issuedAt > now + 1_000) return fail('invalid timestamps');
  const maxBookAge = options.maxExitBookAgeMs ?? DEFAULT_MAX_EXIT_BOOK_AGE_MS;
  if (now - bookTimestamp > maxBookAge) return fail('stale exit book');
  return { ok: true, value: value as unknown as ExitRecommendation };
}


export function validateNemesisCloseResult(value: unknown): ValidationResult<NemesisCloseResult> {
  if (!isRecord(value)) return fail('invalid schema');
  if (!isNonEmptyString(value.ticker)) return fail('missing ticker');
  if (!['trim', 'close'].includes(String(value.action))) return fail('invalid action');
  for (const field of ['contracts', 'pnl', 'peak_pnl_usd', 'close_regret_usd', 'closed_at']) {
    if (!isFiniteNumber(value[field])) return fail(`invalid ${field}`);
  }
  if ((value.contracts as number) < 1) return fail('invalid contracts');
  if (typeof value.was_profit !== 'boolean') return fail('invalid was_profit');
  if (!isNonEmptyString(value.reason)) return fail('missing reason');
  if (!['scalp', 'core', 'runner'].includes(String(value.tier))) return fail('invalid tier');
  return { ok: true, value: value as unknown as NemesisCloseResult };
}
export function validateBridgeMessage(
  value: unknown,
  options: ValidationOptions = {},
): ValidationResult<NemesisBridgeMessage> {
  if (!isRecord(value)) return fail('invalid envelope');
  if (typeof value.type !== 'string' || !MESSAGE_TYPES.has(value.type as NemesisBridgeMessageType)) {
    return fail('invalid message type');
  }
  if (!isFiniteNumber(value.seq)) return fail('invalid sequence');
  const message = value as unknown as NemesisBridgeMessage;
  if (message.type === 'brain:recommendation') {
    const result = validateRecommendationPacket(message.payload, options);
    if (!result.ok) return result;
  }
  if (message.type === 'brain:no-trade') {
    const result = validateNoTradeWarning(message.payload);
    if (!result.ok) return result;
  }
  if (message.type === 'brain:exit') {
    const result = validateExitRecommendation(message.payload, options);
    if (!result.ok) return result;
  }
  if (message.type === 'nemesis:close-result') {
    const result = validateNemesisCloseResult(message.payload);
    if (!result.ok) return result;
  }
  return { ok: true, value: message };
}
