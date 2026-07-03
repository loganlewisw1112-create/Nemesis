import { describe, expect, it } from 'vitest';
import { resolveNemesisBridgeUrl } from './bridgeClient.js';

describe('GEA bridge client URL', () => {
  it('defaults to loopback and appends the bridge token', () => {
    expect(resolveNemesisBridgeUrl({ NEMESIS_BRIDGE_TOKEN: 'secret token' }))
      .toBe('ws://127.0.0.1:7430/?token=secret+token');
  });

  it('preserves explicit bridge URLs while adding the token', () => {
    expect(resolveNemesisBridgeUrl({
      NEMESIS_BRIDGE_URL: 'ws://127.0.0.1:19001/bridge?client=gea',
      NEMESIS_BRIDGE_TOKEN: 'abc123',
    })).toBe('ws://127.0.0.1:19001/bridge?client=gea&token=abc123');
  });
});
