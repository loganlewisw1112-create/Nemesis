import { describe, expect, it } from 'vitest';
import {
  AlphaScorer,
  HealthSupervisor,
  PacketValidator,
  type BrainInstance,
  type BrainOutputDraft,
} from './index.js';

function instance(role: BrainInstance['role'], now = 1_000): BrainInstance {
  return {
    id: `brain-${role}`,
    role,
    status: role === 'primary' ? 'HEALTHY' : 'STANDBY_READY',
    model_version: 'alpha-v1',
    started_at: now,
    last_heartbeat: now,
    missed_heartbeats: 0,
    packet_rate: 0,
    error_rate: 0,
    latency_ms: 0,
  };
}

describe('brain-core', () => {
  it('promotes standby A after primary misses three heartbeats', () => {
    const supervisor = new HealthSupervisor([
      instance('primary'),
      instance('standby-a'),
      instance('standby-b'),
      instance('standby-c'),
      instance('emergency'),
    ], { heartbeatTimeoutMs: 5_000, maxMissedHeartbeats: 3 });

    const snapshot = supervisor.checkHealth(16_001);

    expect(snapshot.activeRole).toBe('standby-a');
    expect(snapshot.instances.find((b) => b.role === 'primary')?.status).toBe('STALE');
    expect(snapshot.instances.find((b) => b.role === 'standby-a')?.status).toBe('PROMOTED');
    expect(snapshot.failoverEvents[0]).toMatchObject({
      from_role: 'primary',
      to_role: 'standby-a',
      reason: 'primary missed 3 heartbeats',
    });
  });

  it('falls back to emergency when standbys are unavailable', () => {
    const stale = instance('primary');
    const standbyA = { ...instance('standby-a'), status: 'OFFLINE' as const };
    const standbyB = { ...instance('standby-b'), status: 'QUARANTINED' as const };
    const standbyC = { ...instance('standby-c'), status: 'UNSAFE' as const };
    const supervisor = new HealthSupervisor([stale, standbyA, standbyB, standbyC, instance('emergency')]);

    expect(supervisor.checkHealth(20_000).activeRole).toBe('emergency');
  });

  it('records heartbeats and clears miss counts', () => {
    const supervisor = new HealthSupervisor([instance('primary')]);
    supervisor.checkHealth(20_000);
    supervisor.recordHeartbeat('brain-primary', 21_000, { latency_ms: 42, packet_rate: 2 });

    const primary = supervisor.snapshot().instances[0];
    expect(primary.last_heartbeat).toBe(21_000);
    expect(primary.missed_heartbeats).toBe(0);
    expect(primary.latency_ms).toBe(42);
    expect(primary.packet_rate).toBe(2);
  });

  it('scores alpha candidates deterministically', () => {
    const score = AlphaScorer.score({
      raw_edge: 0.12,
      net_edge: 0.08,
      confidence: 0.72,
      liquidity: 0.75,
      settlement_clarity: 0.9,
      freshness: 0.85,
      volatility_penalty: 0.1,
    });

    expect(score.alpha_score).toBeGreaterThanOrEqual(80);
    expect(score.classification).toBe('elite');
  });

  it('validates brain outputs before bridge publication', () => {
    const draft: BrainOutputDraft = {
      id: 'draft-1',
      brain_role: 'primary',
      model_version: 'alpha-v1',
      ticker: 'KXTEST-26',
      classification: 'strong',
      alpha_score: 83,
      nemesis_probability: 0.58,
      confidence_band_low: 0.52,
      confidence_band_high: 0.64,
      net_ev: 0.04,
      raw_edge: 0.09,
      entry_zone_low: 0.41,
      entry_zone_high: 0.47,
      do_not_chase_level: 0.52,
      target_exit: 0.62,
      settlement_clarity_score: 0.72,
      hold_class: 'intraday',
      ttl_ms: 30_000,
    };

    const valid = PacketValidator.toRecommendationPacket(draft, { now: 10_000 });
    const invalid = PacketValidator.toRecommendationPacket({ ...draft, brain_role: 'shadow' }, { now: 10_000 });

    expect(valid.ok).toBe(true);
    expect(valid.packet?.expires_at).toBe(40_000);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toBe('forbidden role');
  });
});
