import { describe, expect, it } from 'vitest';
import {
  appendBridgeTokenToUrl,
  createBridgeAuth,
  isBridgeRequestAuthenticated,
  resolveBridgeHost,
} from './bridgeSecurity.js';

describe('NEMESIS bridge security', () => {
  it('binds to loopback by default', () => {
    expect(resolveBridgeHost({})).toBe('127.0.0.1');
  });

  it('rejects non-loopback hosts unless explicitly allowed', () => {
    expect(() => resolveBridgeHost({ NEMESIS_BRIDGE_HOST: '0.0.0.0' })).toThrow(/non-loopback/i);
    expect(resolveBridgeHost({
      NEMESIS_BRIDGE_HOST: '0.0.0.0',
      NEMESIS_ALLOW_REMOTE_BRIDGE: 'true',
    })).toBe('0.0.0.0');
  });

  it('uses an operator token when provided and otherwise creates an ephemeral token', () => {
    expect(createBridgeAuth({ NEMESIS_BRIDGE_TOKEN: 'operator-secret' })).toEqual({
      token: 'operator-secret',
      ephemeral: false,
    });

    const generated = createBridgeAuth({}, () => Buffer.from('0123456789abcdef0123456789abcdef'));

    expect(generated).toEqual({
      token: '3031323334353637383961626364656630313233343536373839616263646566',
      ephemeral: true,
    });
  });

  it('requires the token before a client can receive bridge messages', () => {
    const secured = appendBridgeTokenToUrl('ws://127.0.0.1:7430', 'secret token');

    expect(secured).toBe('ws://127.0.0.1:7430/?token=secret+token');
    expect(isBridgeRequestAuthenticated('/?token=secret+token', 'secret token')).toBe(true);
    expect(isBridgeRequestAuthenticated('/', 'secret token')).toBe(false);
    expect(isBridgeRequestAuthenticated('/?token=wrong', 'secret token')).toBe(false);
  });
});
