import { describe, expect, it } from 'vitest';
import type { BridgeStatus, NemesisBridgeMessage } from '@nemesis/bridge-contracts';
import { recordBridgeInbound, recordBridgeOutbound, refreshBridgeTrafficStatus } from './bridgeTelemetry.js';

function status(): BridgeStatus {
  return {
    connected: false,
    brainRole: null,
    lastSeenAt: null,
    clientCount: 0,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastPongAt: null,
    lastSequenceIn: null,
    lastSequenceOut: null,
    reconnects: 0,
    disconnects: 0,
    failovers: 0,
    tapeFreshnessMs: null,
  };
}

describe('GEA bridge telemetry', () => {
  it('requires recent bidirectional traffic rather than an open socket alone', () => {
    expect(refreshBridgeTrafficStatus(status(), true, 20_000).connected).toBe(false);
    const ping: NemesisBridgeMessage = { type: 'bridge:ping', payload: {}, seq: 1 };
    const outbound = recordBridgeOutbound(status(), ping, 10_000);
    const inbound = recordBridgeInbound(outbound, { type: 'bridge:pong', payload: {}, seq: 1 }, 10_025).status;
    expect(refreshBridgeTrafficStatus(inbound, true, 20_000)).toMatchObject({
      connected: true,
      qualificationReady: true,
      roundTripMs: 25,
      pingCount: 1,
      pongCount: 1,
    });
    expect(refreshBridgeTrafficStatus(inbound, true, 30_001).connected).toBe(false);
  });

  it('rejects replayed sequences and records gaps', () => {
    const first = recordBridgeInbound(status(), { type: 'bridge:pong', payload: {}, seq: 5 }, 1_000);
    const replay = recordBridgeInbound(first.status, { type: 'bridge:pong', payload: {}, seq: 5 }, 1_001);
    expect(replay).toMatchObject({ accepted: false, status: { sequenceGaps: 1, connected: false } });
  });
});
