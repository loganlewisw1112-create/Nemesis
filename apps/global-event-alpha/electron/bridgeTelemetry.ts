import type { BridgeStatus, NemesisBridgeMessage } from '@nemesis/bridge-contracts';

export const BRIDGE_HEARTBEAT_MS = 5_000;
export const BRIDGE_TRAFFIC_TTL_MS = 15_000;

export function refreshBridgeTrafficStatus(
  status: BridgeStatus,
  socketConnected: boolean,
  now = Date.now(),
): BridgeStatus {
  const lastInboundAt = status.lastInboundAt ?? 0;
  const lastOutboundAt = status.lastOutboundAt ?? 0;
  const trafficFreshnessMs = Math.max(
    lastInboundAt > 0 ? now - lastInboundAt : Number.POSITIVE_INFINITY,
    lastOutboundAt > 0 ? now - lastOutboundAt : Number.POSITIVE_INFINITY,
  );
  const connected = socketConnected
    && lastInboundAt > 0
    && lastOutboundAt > 0
    && trafficFreshnessMs <= BRIDGE_TRAFFIC_TTL_MS;
  return {
    ...status,
    socketConnected,
    connected,
    qualificationReady: connected,
    trafficFreshnessMs: Number.isFinite(trafficFreshnessMs) ? Math.max(0, trafficFreshnessMs) : null,
  };
}

export function recordBridgeOutbound(
  status: BridgeStatus,
  message: NemesisBridgeMessage,
  now = Date.now(),
): BridgeStatus {
  return {
    ...status,
    lastOutboundAt: now,
    lastSequenceOut: message.seq,
    lastPingAt: message.type === 'bridge:ping' ? now : status.lastPingAt ?? null,
    pingCount: (status.pingCount ?? 0) + (message.type === 'bridge:ping' ? 1 : 0),
  };
}

export function recordBridgeInbound(
  status: BridgeStatus,
  message: NemesisBridgeMessage,
  now = Date.now(),
): { status: BridgeStatus; accepted: boolean } {
  const previous = status.lastSequenceIn;
  if (previous !== null && message.seq <= previous) {
    return {
      status: {
        ...status,
        sequenceGaps: (status.sequenceGaps ?? 0) + 1,
        qualificationReady: false,
        connected: false,
      },
      accepted: false,
    };
  }
  const sequenceGap = previous !== null && message.seq !== previous + 1;
  const roundTripMs = message.type === 'bridge:pong' && status.lastPingAt != null
    ? Math.max(0, now - status.lastPingAt)
    : status.roundTripMs ?? null;
  return {
    status: {
      ...status,
      lastSeenAt: now,
      lastInboundAt: now,
      lastSequenceIn: message.seq,
      lastPongAt: message.type === 'bridge:pong' ? now : status.lastPongAt,
      pongCount: (status.pongCount ?? 0) + (message.type === 'bridge:pong' ? 1 : 0),
      roundTripMs,
      sequenceGaps: (status.sequenceGaps ?? 0) + (sequenceGap ? 1 : 0),
      peerRole: message.type === 'bridge:hello'
        ? (message.payload as { role?: 'nemesis' | 'gea' }).role ?? status.peerRole ?? null
        : status.peerRole ?? null,
    },
    accepted: true,
  };
}
